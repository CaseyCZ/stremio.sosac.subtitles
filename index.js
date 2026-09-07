const express = require('express');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 7000;

const SOSAC_API_DOMAIN = 'kodi-api.sosac.to';

const manifest = {
    id: 'org.stremio.sosac.streamuj.subtitles.public',
    version: '2.8.0',
    name: 'Sosáč + Streamuj CZ Titulky',
    description: 'Komunitní doplněk pro české titulky ze Sosáč / Streamuj.tv',
    types: ['movie', 'series'],
    idPrefixes: ['sosac', 'sosac2', 'tt'],
    resources: ['subtitles'],
    catalogs: []
};

function httpsGet(url, username, passMd5, customHeaders = {}) {
    return new Promise((resolve, reject) => {
        const options = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Referer': 'https://www.streamuj.tv/',
                'Cookie': `pass=${username}%3A%3A%3A${passMd5}; sublanguage=1; quality=1; videolanguage=cs`,
                ...customHeaders
            },
            rejectUnauthorized: false,
            timeout: 15000
        };

        const req = https.get(url, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 400) {
                    resolve(data);
                } else {
                    reject(new Error(`HTTP Status ${res.statusCode} na adrese ${url}`));
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

function extractAllStreamujIds(ep) {
    const ids = new Set();
    const directSubs = new Set();

    const parseString = (str) => {
        if (!str || typeof str !== 'string') return;
        
        if (str.includes('streamuj=subtitles') || str.includes('.vtt') || str.includes('.srt')) {
            directSubs.add(str);
        }

        let mVid = str.match(/(?:video|vid)\/([a-zA-Z0-9]{10,35})/);
        if (mVid) ids.add(mVid[1]);

        let mMp4 = str.match(/\/([a-zA-Z0-9]{15,30})(?:_sd|_hd|_720p|_1080p|_480p)?\.mp4/i);
        if (mMp4) ids.add(mMp4[1]);

        let mId = str.match(/([0-9]+[a-z0-9]{10,30})/i);
        if (mId && !str.endsWith('.mp4')) {
            ids.add(mId[1]);
        }

        if (/^[a-zA-Z0-9]{15,30}$/.test(str)) {
            ids.add(str);
        }
    };

    const recursiveSearch = (obj) => {
        if (!obj) return;
        if (typeof obj === 'string') {
            parseString(obj);
        } else if (Array.isArray(obj)) {
            obj.forEach(item => recursiveSearch(item));
        } else if (typeof obj === 'object') {
            Object.values(obj).forEach(val => recursiveSearch(val));
        }
    };

    recursiveSearch(ep);
    return { ids: Array.from(ids), directSubs: Array.from(directSubs) };
}

async function fetchSubtitlesFromStreamuj(videoId, username, passMd5, reqHost) {
    const subtitles = [];
    try {
        const remoteUrl = `https://www.streamuj.tv/video/${videoId}?remote=1`;
        const html = await httpsGet(remoteUrl, username, passMd5);
        
        if (!html) return subtitles;

        const subMatch = html.match(/sub0\s*:\s*"([^"]+)"/i);
        if (subMatch && subMatch[1]) {
            const val = subMatch[1];
            const parts = val.split('>');
            if (parts.length >= 2) {
                const subLang = parts[0].trim();
                let rawSubUrl = parts[1].trim();
                
                if (!rawSubUrl.startsWith('http')) {
                    rawSubUrl = rawSubUrl.startsWith('/') ? `https://www.streamuj.tv${rawSubUrl}` : `https://www.streamuj.tv/${rawSubUrl}`;
                }
                
                const proxyUrl = `https://${reqHost}/sub-proxy?url=${encodeURIComponent(rawSubUrl)}&u=${encodeURIComponent(username)}&p=${encodeURIComponent(passMd5)}`;

                subtitles.push({
                    id: `streamuj_${videoId}`,
                    url: proxyUrl,
                    lang: 'cs',
                    file_name: `Streamuj.tv - ${subLang}`
                });
            }
        }
    } catch (e) {
        console.error(`Chyba při stahování titulků pro Streamuj ID ${videoId}:`, e.message);
    }
    return subtitles;
}

function parseUserConfig(configStr) {
    if (!configStr || !configStr.includes(':')) return null;
    const [username, passMd5] = configStr.split(':');
    return { username, passMd5 };
}

app.get('/sub-proxy', async (req, res) => {
    const { url, u, p } = req.query;
    if (!url || !u || !p) return res.status(400).send('Chybí parametry.');

    try {
        const subData = await httpsGet(decodeURIComponent(url), u, p);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
        return res.send(subData);
    } catch (e) {
        return res.status(500).send('Chyba při stahování titulků.');
    }
});

app.get('/:config/configure', (req, res) => res.redirect('/'));

app.get(['/', '/configure'], (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="cs">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Sosáč Titulky - Stremio Addon</title>
        <style>
            body { font-family: system-ui, sans-serif; background: #0f172a; color: #f8fafc; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 1rem; box-sizing: border-box; }
            .card { background: #1e293b; padding: 2rem; border-radius: 1rem; width: 100%; max-width: 440px; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5); }
            h1 { font-size: 1.5rem; font-weight: 700; color: #38bdf8; text-align: center; margin-bottom: 0.5rem; }
            p { font-size: 0.875rem; color: #94a3b8; text-align: center; margin-bottom: 1.5rem; }
            .field { margin-bottom: 1.25rem; }
            label { display: block; font-size: 0.875rem; margin-bottom: 0.5rem; color: #cbd5e1; }
            input { width: 100%; padding: 0.75rem; border-radius: 0.5rem; border: 1px solid #334155; background: #0f172a; color: white; box-sizing: border-box; }
            button, .btn { width: 100%; padding: 0.875rem; border-radius: 0.5rem; border: none; background: #0284c7; color: white; font-weight: 600; cursor: pointer; text-align: center; text-decoration: none; display: block; box-sizing: border-box; }
            button:hover, .btn:hover { background: #0369a1; }
            #result { display: none; margin-top: 1.5rem; padding-top: 1.5rem; border-top: 1px solid #334155; }
        </style>
        <script src="https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.1.1/crypto-js.min.js"></script>
    </head>
    <body>
        <div class="card">
            <h1>Sosáč CZ Titulky</h1>
            <p>Zadejte své přihlašovací údaje ze Sosáč.tv pro generování doplňku.</p>
            <form id="configForm">
                <div class="field">
                    <label for="username">Uživatelské jméno</label>
                    <input type="text" id="username" required placeholder="TvojeJmeno">
                </div>
                <div class="field">
                    <label for="password">Heslo</label>
                    <input type="password" id="password" required placeholder="••••••••">
                </div>
                <button type="submit">Vygenerovat instalační odkaz</button>
            </form>

            <div id="result">
                <a id="stremioBtn" href="#" class="btn">Instalovat do Stremio</a>
            </div>
        </div>

        <script>
            document.getElementById('configForm').addEventListener('submit', function(e) {
                e.preventDefault();
                const u = document.getElementById('username').value.trim();
                const p = document.getElementById('password').value;
                const md5 = CryptoJS.MD5(p).toString();
                const host = window.location.host;
                const stremioUrl = 'stremio://' + host + '/' + encodeURIComponent(u) + ':' + md5 + '/manifest.json';
                document.getElementById('stremioBtn').href = stremioUrl;
                document.getElementById('result').style.display = 'block';
                window.location.href = stremioUrl;
            });
        </script>
    </body>
    </html>
    `);
});

app.get('/manifest.json', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json({ ...manifest, behaviorHints: { configurable: true, configurationRequired: true } });
});

app.get('/:config/manifest.json', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json({ ...manifest, behaviorHints: { configurable: true, configurationRequired: false } });
});

app.get('/:config/subtitles/:type/:id/:extra?.json', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    const creds = parseUserConfig(req.params.config);
    if (!creds) return res.json({ subtitles: [] });

    let streamujId = null;
    const fullQueryString = req.url;

    // 1. Zkusíme vytáhnout Streamuj ID přímo z URL přehrávaného videa (např. .../69ads04210a8ec621219_sd.mp4)
    const directIdMatch = fullQueryString.match(/\/([a-zA-Z0-9]{15,30})_(?:sd|hd|720p|1080p|480p)\.mp4/i) || 
                          fullQueryString.match(/(?:video|vid)\/([a-zA-Z0-9]{10,35})/);

    if (directIdMatch && directIdMatch[1]) {
        streamujId = directIdMatch[1];
    }

    let subtitles = [];

    try {
        if (streamujId) {
            // Rychlá cesta: ID máme přímo z přehrávaného streamu
            subtitles = await fetchSubtitlesFromStreamuj(streamujId, creds.username, creds.passMd5, req.headers.host);
        } else {
            // Fallback cesta přes Sosáč API podle ID z katalogu
            const { type, id } = req.params;
            const idParts = id.split(':');
            const cleanId = idParts[0].replace(/^(sosac_m_|sosac2_|sosac_|tt)/, '');
            const season = idParts[1] ? parseInt(idParts[1], 10) : null;
            const episode = idParts[2] ? parseInt(idParts[2], 10) : null;

            let targetData = null;

            if (type === 'series') {
                if (season !== null && episode !== null) {
                    try {
                        const epUrl = `https://${SOSAC_API_DOMAIN}/episodes/${cleanId}`;
                        const rawEp = await httpsGet(epUrl, creds.username, creds.passMd5);
                        if (!rawEp.trim().startsWith('<')) {
                            const parsedEp = JSON.parse(rawEp);
                            const epObj = parsedEp.item || parsedEp.episode || parsedEp;
                            if (epObj && (epObj.season === season || epObj.s === season) && (epObj.episode === episode || epObj.e === episode)) {
                                targetData = epObj;
                            }
                        }
                    } catch (e) {}
                }

                if (!targetData) {
                    try {
                        const seriesUrl = `https://${SOSAC_API_DOMAIN}/series/${cleanId}/episodes`;
                        const rawList = await httpsGet(seriesUrl, creds.username, creds.passMd5);
                        if (!rawList.trim().startsWith('<')) {
                            const epData = JSON.parse(rawList);
                            const list = Array.isArray(epData) ? epData : (epData.items || epData.episodes || []);
                            const targetEp = list.find(ep => 
                                (ep.season === season || ep.s === season || ep.number === season) && 
                                (ep.episode === episode || ep.e === episode || ep.ep === episode)
                            );
                            if (targetEp) targetData = targetEp;
                        }
                    } catch (e) {}
                }
            } else if (type === 'movie') {
                const endpoint = `https://${SOSAC_API_DOMAIN}/movies/${cleanId}`;
                const rawData = await httpsGet(endpoint, creds.username, creds.passMd5, { 
                    'Referer': 'https://sosac.tv/', 'Origin': 'https://sosac.tv', 'Accept': 'application/json' 
                });
                if (!rawData.trim().startsWith('<')) {
                    const data = JSON.parse(rawData);
                    targetData = data.item || data.movie || data;
                }
            }

            if (targetData) {
                const extracted = extractAllStreamujIds(targetData);
                if (extracted.ids.length > 0) {
                    subtitles = await fetchSubtitlesFromStreamuj(extracted.ids[0], creds.username, creds.passMd5, req.headers.host);
                }
            }
        }

        // Deduplikace výsledků
        const uniqueSubtitles = [];
        const seenUrls = new Set();
        subtitles.forEach(sub => {
            if (!seenUrls.has(sub.url)) {
                seenUrls.add(sub.url);
                uniqueSubtitles.push(sub);
            }
        });

        return res.json({ subtitles: uniqueSubtitles });
    } catch (e) {
        console.error('[Handler Error]:', e.message);
        return res.json({ subtitles: [] });
    }
});

app.listen(PORT, () => {
    console.log(`Addon běží na portu ${PORT}`);
});
