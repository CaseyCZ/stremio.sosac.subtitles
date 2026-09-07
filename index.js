const express = require('express');
const https = require('https');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 7000;

const SOSAC_API_DOMAIN = 'kodi-api.sosac.to';

const manifest = {
    id: 'org.stremio.sosac.streamuj.subtitles.public',
    version: '2.0.0',
    name: 'Sosáč + Streamuj CZ Titulky',
    description: 'Komunitní doplněk pro české titulky ze Sosáč / Streamuj.tv',
    types: ['movie', 'series'],
    idPrefixes: ['tt', 'sosac', 'sosac2', 'tmdb'],
    resources: ['subtitles'],
    catalogs: [],
    behaviorHints: {
        configurable: true,
        configurationRequired: true
    }
};

// Pomocná HTTPS funkce předávající dynamické cookies
function httpsGet(url, username, passMd5, customHeaders = {}) {
    return new Promise((resolve, reject) => {
        const options = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept': 'application/json, text/plain, */*',
                'Referer': 'https://www.streamuj.tv/',
                'Cookie': `pass=${username}%3A%3A%3A${passMd5}`,
                ...customHeaders
            },
            rejectUnauthorized: false,
            timeout: 15000
        };

        const req = https.get(url, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(data);
                } else {
                    reject(new Error(`HTTP Status ${res.statusCode}`));
                }
            });
        });

        req.on('error', err => reject(err));
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Timeout vypršel'));
        });
    });
}

// Získání detailu ze Sosáče
async function fetchSosacDetailPublic(type, id, username, passMd5) {
    try {
        const endpoint = type === 'movie' 
            ? `https://${SOSAC_API_DOMAIN}/movies/${id}` 
            : `https://${SOSAC_API_DOMAIN}/series/${id}`;
        
        const rawData = await httpsGet(endpoint, username, passMd5, { 'Referer': 'https://sosac.tv/', 'Origin': 'https://sosac.tv' });
        const data = JSON.parse(rawData);
        return data.item || data.movie || data.show || data;
    } catch (err) {
        console.error('[Sosac Public API] Chyba:', err.message);
        return null;
    }
}

// Extrakce titulků z HTML
function parseSubtitlesFromHtml(htmlText, authParam) {
    const subMatch = htmlText.match(/sub0:\s*"([^"]+)"/);
    if (!subMatch || !subMatch[1]) return [];

    const [langName, rawSubUrl] = subMatch[1].split('>');
    if (!rawSubUrl) return [];

    return [{
        id: "streamuj_sub_cs",
        url: rawSubUrl + authParam,
        lang: "cs",
        file_name: `Streamuj.tv - ${langName || 'čeština'}`
    }];
}

// Rozkódování uživatelské konfigurace z URL
function parseUserConfig(configStr) {
    if (!configStr || !configStr.includes(':')) return null;
    const [username, passMd5] = configStr.split(':');
    return { username, passMd5 };
}

// ==========================================
// ROUTY SERVERU
// ==========================================

// Webová konfigurační stránka (Landing Page)
app.get(['/', '/configure'], (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="cs">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Sosáč Titulky - Stremio Addon</title>
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 1rem; box-sizing: border-box; }
            .card { background: #1e293b; padding: 2rem; border-radius: 1rem; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5); width: 100%; max-width: 440px; }
            h1 { font-size: 1.5rem; font-weight: 700; margin-bottom: 0.5rem; color: #38bdf8; text-align: center; }
            p { font-size: 0.875rem; color: #94a3b8; text-align: center; margin-bottom: 1.5rem; }
            .field { margin-bottom: 1.25rem; }
            label { display: block; font-size: 0.875rem; margin-bottom: 0.5rem; color: #cbd5e1; }
            input { width: 100%; padding: 0.75rem; border-radius: 0.5rem; border: 1px solid #334155; background: #0f172a; color: white; box-sizing: border-box; }
            input:focus { border-color: #38bdf8; outline: none; }
            button, .btn { width: 100%; padding: 0.875rem; border-radius: 0.5rem; border: none; background: #0284c7; color: white; font-weight: 600; cursor: pointer; transition: background 0.2s; margin-top: 0.5rem; text-align: center; text-decoration: none; display: block; box-sizing: border-box; }
            button:hover, .btn:hover { background: #0369a1; }
            .btn-secondary { background: #334155; margin-top: 0.5rem; }
            .btn-secondary:hover { background: #475569; }
            #result { display: none; margin-top: 1.5rem; padding-top: 1.5rem; border-top: 1px solid #334155; }
            .url-box { margin-top: 1rem; }
            .success-msg { color: #4ade80; font-size: 0.8rem; text-align: center; margin-top: 0.5rem; display: none; }
        </style>
        <script src="https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.1.1/crypto-js.min.js"></script>
    </head>
    <body>
        <div class="card">
            <h1>Sosáč CZ Titulky</h1>
            <p>Zadejte své přihlašovací údaje ze Sosáč.tv pro generování instalačního odkazu.</p>
            <form id="configForm">
                <div class="field">
                    <label>Uživatelské jméno</label>
                    <input type="text" id="username" required placeholder="TvojeJmeno">
                </div>
                <div class="field">
                    <label>Heslo</label>
                    <input type="password" id="password" required placeholder="••••••••">
                </div>
                <button type="submit">Vygenerovat odkaz</button>
            </form>

            <div id="result">
                <a id="stremioBtn" href="#" class="btn">Otevřít v aplikaci Stremio</a>
                
                <div class="url-box">
                    <label style="margin-top:0.75rem;">Nebo zkopírujte HTTPS URL do vyhledávání ve Stremiu:</label>
                    <input type="text" id="httpsInput" readonly onclick="this.select()" style="margin-bottom:0.5rem;">
                    <button id="copyBtn" type="button" class="btn btn-secondary">Kopírovat HTTPS odkaz</button>
                    <div id="copySuccess" class="success-msg">✓ Odkaz byl zkopírován! Vložte jej do vyhledávání doplňků ve Stremiu.</div>
                </div>
            </div>
        </div>

        <script>
            let generatedHttpsUrl = '';

            document.getElementById('configForm').addEventListener('submit', function(e) {
                e.preventDefault();
                try {
                    const u = document.getElementById('username').value.trim();
                    const p = document.getElementById('password').value;
                    
                    if (typeof CryptoJS === 'undefined') {
                        alert('Chyba: Nepodařilo se načíst kryptografickou knihovnu. Zkontrolujte připojení.');
                        return;
                    }

                    const md5 = CryptoJS.MD5(p).toString();
                    const host = window.location.host;
                    
                    const stremioUrl = 'stremio://' + host + '/' + encodeURIComponent(u) + ':' + md5 + '/manifest.json';
                    generatedHttpsUrl = 'https://' + host + '/' + encodeURIComponent(u) + ':' + md5 + '/manifest.json';

                    document.getElementById('stremioBtn').href = stremioUrl;
                    document.getElementById('httpsInput').value = generatedHttpsUrl;
                    document.getElementById('result').style.display = 'block';

                    setTimeout(() => {
                        window.location.href = stremioUrl;
                    }, 150);
                } catch (err) {
                    alert('Chyba: ' + err.message);
                }
            });

            document.getElementById('copyBtn').addEventListener('click', function() {
                if (!generatedHttpsUrl) return;
                const input = document.getElementById('httpsInput');
                input.select();
                navigator.clipboard.writeText(generatedHttpsUrl).then(function() {
                    const msg = document.getElementById('copySuccess');
                    msg.style.display = 'block';
                    setTimeout(() => msg.style.display = 'none', 4000);
                }).catch(function() {
                    prompt('Zkopírujte si odkaz ručně:', generatedHttpsUrl);
                });
            });
        </script>
    </body>
    </html>
    `);
});

// Základní manifest
app.get('/manifest.json', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(manifest);
});

// Konfigurovaný manifest
app.get('/:config/manifest.json', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(manifest);
});

// Titulkový Handler
app.get('/:config/subtitles/:type/:id/:extra?.json', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    const creds = parseUserConfig(req.params.config);
    if (!creds) {
        return res.json({ subtitles: [] });
    }

    const { type, id } = req.params;
    let queryTitle = '';
    let streamujId = null;

    try {
        if (id.includes('sosac')) {
            const cleanId = id.replace(/^(sosac_m_|sosac2_)/, '').replace(/:(movies|series)$/, '');
            const sosacData = await fetchSosacDetailPublic(type, cleanId, creds.username, creds.passMd5);
            if (sosacData) {
                queryTitle = (sosacData.n && sosacData.n.cs && sosacData.n.cs[0]) || sosacData.title_cz || sosacData.title;
                streamujId = sosacData.l;
            }
        }

        const authParam = `&pass=${creds.username}:::${creds.passMd5}`;
        let subtitles = [];

        if (streamujId) {
            try {
                const htmlText = await httpsGet(`https://www.streamuj.tv/video/${streamujId}`, creds.username, creds.passMd5);
                subtitles = parseSubtitlesFromHtml(htmlText, authParam);
            } catch (e) {
                console.error('[Titulky] Chyba při stažení z Streamuj:', e.message);
            }
        }

        return res.json({ subtitles });
    } catch (e) {
        console.error('[Titulky] Handler chyba:', e.message);
        return res.json({ subtitles: [] });
    }
});

app.listen(PORT, () => {
    console.log(`Addon běží na portu ${PORT}`);
});
