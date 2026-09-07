const express = require('express');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 7000;

const SOSAC_API_DOMAIN = 'kodi-api.sosac.to';

const manifest = {
    id: 'org.stremio.sosac.streamuj.subtitles.public',
    version: '2.6.6',
    name: 'Sosáč + Streamuj CZ Titulky',
    description: 'Komunitní doplněk pro české titulky ze Sosáč / Streamuj.tv',
    types: ['movie', 'series'],
    idPrefixes: ['tt', 'sosac', 'sosac2', 'tmdb'],
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

async function resolveSosacSeriesId(imdbId, username, passMd5) {
    if (!imdbId.startsWith('tt')) return imdbId;
    try {
        const cinemetaRes = await new Promise((resolve, reject) => {
            https.get(`https://v3-cinemeta.strem.io/meta/series/${imdbId}.json`, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve(data));
            }).on('error', reject);
        });
        const metaJson = JSON.parse(cinemetaRes);
        const title = metaJson.meta?.name;
        if (!title) return imdbId;

        const searchUrl = `https://${SOSAC_API_DOMAIN}/search?q=${encodeURIComponent(title)}`;
        const searchRaw = await httpsGet(searchUrl, username, passMd5);
        if (!searchRaw.trim().startsWith('<')) {
            const searchData = JSON.parse(searchRaw);
            const items = Array.isArray(searchData) ? searchData : (searchData.items || searchData.results || []);
            const found = items.find(item => item.type === 'series' || item.seasons || item.episodes);
            if (found && (found.id || found.slug)) {
                return found.id || found.slug;
            }
            if (items.length > 0 && (items[0].id || items[0].slug)) {
                return items[0].id || items[0].slug;
            }
        }
    } catch (e) {
        console.log('[Resolve Error]:', e.message);
    }
    return imdbId;
}

function extractAllStreamujIds(ep) {
    const ids = new Set();
    const directSubs = new Set();
    const mp4Urls = new Set();

    const parseString = (str) => {
        if (!str || typeof str !== 'string') return;
        
        if (str.includes('streamuj=subtitles') || str.includes('.vtt') || str.includes('.srt')) {
            directSubs.add(str);
        }

        if (str.includes('.mp4')) {
            mp4Urls.add(str);
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
    return { ids: Array.from(ids), directSubs: Array.from(directSubs), mp4Urls: Array.from(mp4Urls) };
}

async function fetchSubtitlesFromStreamuj(streamujId, username, passMd5, reqHost) {
    const subtitles = [];
    const addedUrls = new Set();

    const addSub = (rawUrl, label = 'Čeština') => {
        if (!rawUrl) return;
        let cleanUrl = rawUrl.trim().replace(/^["']|["']$/g, '');
        if (!cleanUrl.startsWith('http')) {
            cleanUrl = cleanUrl.startsWith('/') ? `https://www.streamuj.tv${cleanUrl}` : `https://www.streamuj.tv/${cleanUrl}`;
        }
        
        if (!addedUrls.has(cleanUrl)) {
            addedUrls.add(cleanUrl);
            
            const langLower = label.toLowerCase();
            let langCode = 'cs';
            if (langLower.includes('sk') || langLower.includes('slovensk')) langCode = 'sk';
            if (langLower.includes('en') || langLower.includes('anglick')) langCode = 'en';

            const proxyUrl = `https://${reqHost}/sub-proxy?url=${encodeURIComponent(cleanUrl)}&u=${encodeURIComponent(username)}&p=${encodeURIComponent(passMd5)}`;

            subtitles.push({
                id: `streamuj_${streamujId}_sub_${subtitles.length}`,
                url: proxyUrl,
                lang: langCode,
                file_name: `Streamuj.tv - ${label}`
            });
        }
    };

    try {
        const playerUrl = streamujId.startsWith('http') ? streamujId : `https://www.streamuj.tv/video/${streamujId}`;
        const htmlText = await httpsGet(playerUrl, username, passMd5);

        const subRegex = /sub\d+\s*:\s*["']([^"']+)["']/gi;
        let match;
        while ((match = subRegex.exec(htmlText)) !== null) {
            const val = match[1];
            if (val.includes('>')) {
                const [label, subUrl] = val.split('>');
                addSub(subUrl, label);
            } else if (val.startsWith('http') || val.startsWith('/')) {
                addSub(val, 'Čeština');
            }
        }

        const generalSubRegex = /(?:src|href|url)\s*[:=]\s*["']([^"']+\.(?:srt|vtt)|[^"']*sub[^"']*)["']/gi;
        while ((match = generalSubRegex.exec(htmlText)) !== null) {
            const foundUrl = match[1];
            if (!foundUrl.includes('.js') && !foundUrl.includes('.css') && !foundUrl.includes('.png') && !foundUrl.includes('.jpg')) {
                addSub(foundUrl, 'Čeština (Auto)');
            }
        }

        if (subtitles.length === 0) {
            const fallbackRegex = /(https?:\/\/[^"'\s]+\?streamuj=subtitles[^"'\s]*)/gi;
            while ((match = fallbackRegex.exec(htmlText)) !== null) {
                addSub(match[1], 'Čeština');
            }
        }

    } catch (err) {
        console.log(`[Bez titulků] ID: ${streamujId}`);
    }

    return subtitles;
}

async function fetchSubtitlesFromMp4Url(mp4Url, username, passMd5, reqHost) {
    const subtitles = [];
    try {
        const cleanVideoUrl = mp4Url.split('?')[0];
        const lastSlash = cleanVideoUrl.lastIndexOf('/');
        const dirUrl = cleanVideoUrl.substring(0, lastSlash + 1);
        const filenameWithExt = cleanVideoUrl.substring(lastSlash + 1);
        const baseName = filenameWithExt.replace(/(_sd|_hd|_720p|_1080p|_480p)?\.mp4/i, '');

        const candidateSubUrls = [
            `${dirUrl}${baseName}_cs.srt`,
            `${dirUrl}${baseName}_cz.srt`,
            `${dirUrl}${baseName}.srt`,
            `${dirUrl}${baseName}_cs.vtt`,
            `${dirUrl}${baseName}.vtt`
        ];

        for (const subCandidate of candidateSubUrls) {
            try {
                const authQuery = mp4Url.includes('?') ? '?' + mp4Url.split('?')[1] : '';
                const testUrl = subCandidate + authQuery;
                const subData = await httpsGet(testUrl, username, passMd5);
                if (subData && !subData.trim().startsWith('<') && (subData.includes('-->') || subData.length > 20)) {
                    const proxyUrl = `https://${reqHost}/sub-proxy?url=${encodeURIComponent(testUrl)}&u=${encodeURIComponent(username)}&p=${encodeURIComponent(passMd5)}`;
                    subtitles.push({
                        id: `streamuj_cdn_sub_${subtitles.length}`,
                        url: proxyUrl,
                        lang: 'cs',
                        file_name: `Streamuj.tv - Čeština (CDN)`
                    });
                    break;
                }
            } catch (e) {}
        }
    } catch (e) {}
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

    const { type, id } = req.params;
    let targetData = null;

    try {
        const idParts = id.split(':');
        const cleanId = idParts[0].replace(/^(sosac_m_|sosac2_|sosac_)/, '');
        const season = idParts[1] ? parseInt(idParts[1], 10) : null;
        const episode = idParts[2] ? parseInt(idParts[2], 10) : null;

        if (type === 'movie') {
            const endpoint = `https://${SOSAC_API_DOMAIN}/movies/${cleanId}`;
            const rawData = await httpsGet(endpoint, creds.username, creds.passMd5, { 
                'Referer': 'https://sosac.tv/', 'Origin': 'https://sosac.tv', 'Accept': 'application/json' 
            });
            if (!rawData.trim().startsWith('<')) {
                const data = JSON.parse(rawData);
                targetData = data.item || data.movie || data;
            }
        } else if (type === 'series') {
            let epFound = false;
            let resolvedId = cleanId;

            if (resolvedId.startsWith('tt')) {
                resolvedId = await resolveSosacSeriesId(resolvedId, creds.username, creds.passMd5);
            }

            if (season !== null && episode !== null) {
                try {
                    const epUrl = `https://${SOSAC_API_DOMAIN}/episodes/${resolvedId}`;
                    const rawEp = await httpsGet(epUrl, creds.username, creds.passMd5);
                    if (!rawEp.trim().startsWith('<')) {
                        const parsedEp = JSON.parse(rawEp);
                        const epObj = parsedEp.item || parsedEp.episode || parsedEp;
                        if (epObj && (epObj.season === season || epObj.s === season) && (epObj.episode === episode || epObj.e === episode)) {
                            targetData = epObj;
                            epFound = true;
                        }
                    }
                } catch (e) {}
            }

            if (!epFound) {
                try {
                    const seriesUrl = `https://${SOSAC_API_DOMAIN}/series/${resolvedId}/episodes`;
                    const rawList = await httpsGet(seriesUrl, creds.username, creds.passMd5);
                    if (!rawList.trim().startsWith('<')) {
                        const epData = JSON.parse(rawList);
                        const list = Array.isArray(epData) ? epData : (epData.items || epData.episodes || []);
                        const targetEp = list.find(ep => 
                            (ep.season === season || ep.s === season || ep.number === season) && 
                            (ep.episode === episode || ep.e === episode || ep.ep === episode)
                        );
                        if (targetEp) {
                            targetData = targetEp;
                        }
                    }
                } catch (e) {}
            }
        }

        let subtitles = [];
        if (targetData) {
            const extracted = extractAllStreamujIds(targetData);

            // 1. Zpracování přímých odkazů na titulky
            for (const rawSubUrl of extracted.directSubs) {
                let cleanSubUrl = rawSubUrl.trim();
                if (!cleanSubUrl.startsWith('http')) {
                    cleanSubUrl = cleanSubUrl.startsWith('/') ? `https://www.streamuj.tv${cleanSubUrl}` : `https://www.streamuj.tv/${cleanSubUrl}`;
                }
                const proxyUrl = `https://${req.headers.host}/sub-proxy?url=${encodeURIComponent(cleanSubUrl)}&u=${encodeURIComponent(creds.username)}&p=${encodeURIComponent(creds.passMd5)}`;
                
                subtitles.push({
                    id: `streamuj_direct_${subtitles.length}`,
                    url: proxyUrl,
                    lang: 'cs',
                    file_name: `Streamuj.tv - České titulky`
                });
            }

            // 2. Kontrola sidecar titulků na CDN vedle .mp4 souborů (klíčové pro seriály)
            if (subtitles.length === 0 && extracted.mp4Urls.length > 0) {
                for (const mp4Url of extracted.mp4Urls) {
                    const cdnSubs = await fetchSubtitlesFromMp4Url(mp4Url, creds.username, creds.passMd5, req.headers.host);
                    if (cdnSubs.length > 0) {
                        subtitles.push(...cdnSubs);
                        break;
                    }
                }
            }

            // 3. Skenování ID a dotaz do online webového přehrávače Streamuj.tv
            if (subtitles.length === 0 && extracted.ids.length > 0) {
                const uniqueIds = Array.from(new Set(extracted.ids)).slice(0, 8);
                const fetchPromises = uniqueIds.map(sid => fetchSubtitlesFromStreamuj(sid, creds.username, creds.passMd5, req.headers.host));
                const results = await Promise.all(fetchPromises);
                results.forEach(subs => subtitles.push(...subs));
            }
        }

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
