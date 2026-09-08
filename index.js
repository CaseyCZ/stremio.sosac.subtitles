const express = require('express');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 7000;
const SOSAC_API_DOMAIN = 'kodi-api.sosac.to';

const manifest = {
    id: 'org.stremio.sosac.streamuj.subtitles.public',
    version: '2.8.1',
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
                'Cookie': username && passMd5
                    ? `pass=${username}%3A%3A%3A${passMd5}; sublanguage=1; quality=1; videolanguage=cs`
                    : 'sublanguage=1; quality=1; videolanguage=cs',
                ...customHeaders
            },
            rejectUnauthorized: false,
            timeout: 20000
        };

        const req = https.get(url, options, (res) => {
            const chunks = [];

            res.on('data', chunk => chunks.push(Buffer.from(chunk)));

            res.on('end', () => {
                const data = Buffer.concat(chunks).toString('utf8');

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
            reject(new Error(`Timeout při GET ${url}`));
        });
    });
}

function safeJsonParse(raw) {
    if (!raw || typeof raw !== 'string') return null;

    const text = raw.trim();

    if (!text || text.startsWith('<')) return null;

    try {
        return JSON.parse(text);
    } catch (e) {
        return null;
    }
}

function normalizeInt(value) {
    if (value === null || value === undefined || value === '') return null;

    const n = Number.parseInt(
        String(value).replace(/^S/i, ''),
        10
    );

    return Number.isFinite(n) ? n : null;
}

function getSeasonNumber(obj) {
    if (!obj || typeof obj !== 'object') return null;

    return normalizeInt(
        obj.season ??
        obj.season_number ??
        obj.seasonNumber ??
        obj.s ??
        obj.seasonNo
    );
}

function getEpisodeNumber(obj) {
    if (!obj || typeof obj !== 'object') return null;

    return normalizeInt(
        obj.episode ??
        obj.episode_number ??
        obj.episodeNumber ??
        obj.e ??
        obj.ep ??
        obj.episodeNo ??
        obj.number
    );
}

function isTargetEpisode(obj, season, episode) {
    if (!obj || typeof obj !== 'object') return false;

    const s = getSeasonNumber(obj);
    const e = getEpisodeNumber(obj);

    return s === season && e === episode;
}

function findEpisodeRecursive(obj, season, episode) {
    if (!obj) return null;

    if (Array.isArray(obj)) {
        for (const item of obj) {
            const found = findEpisodeRecursive(item, season, episode);

            if (found) return found;
        }

        return null;
    }

    if (typeof obj !== 'object') return null;

    if (isTargetEpisode(obj, season, episode)) {
        return obj;
    }

    for (const value of Object.values(obj)) {
        if (value && typeof value === 'object') {
            const found = findEpisodeRecursive(
                value,
                season,
                episode
            );

            if (found) return found;
        }
    }

    return null;
}

function extractAllStreamujIds(ep) {
    const ids = new Set();
    const mp4Urls = new Set();
    const directSubs = new Set();

    const addId = (value) => {
        if (!value) return;

        const id = String(value).trim();

        if (/^[a-zA-Z0-9]{15,40}$/.test(id)) {
            ids.add(id);
        }
    };

    const parseString = (str) => {
        if (!str || typeof str !== 'string') return;

        const clean = decodeHtmlEntities(str.trim());

        if (!clean) return;

        // Skutečný Streamuj CDN odkaz na video
        const mp4Match = clean.match(
            /https?:\/\/s\d+\.streamuj\.tv\/vid\/[^\s"'<>]+\/([a-zA-Z0-9]{15,40})_(?:sd|hd|720p|1080p|480p)\.mp4(?:\?[^\s"'<>]*)?/i
        );

        if (mp4Match) {
            mp4Urls.add(clean);
            addId(mp4Match[1]);

            console.log(
                `[Extract] Streamuj ID z MP4: ${mp4Match[1]}`
            );

            return;
        }

        // Obecný MP4 fallback
        if (/\.mp4(?:\?|$)/i.test(clean)) {
            mp4Urls.add(clean);

            const filenameMatch = clean.match(
                /\/([a-zA-Z0-9]{15,40})_(?:sd|hd|720p|1080p|480p)\.mp4(?:\?|$)/i
            );

            if (filenameMatch) {
                addId(filenameMatch[1]);
            }
        }

        // Přímý odkaz na titulky
        if (
            clean.includes('streamuj=subtitles') ||
            /\.(vtt|srt)(?:\?|$)/i.test(clean)
        ) {
            directSubs.add(clean);
        }

        // Streamuj stránka
        const pageMatch = clean.match(
            /https?:\/\/www\.streamuj\.tv\/(?:video|vid)\/([a-zA-Z0-9]{10,40})/i
        );

        if (pageMatch) {
            addId(pageMatch[1]);
        }

        // Samotné ID
        if (/^[a-zA-Z0-9]{15,40}$/.test(clean)) {
            addId(clean);
        }
    };

    const recursiveSearch = (obj) => {
        if (!obj) return;

        if (typeof obj === 'string') {
            parseString(obj);
            return;
        }

        if (Array.isArray(obj)) {
            obj.forEach(recursiveSearch);
            return;
        }

        if (typeof obj === 'object') {
            Object.values(obj).forEach(recursiveSearch);
        }
    };

    recursiveSearch(ep);

    return {
        ids: Array.from(ids),
        directSubs: Array.from(directSubs),
        mp4Urls: Array.from(mp4Urls)
    };
}

function decodeHtmlEntities(text) {
    return String(text)
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&gt;/gi, '>')
        .replace(/&lt;/gi, '<');
}

function buildProxyUrl(req, rawSubUrl, username, passMd5) {
    const proto =
        req.headers['x-forwarded-proto'] ||
        req.protocol ||
        'https';

    const host = req.get('host');

    return `${proto}://${host}/sub-proxy?url=${encodeURIComponent(rawSubUrl)}&u=${encodeURIComponent(username)}&p=${encodeURIComponent(passMd5)}`;
}

async function fetchSubtitlesFromStreamuj(
    videoId,
    username,
    passMd5,
    req
) {
    const subtitles = [];

    try {
        const remoteUrl =
            `https://www.streamuj.tv/video/${videoId}?remote=1`;

        console.log(`[Subtitle] Streamuj ID: ${videoId}`);
        console.log(`[Subtitle] GET: ${remoteUrl}`);

        const html = await httpsGet(
            remoteUrl,
            username,
            passMd5,
            {
                'Accept':
                    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Referer':
                    `https://www.streamuj.tv/video/${videoId}`
            }
        );

        if (!html) return subtitles;

        console.log(`[Subtitle] HTML: ${html.length} znaků`);

        const subMatch = html.match(
            /sub0\s*:\s*["']([^"']+)["']/i
        );

        if (subMatch && subMatch[1]) {
            const val = decodeHtmlEntities(subMatch[1]);

            const parts = val.split('>');

            if (parts.length >= 2) {
                const subLang =
                    parts.shift().trim() || 'čeština';

                let rawSubUrl =
                    parts.join('>').trim();

                if (!rawSubUrl.startsWith('http')) {
                    rawSubUrl =
                        rawSubUrl.startsWith('/')
                            ? `https://www.streamuj.tv${rawSubUrl}`
                            : `https://www.streamuj.tv/${rawSubUrl}`;
                }

                if (
                    rawSubUrl.includes(
                        'streamuj=subtitles'
                    )
                ) {
                    const proxyUrl = buildProxyUrl(
                        req,
                        rawSubUrl,
                        username,
                        passMd5
                    );

                    console.log(
                        `[Subtitle] Nalezeno: ${subLang}`
                    );

                    console.log(
                        `[Subtitle] Zdroj titulku: ${rawSubUrl}`
                    );

                    subtitles.push({
                        id: `streamuj_${videoId}`,
                        url: proxyUrl,
                        lang:
                            subLang
                                .toLowerCase()
                                .includes('č') ||
                            subLang
                                .toLowerCase()
                                .includes('cz')
                                ? 'cs'
                                : 'cs',
                        file_name:
                            `Streamuj.tv - ${subLang}`
                    });
                }
            }
        }

        // Fallback
        if (subtitles.length === 0) {
            const fallbackRegex =
                /(https?:\/\/[^"'\s<>]+\?[^"'\s<>]*streamuj=subtitles[^"'\s<>]*)/gi;

            let match;

            while (
                (match = fallbackRegex.exec(html)) !== null
            ) {
                const cleanUrl =
                    decodeHtmlEntities(
                        match[1].trim()
                    );

                const proxyUrl =
                    buildProxyUrl(
                        req,
                        cleanUrl,
                        username,
                        passMd5
                    );

                subtitles.push({
                    id:
                        `streamuj_fb_${videoId}_${subtitles.length}`,
                    url: proxyUrl,
                    lang: 'cs',
                    file_name:
                        'Streamuj.tv - České titulky'
                });
            }
        }
    } catch (e) {
        console.error(
            `[Subtitle] Streamuj ${videoId} chyba: ${e.message}`
        );
    }

    return subtitles;
}

async function fetchSubtitlesFromMp4Url(
    mp4Url,
    username,
    passMd5,
    req
) {
    const subtitles = [];

    try {
        const cleanVideoUrl =
            mp4Url.split('?')[0];

        const lastSlash =
            cleanVideoUrl.lastIndexOf('/');

        const dirUrl =
            cleanVideoUrl.substring(
                0,
                lastSlash + 1
            );

        const filenameWithExt =
            cleanVideoUrl.substring(
                lastSlash + 1
            );

        const baseName =
            filenameWithExt.replace(
                /(_sd|_hd|_720p|_1080p|_480p)?\.mp4/i,
                ''
            );

        const candidateSubUrls = [
            `${dirUrl}${baseName}_cs.srt`,
            `${dirUrl}${baseName}_cz.srt`,
            `${dirUrl}${baseName}.srt`,
            `${dirUrl}${baseName}_cs.vtt`,
            `${dirUrl}${baseName}.vtt`
        ];

        for (const subCandidate of candidateSubUrls) {
            try {
                const authQuery =
                    mp4Url.includes('?')
                        ? '?' + mp4Url.split('?')[1]
                        : '';

                const testUrl =
                    subCandidate + authQuery;

                const subData =
                    await httpsGet(
                        testUrl,
                        username,
                        passMd5
                    );

                if (
                    subData &&
                    !subData
                        .trim()
                        .startsWith('<') &&
                    (
                        subData.includes('-->') ||
                        subData.length > 20
                    )
                ) {
                    const proxyUrl =
                        buildProxyUrl(
                            req,
                            testUrl,
                            username,
                            passMd5
                        );

                    subtitles.push({
                        id:
                            `streamuj_cdn_sub_${subtitles.length}`,
                        url: proxyUrl,
                        lang: 'cs',
                        file_name:
                            'Streamuj.tv - Čeština (CDN)'
                    });

                    break;
                }
            } catch (e) {
                // Kandidát neexistuje
            }
        }
    } catch (e) {
        // Pokračujeme hlavní cestou
    }

    return subtitles;
}

function parseUserConfig(configStr) {
    if (
        !configStr ||
        !configStr.includes(':')
    ) {
        return null;
    }

    const splitAt =
        configStr.indexOf(':');

    const username =
        configStr.slice(0, splitAt);

    const passMd5 =
        configStr.slice(splitAt + 1);

    if (!username || !passMd5) {
        return null;
    }

    return {
        username,
        passMd5
    };
}

async function fetchSosacMovie(
    id,
    username,
    passMd5
) {
    const endpoint =
        `https://${SOSAC_API_DOMAIN}/movies/${encodeURIComponent(id)}`;

    console.log(
        `[Sosac] Movie GET: ${endpoint}`
    );

    const raw =
        await httpsGet(
            endpoint,
            username,
            passMd5,
            {
                'Referer':
                    'https://sosac.tv/',
                'Origin':
                    'https://sosac.tv/',
                'Accept':
                    'application/json,text/plain,*/*'
            }
        );

    const data =
        safeJsonParse(raw);

    if (!data) return null;

    return (
        data.item ||
        data.movie ||
        data
    );
}

function parseExtraParams(extra) {
    const params =
        new URLSearchParams(
            String(extra || '')
                .replace(/^\?/, '')
        );

    return {
        filename:
            params.get('filename') ||
            null,

        videoSize:
            params.get('videoSize')
                ? Number(params.get('videoSize'))
                : null,

        videoHash:
            params.get('videoHash') ||
            null
    };
}

function getObjectVideoSize(obj) {
    if (!obj || typeof obj !== 'object') {
        return null;
    }

    const keys = [
        'videoSize',
        'video_size',
        'filesize',
        'fileSize',
        'size',
        'bytes',
        'length'
    ];

    for (const key of keys) {
        const value = obj[key];

        const n = Number(value);

        if (
            Number.isFinite(n) &&
            n > 0
        ) {
            return n;
        }
    }

    return null;
}

function getStringValues(obj, out = []) {
    if (!obj) return out;

    if (typeof obj === 'string') {
        out.push(obj);
        return out;
    }

    if (Array.isArray(obj)) {
        for (const item of obj) {
            getStringValues(item, out);
        }

        return out;
    }

    if (typeof obj === 'object') {
        for (const value of Object.values(obj)) {
            getStringValues(value, out);
        }
    }

    return out;
}

function collectSeriesPlaybackCandidates(root) {
    const candidates = [];

    function walk(obj) {
        if (!obj) return;

        if (Array.isArray(obj)) {
            for (const item of obj) {
                walk(item);
            }

            return;
        }

        if (typeof obj !== 'object') {
            return;
        }

        const season =
            getSeasonNumber(obj);

        const episode =
            getEpisodeNumber(obj);

        const extracted =
            extractAllStreamujIds(obj);

        if (extracted.ids.length > 0) {
            candidates.push({
                obj,
                season,
                episode,
                size:
                    getObjectVideoSize(obj),
                ids:
                    extracted.ids,
                mp4Urls:
                    extracted.mp4Urls,
                strings:
                    getStringValues(obj)
            });
        }

        for (const value of Object.values(obj)) {
            if (
                value &&
                typeof value === 'object'
            ) {
                walk(value);
            }
        }
    }

    walk(root);

    return candidates;
}

function findSeriesEpisodeByPlaybackHints(
    root,
    hints
) {
    const candidates =
        collectSeriesPlaybackCandidates(root);

    console.log(
        `[SeriesHints] Kandidátů se Streamuj ID: ${candidates.length}`
    );

    const filename =
        hints.filename
            ? decodeURIComponent(
                hints.filename
            ).toLowerCase()
            : null;

    const videoSize =
        Number.isFinite(
            hints.videoSize
        )
            ? hints.videoSize
            : null;

    // 1. Nejdřív přesná velikost
    if (videoSize) {
        const exact =
            candidates.filter(
                c => c.size === videoSize
            );

        if (exact.length > 0) {
            console.log(
                `[SeriesHints] Shoda podle videoSize=${videoSize}: ${exact.length}`
            );

            return exact[0];
        }

        console.log(
            `[SeriesHints] videoSize=${videoSize}, přesná shoda nenalezena.`
        );
    }

    // 2. Potom přes filename
    if (filename) {
        const fileBase =
            filename
                .split('?')[0]
                .split('/')
                .pop();

        const normalized =
            fileBase
                .replace(/\\/g, '/')
                .toLowerCase();

        const byFilename =
            candidates.filter(c =>
                c.strings.some(
                    v =>
                        String(v)
                            .toLowerCase()
                            .includes(normalized)
                )
            );

        if (byFilename.length > 0) {
            console.log(
                `[SeriesHints] Shoda podle filename: ${byFilename.length}`
            );

            return byFilename[0];
        }
    }

    return null;
}

async function fetchSosacSeriesRaw(
    seriesId,
    username,
    passMd5
) {
    const endpoints = [
        `https://${SOSAC_API_DOMAIN}/episodes/${encodeURIComponent(seriesId)}`,
        `https://${SOSAC_API_DOMAIN}/series/${encodeURIComponent(seriesId)}/episodes`
    ];

    for (const endpoint of endpoints) {
        try {
            console.log(
                `[Sosac] Series RAW GET: ${endpoint}`
            );

            const raw =
                await httpsGet(
                    endpoint,
                    username,
                    passMd5,
                    {
                        'Referer':
                            'https://sosac.tv/',
                        'Origin':
                            'https://sosac.tv/',
                        'Accept':
                            'application/json,text/plain,*/*'
                    }
                );

            const data =
                safeJsonParse(raw);

            if (data) {
                return data;
            }
        } catch (e) {
            console.error(
                `[Sosac] RAW ${endpoint} chyba: ${e.message}`
            );
        }
    }

    return null;
}

async function fetchSosacSeriesEpisode(
    seriesId,
    season,
    episode,
    username,
    passMd5
) {
    const endpoints = [
        `https://${SOSAC_API_DOMAIN}/episodes/${encodeURIComponent(seriesId)}`,
        `https://${SOSAC_API_DOMAIN}/series/${encodeURIComponent(seriesId)}/episodes`
    ];

    for (const endpoint of endpoints) {
        try {
            console.log(
                `[Sosac] Series GET: ${endpoint}`
            );

            const raw =
                await httpsGet(
                    endpoint,
                    username,
                    passMd5,
                    {
                        'Referer':
                            'https://sosac.tv/',
                        'Origin':
                            'https://sosac.tv/',
                        'Accept':
                            'application/json,text/plain,*/*'
                    }
                );

            const data =
                safeJsonParse(raw);

            if (!data) continue;

            const found =
                findEpisodeRecursive(
                    data,
                    season,
                    episode
                );

            if (found) {
                console.log(
                    `[Sosac] Nalezena epizoda S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}.`
                );

                return found;
            }
        } catch (e) {
            console.error(
                `[Sosac] ${endpoint} chyba: ${e.message}`
            );
        }
    }

    return null;
}

app.get(
    '/sub-proxy',
    async (req, res) => {
        const { url, u, p } =
            req.query;

        if (!url || !u || !p) {
            return res
                .status(400)
                .send('Chybí parametry.');
        }

        try {
            const targetUrl =
                decodeURIComponent(url);

            const subData =
                await httpsGet(
                    targetUrl,
                    u,
                    p,
                    {
                        'Accept':
                            'text/vtt,text/plain,application/x-subrip,*/*',
                        'Referer':
                            'https://www.streamuj.tv/'
                    }
                );

            if (
                !subData ||
                /^\s*</.test(subData)
            ) {
                throw new Error(
                    'Streamuj nevrátil platná textová data titulků.'
                );
            }

            const cleanSub =
                String(subData)
                    .replace(/^\uFEFF/, '')
                    .trimStart();

            const isVtt =
                /^WEBVTT(?:\s|$)/i.test(
                    cleanSub
                );

            const contentType =
                isVtt
                    ? 'text/vtt; charset=utf-8'
                    : 'application/x-subrip; charset=utf-8';

            console.log(
                `[Proxy] Titulky načteny: ${subData.length} znaků, format=${isVtt ? 'VTT' : 'SRT'}`
            );

            res.setHeader(
                'Access-Control-Allow-Origin',
                '*'
            );

            res.setHeader(
                'Access-Control-Expose-Headers',
                'Content-Type, Content-Length'
            );

            res.setHeader(
                'Cache-Control',
                'no-cache, no-store, must-revalidate'
            );

            res.setHeader(
                'Content-Disposition',
                'inline'
            );

            res.setHeader(
                'Content-Type',
                contentType
            );

            return res.send(subData);

        } catch (e) {
            console.error(
                `[Proxy] ${e.message}`
            );

            return res
                .status(500)
                .send(
                    'Chyba při stahování titulků.'
                );
        }
    }
);

app.get(
    '/:config/configure',
    (req, res) =>
        res.redirect('/')
);

app.get(
    ['/', '/configure'],
    (req, res) => {
        res.send(`
<!DOCTYPE html>
<html lang="cs">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sosáč Titulky - Stremio Addon</title>

<style>
body {
    font-family: system-ui, sans-serif;
    background: #0f172a;
    color: #f8fafc;
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 100vh;
    margin: 0;
    padding: 1rem;
    box-sizing: border-box;
}

.card {
    background: #1e293b;
    padding: 2rem;
    border-radius: 1rem;
    width: 100%;
    max-width: 440px;
    box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5);
}

h1 {
    font-size: 1.5rem;
    font-weight: 700;
    color: #38bdf8;
    text-align: center;
    margin-bottom: 0.5rem;
}

p {
    font-size: 0.875rem;
    color: #94a3b8;
    text-align: center;
    margin-bottom: 1.5rem;
}

.field {
    margin-bottom: 1.25rem;
}

label {
    display: block;
    font-size: 0.875rem;
    margin-bottom: 0.5rem;
    color: #cbd5e1;
}

input {
    width: 100%;
    padding: 0.75rem;
    border-radius: 0.5rem;
    border: 1px solid #334155;
    background: #0f172a;
    color: white;
    box-sizing: border-box;
}

button,
.btn {
    width: 100%;
    padding: 0.875rem;
    border-radius: 0.5rem;
    border: none;
    background: #0284c7;
    color: white;
    font-weight: 600;
    cursor: pointer;
    text-align: center;
    text-decoration: none;
    display: block;
    box-sizing: border-box;
}

button:hover,
.btn:hover {
    background: #0369a1;
}

#result {
    display: none;
    margin-top: 1.5rem;
    padding-top: 1.5rem;
    border-top: 1px solid #334155;
}
</style>

<script src="https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.1.1/crypto-js.min.js"></script>

</head>

<body>

<div class="card">

<h1>Sosáč CZ Titulky</h1>

<p>
Zadejte své přihlašovací údaje ze Sosáč.tv
pro generování doplňku.
</p>

<form id="configForm">

<div class="field">
<label for="username">
Uživatelské jméno
</label>

<input
    type="text"
    id="username"
    required
    placeholder="TvojeJmeno">
</div>

<div class="field">

<label for="password">
Heslo
</label>

<input
    type="password"
    id="password"
    required
    placeholder="••••••••">

</div>

<button type="submit">
Vygenerovat instalační odkaz
</button>

</form>

<div id="result">

<a
    id="stremioBtn"
    href="#"
    class="btn">

Instalovat do Stremio

</a>

</div>

</div>

<script>

document
    .getElementById('configForm')
    .addEventListener(
        'submit',
        function(e) {

            e.preventDefault();

            const u =
                document
                    .getElementById('username')
                    .value
                    .trim();

            const p =
                document
                    .getElementById('password')
                    .value;

            const md5 =
                CryptoJS
                    .MD5(p)
                    .toString();

            const host =
                window.location.host;

            const stremioUrl =
                'stremio://' +
                host +
                '/' +
                encodeURIComponent(u) +
                ':' +
                md5 +
                '/manifest.json';

            document
                .getElementById('stremioBtn')
                .href =
                stremioUrl;

            document
                .getElementById('result')
                .style.display =
                'block';

            window.location.href =
                stremioUrl;
        }
    );

</script>

</body>
</html>
`);
    }
);

app.get(
    '/manifest.json',
    (req, res) => {
        res.setHeader(
            'Access-Control-Allow-Origin',
            '*'
        );

        res.json({
            ...manifest,
            behaviorHints: {
                configurable: true,
                configurationRequired: true
            }
        });
    }
);

app.get(
    '/:config/manifest.json',
    (req, res) => {
        res.setHeader(
            'Access-Control-Allow-Origin',
            '*'
        );

        res.json({
            ...manifest,
            behaviorHints: {
                configurable: true,
                configurationRequired: false
            }
        });
    }
);

app.get(
    '/:config/subtitles/:type/:id/:extra?.json',
    async (req, res) => {

        res.setHeader(
            'Access-Control-Allow-Origin',
            '*'
        );

        res.setHeader(
            'Content-Type',
            'application/json'
        );

        const creds =
            parseUserConfig(
                req.params.config
            );

        if (!creds) {
            return res.json({
                subtitles: []
            });
        }

        const { type, id } =
            req.params;

        try {

            const idParts =
                id.split(':');

            const cleanId =
                idParts[0]
                    .replace(
                        /^(sosac_m_|sosac2_|sosac_)/,
                        ''
                    );

            const season =
                idParts[1]
                    ? normalizeInt(idParts[1])
                    : null;

            const episode =
                idParts[2]
                    ? normalizeInt(idParts[2])
                    : null;

            console.log('');
            console.log(
                '========================================'
            );

            console.log(
                `[Subtitle Request] type=${type}, id=${id}`
            );

            console.log(
                `[Subtitle Request] cleanId=${cleanId}, season=${season}, episode=${episode}`
            );

            console.log(
                '========================================'
            );

            let targetData = null;

            if (type === 'movie') {

                targetData =
                    await fetchSosacMovie(
                        cleanId,
                        creds.username,
                        creds.passMd5
                    );

            } else if (type === 'series') {

                // Normální požadavek:
                // sosac2_ID:1:2

                if (
                    season !== null &&
                    episode !== null
                ) {

                    targetData =
                        await fetchSosacSeriesEpisode(
                            cleanId,
                            season,
                            episode,
                            creds.username,
                            creds.passMd5
                        );

                } else {

                    // iPhone / Stremio Web:
                    // někdy pošle pouze :episodes
                    // + videoSize/videoHash

                    const hints =
                        parseExtraParams(
                            req.params.extra || ''
                        );

                    console.log(
                        `[SeriesHints] filename=${hints.filename || 'null'}, videoSize=${hints.videoSize || 'null'}, videoHash=${hints.videoHash || 'null'}`
                    );

                    const rawSeries =
                        await fetchSosacSeriesRaw(
                            cleanId,
                            creds.username,
                            creds.passMd5
                        );

                    if (rawSeries) {

                        const matched =
                            findSeriesEpisodeByPlaybackHints(
                                rawSeries,
                                hints
                            );

                        if (matched) {

                            targetData =
                                matched.obj;

                            console.log(
                                `[SeriesHints] Nalezena epizoda S${matched.season ?? '?'}E${matched.episode ?? '?'}, Streamuj IDs: ${matched.ids.join(', ')}`
                            );

                        } else {

                            console.log(
                                '[SeriesHints] Nepodařilo se určit konkrétní epizodu.'
                            );
                        }
                    }

                    if (!targetData) {

                        return res.json({
                            subtitles: []
                        });
                    }
                }
            }

            if (!targetData) {

                console.log(
                    '[Result] Epizoda / film nebyl nalezen v Sosáč API.'
                );

                return res.json({
                    subtitles: []
                });
            }

            const extracted =
                extractAllStreamujIds(
                    targetData
                );

            console.log(
                `[Extract] Streamuj IDs: ${extracted.ids.join(', ') || '(žádné)'}`
            );

            console.log(
                `[Extract] Přímé titulky: ${extracted.directSubs.length}`
            );

            console.log(
                `[Extract] MP4 URL: ${extracted.mp4Urls.length}`
            );

            let subtitles = [];

            // Hlavní cesta:
            // Streamuj ID -> ?remote=1 -> sub0

            if (
                extracted.ids.length > 0
            ) {

                const uniqueIds =
                    Array.from(
                        new Set(
                            extracted.ids
                        )
                    ).slice(0, 10);

                console.log(
                    `[Streamuj] Kontroluji ${uniqueIds.length} ID přes /video/ID?remote=1`
                );

                for (
                    const videoId of uniqueIds
                ) {

                    const foundSubs =
                        await fetchSubtitlesFromStreamuj(
                            videoId,
                            creds.username,
                            creds.passMd5,
                            req
                        );

                    if (
                        foundSubs.length > 0
                    ) {

                        subtitles.push(
                            ...foundSubs
                        );

                        break;
                    }
                }
            }

            const uniqueSubtitles = [];

            const seenUrls =
                new Set();

            for (
                const sub of subtitles
            ) {

                if (
                    !seenUrls.has(sub.url)
                ) {

                    seenUrls.add(
                        sub.url
                    );

                    uniqueSubtitles.push(
                        sub
                    );
                }
            }

            console.log(
                `[Result] Vrácím ${uniqueSubtitles.length} titulků.`
            );

            return res.json({
                subtitles:
                    uniqueSubtitles
            });

        } catch (e) {

            console.error(
                '[Handler Error]:',
                e.message
            );

            return res.json({
                subtitles: []
            });
        }
    }
);

app.listen(
    PORT,
    () => {

        console.log(
            `Sosáč + Streamuj CZ Titulky v${manifest.version}`
        );

        console.log(
            `Manifest: http://127.0.0.1:${PORT}/manifest.json`
        );

        console.log(
            `Addon běží na portu ${PORT}`
        );
    }
);
