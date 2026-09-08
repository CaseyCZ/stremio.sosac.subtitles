const express = require('express');
const https = require('https');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 7000;
const SOSAC_API_DOMAIN = 'kodi-api.sosac.to';

const manifest = {
    id: 'org.stremio.sosac.streamuj.subtitles.public',
    version: require('./package.json').version,
    name: 'Sosáč + Streamuj CZ Titulky',
    description: 'Komunitní doplněk pro české titulky ze Sosáč / Streamuj.tv',
    types: ['movie', 'series'],
    idPrefixes: ['tt', 'sosac', 'sosac2', 'tmdb'],
    resources: ['subtitles'],
    catalogs: []
};

// ============================================================
// HTTPS
// ============================================================

function isStreamujHost(hostname) {
    return hostname === 'streamuj.tv' ||
        hostname.endsWith('.streamuj.tv');
}

function isAllowedHost(hostname) {
    return isStreamujHost(hostname) ||
        hostname === SOSAC_API_DOMAIN ||
        hostname === 'sosac.tv' ||
        hostname === 'www.sosac.tv';
}

function httpsGet(url, username, passMd5, customHeaders = {}, redirects = 0) {
    return new Promise((resolve, reject) => {
        let target;

        try {
            target = new URL(url);

            if (target.protocol !== 'https:' ||
                !isAllowedHost(target.hostname) ||
                target.username ||
                target.password) {
                throw new Error('Nepovolená HTTPS adresa.');
            }
        } catch (e) {
            reject(new Error('Neplatná nebo nepovolená HTTPS adresa.'));
            return;
        }

        const options = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Accept-Encoding': 'identity',
                'Referer': 'https://www.streamuj.tv/',
                'Cookie': username && passMd5
                    ? `pass=${username}%3A%3A%3A${passMd5}; sublanguage=1; quality=1; videolanguage=cs`
                    : 'sublanguage=1; quality=1; videolanguage=cs',
                ...customHeaders
            },
            timeout: 20000
        };

        const req = https.get(target, options, (res) => {
            const status = res.statusCode || 0;

            if ([301, 302, 303, 307, 308].includes(status)) {
                res.resume();

                if (!res.headers.location || redirects >= 3) {
                    reject(new Error('Příliš mnoho přesměrování.'));
                    return;
                }

                try {
                    const nextUrl = new URL(res.headers.location, target);
                    resolve(httpsGet(
                        nextUrl.toString(),
                        username,
                        passMd5,
                        customHeaders,
                        redirects + 1
                    ));
                } catch (e) {
                    reject(new Error('Neplatné přesměrování.'));
                }
                return;
            }

            if (status < 200 || status >= 300) {
                res.resume();
                reject(new Error(`HTTP Status ${status}`));
                return;
            }

            const chunks = [];
            let total = 0;
            const MAX_RESPONSE = 2 * 1024 * 1024;

            res.on('data', chunk => {
                const part = Buffer.from(chunk);
                total += part.length;

                if (total > MAX_RESPONSE) {
                    reject(new Error('Odpověď je příliš velká.'));
                    req.destroy();
                    return;
                }

                chunks.push(part);
            });

            res.on('end', () => {
                resolve(Buffer.concat(chunks).toString('utf8'));
            });

            res.on('error', err => reject(err));
        });

        req.on('error', err => {
            reject(new Error(`HTTPS chyba: ${err.code || 'NETWORK_ERROR'}`));
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Timeout při HTTPS GET.'));
        });
    });
}

// ============================================================
// POMOCNÉ FUNKCE
// ============================================================

function safeJsonParse(raw) {
    if (!raw || typeof raw !== 'string') {
        return null;
    }

    const text = raw.trim();

    if (!text || text.startsWith('<')) {
        return null;
    }

    try {
        return JSON.parse(text);
    } catch (e) {
        return null;
    }
}

function decodeHtmlEntities(text) {
    return String(text)
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&gt;/gi, '>')
        .replace(/&lt;/gi, '<');
}

function normalizeInt(value) {
    if (value === null ||
        value === undefined ||
        value === '') {
        return null;
    }

    const n = Number.parseInt(
        String(value).replace(/^S/i, ''),
        10
    );

    return Number.isFinite(n) ? n : null;
}

function parseUserConfig(configStr) {
    if (!configStr || !configStr.includes(':')) {
        return null;
    }

    const splitAt = configStr.indexOf(':');
    const username = configStr.slice(0, splitAt);
    const passMd5 = configStr.slice(splitAt + 1);

    if (!username || !passMd5) {
        return null;
    }

    return { username, passMd5 };
}

function getBaseUrl(req) {
    if (process.env.PUBLIC_BASE_URL) {
        return new URL(process.env.PUBLIC_BASE_URL).origin;
    }

    const proto = String(
        req.headers['x-forwarded-proto'] || req.protocol || 'https'
    ).split(',')[0].trim();

    return new URL(`${proto}://${req.get('host')}`).origin;
}

function validateSubtitleUrl(value) {
    const url = new URL(value);

    if (url.protocol !== 'https:' ||
        !isStreamujHost(url.hostname) ||
        url.username ||
        url.password) {
        throw new Error('Nepovolená adresa titulků.');
    }

    return url.toString();
}

function normalizeSubtitleUrl(rawUrl) {
    const url = new URL(
        decodeHtmlEntities(rawUrl),
        'https://www.streamuj.tv/'
    );

    // Starší odkazy Streamuj mohou používat HTTP.
    if (url.protocol === 'http:' &&
        isStreamujHost(url.hostname)) {
        url.protocol = 'https:';
    }

    return validateSubtitleUrl(url.toString());
}

// ============================================================
// EXTRAKCE STREAMUJ ID
// ============================================================

function extractAllStreamujIds(ep) {
    const ids = new Set();
    const mp4Urls = new Set();
    const directSubs = new Set();

    function addId(value) {
        if (!value) return;

        const id = String(value).trim();

        if (/^[a-zA-Z0-9]{15,40}$/.test(id)) {
            ids.add(id);
        }
    }

    function parseString(str) {
        if (!str || typeof str !== 'string') {
            return;
        }

        const clean = decodeHtmlEntities(str.trim());
        if (!clean) return;

        const mp4Match = clean.match(
            /https?:\/\/s\d+\.streamuj\.tv\/vid\/[^\s"'<>]+\/([a-zA-Z0-9]{15,40})_(?:sd|hd|720p|1080p|480p)\.mp4(?:\?[^\s"'<>]*)?/i
        );

        if (mp4Match) {
            mp4Urls.add(clean);
            addId(mp4Match[1]);
            return;
        }

        if (/\.mp4(?:\?|$)/i.test(clean)) {
            mp4Urls.add(clean);

            const filenameMatch = clean.match(
                /\/([a-zA-Z0-9]{15,40})_(?:sd|hd|720p|1080p|480p)\.mp4(?:\?|$)/i
            );

            if (filenameMatch) {
                addId(filenameMatch[1]);
            }
        }

        if (clean.includes('streamuj=subtitles') ||
            /\.(vtt|srt)(?:\?|$)/i.test(clean)) {
            directSubs.add(clean);
        }

        const pageMatch = clean.match(
            /https?:\/\/www\.streamuj\.tv\/(?:video|vid)\/([a-zA-Z0-9]{10,40})/i
        );

        if (pageMatch) {
            addId(pageMatch[1]);
        }

        if (/^[a-zA-Z0-9]{15,40}$/.test(clean)) {
            addId(clean);
        }
    }

    function recursiveSearch(obj) {
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
    }

    recursiveSearch(ep);

    return {
        ids: Array.from(ids),
        directSubs: Array.from(directSubs),
        mp4Urls: Array.from(mp4Urls)
    };
}

// ============================================================
// SRT -> WEBVTT
// ============================================================

function convertSrtToVtt(content) {
    const text = String(content ?? '')
        .replace(/^\uFEFF/, '')
        .replace(/\r\n?/g, '\n')
        .trim();

    if (!text) {
        throw new Error('Prázdný soubor titulků.');
    }

    if (/^WEBVTT(?:[ \t]|\n|$)/i.test(text)) {
        return text + '\n';
    }

    const timeRegex =
        /^(?:(\d+):)?([0-5]\d):([0-5]\d)[,.](\d{3})[ \t]*-->[ \t]*(?:(\d+):)?([0-5]\d):([0-5]\d)[,.](\d{3})([ \t]+.*)?$/;

    const lines = text.split('\n');
    const cues = [];
    let current = null;

    function formatTime(h, m, s, ms) {
        return String(Number(h || 0)).padStart(2, '0') +
            ':' + m + ':' + s + '.' + ms;
    }

    function finishCue() {
        if (!current) return;

        const body = current.body.join('\n')
            .replace(/\n[ \t]*\n+/g, '\n')
            .trim();

        if (body) {
            cues.push(current.time + '\n' + body);
        }

        current = null;
    }

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (/^\d+$/.test(line.trim()) &&
            i + 1 < lines.length &&
            timeRegex.test(lines[i + 1].trim())) {
            continue;
        }

        const match = timeRegex.exec(line.trim());

        if (match) {
            finishCue();

            current = {
                time: formatTime(
                    match[1], match[2], match[3], match[4]
                ) + ' --> ' + formatTime(
                    match[5], match[6], match[7], match[8]
                ) + (match[9] || ''),
                body: []
            };

            continue;
        }

        if (current) {
            if (line.includes('-->')) {
                throw new Error(
                    'Neplatný časový řádek SRT: ' + line
                );
            }

            current.body.push(line);
        } else if (line.trim()) {
            throw new Error(
                'Neznámý text před prvním titulkem: ' + line
            );
        }
    }

    finishCue();

    if (cues.length === 0) {
        throw new Error('V SRT nebyly nalezeny žádné titulky.');
    }

    return 'WEBVTT\n\n' + cues.join('\n\n') + '\n';
}

// ============================================================
// PŮVODNÍ PROXY URL
// ============================================================

function buildProxyUrl(req, rawSubUrl, username, passMd5) {
    const url = new URL('/subtitles.vtt', getBaseUrl(req));

    url.searchParams.set('url', rawSubUrl);
    url.searchParams.set('u', username);
    url.searchParams.set('p', passMd5);

    return url.toString();
}

// ============================================================
// STREAMUJ – VYHLEDÁNÍ TITULKŮ
// ============================================================

async function fetchSubtitlesFromStreamuj(
    videoId,
    username,
    passMd5,
    req
) {
    const subtitles = [];
    const seenUrls = new Set();

    function addSubtitle(rawUrl, subLang, id) {
        try {
            const sourceUrl = normalizeSubtitleUrl(rawUrl);

            if (seenUrls.has(sourceUrl)) {
                return;
            }

            seenUrls.add(sourceUrl);

            subtitles.push({
                id,
                url: buildProxyUrl(
                    req,
                    sourceUrl,
                    username,
                    passMd5
                ),
                lang: 'cze',
                file_name: `Streamuj.tv - ${subLang}.vtt`
            });
        } catch (e) {
            console.log('[Subtitle] Přeskakuji neplatný odkaz.');
        }
    }

    try {
        const remoteUrl =
            `https://www.streamuj.tv/video/${videoId}?remote=1`;

        console.log(`[Subtitle] Streamuj ID: ${videoId}`);

        const html = await httpsGet(
            remoteUrl,
            username,
            passMd5,
            {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Referer': `https://www.streamuj.tv/video/${videoId}`
            }
        );

        if (!html) {
            return subtitles;
        }

        console.log(`[Subtitle] HTML: ${html.length} znaků`);

        // Hlavní cesta: sub0: "čeština>URL"
        const subMatch = html.match(
            /sub0\s*:\s*["']([^"']+)["']/i
        );

        if (subMatch && subMatch[1]) {
            const val = decodeHtmlEntities(subMatch[1]);
            const splitAt = val.indexOf('>');

            if (splitAt >= 0) {
                const subLang =
                    val.slice(0, splitAt).trim() || 'čeština';

                const rawSubUrl =
                    val.slice(splitAt + 1).trim();

                if (rawSubUrl.includes('streamuj=subtitles')) {
                    addSubtitle(
                        rawSubUrl,
                        subLang,
                        `streamuj_${videoId}`
                    );
                }
            }
        }

        // Fallback: přímé odkazy v HTML.
        if (subtitles.length === 0) {
            const fallbackRegex =
                /(https?:\/\/[^"'\s<>]+\?[^"'\s<>]*streamuj=subtitles[^"'\s<>]*)/gi;

            let match;

            while ((match = fallbackRegex.exec(html)) !== null) {
                addSubtitle(
                    match[1],
                    'České titulky',
                    `streamuj_fb_${videoId}_${subtitles.length}`
                );
            }
        }

        // Fallback: další subX položky.
        if (subtitles.length === 0) {
            const subRegex =
                /sub\d+\s*:\s*["']([^"']+)["']/gi;

            let match;

            while ((match = subRegex.exec(html)) !== null) {
                const val = decodeHtmlEntities(match[1]);
                const splitAt = val.indexOf('>');

                if (splitAt < 0) continue;

                const subLang =
                    val.slice(0, splitAt).trim() || 'čeština';

                const rawSubUrl =
                    val.slice(splitAt + 1).trim();

                if (rawSubUrl.includes('streamuj=subtitles') ||
                    /\.(srt|vtt)(?:\?|$)/i.test(rawSubUrl)) {
                    addSubtitle(
                        rawSubUrl,
                        subLang,
                        `streamuj_sub_${videoId}_${subtitles.length}`
                    );
                }
            }
        }
    } catch (e) {
        console.error(
            `[Subtitle] Streamuj ${videoId} chyba: ${e.message}`
        );
    }

    console.log(`[Subtitle] Nalezeno titulků: ${subtitles.length}`);
    return subtitles;
}

// ============================================================
// SOSÁČ API
// ============================================================

async function fetchSosacMovie(id, username, passMd5) {
    const endpoint =
        `https://${SOSAC_API_DOMAIN}/movies/${encodeURIComponent(id)}`;

    console.log(`[Sosac] Movie GET: ${endpoint}`);

    const raw = await httpsGet(endpoint, username, passMd5, {
        'Referer': 'https://sosac.tv/',
        'Origin': 'https://sosac.tv/',
        'Accept': 'application/json,text/plain,*/*'
    });

    const data = safeJsonParse(raw);

    if (!data) return null;

    return data.item || data.movie || data;
}

async function fetchSosacSeriesRaw(episodeId, username, passMd5) {
    const endpoint =
        `https://${SOSAC_API_DOMAIN}/episodes/${encodeURIComponent(episodeId)}`;

    console.log(`[Sosac] Series RAW GET: ${endpoint}`);

    try {
        const raw = await httpsGet(endpoint, username, passMd5, {
            'Referer': 'https://sosac.tv/',
            'Origin': 'https://sosac.tv/',
            'Accept': 'application/json,text/plain,*/*'
        });

        const data = safeJsonParse(raw);

        if (!data) {
            console.log('[Sosac] Series API nevrátil platný JSON.');
            return null;
        }

        return data;
    } catch (e) {
        console.error(`[Sosac] Series chyba: ${e.message}`);
        return null;
    }
}

// ============================================================
// STAŽENÍ A PŘEVOD VTT
// ============================================================

async function downloadSubtitleVtt(rawUrl, username, passMd5) {
    const targetUrl = validateSubtitleUrl(rawUrl);

    const subData = await httpsGet(
        targetUrl,
        username,
        passMd5,
        {
            'Accept': 'text/vtt,text/plain,application/x-subrip,*/*',
            'Referer': 'https://www.streamuj.tv/'
        }
    );

    if (!subData || /^\s*</.test(subData)) {
        throw new Error(
            'Streamuj nevrátil platná textová data titulků.'
        );
    }

    const vtt = convertSrtToVtt(subData);

    if (!/^WEBVTT(?:[ \t]|\n|$)/i.test(vtt)) {
        throw new Error('Nepodařilo se vytvořit WebVTT.');
    }

    return Buffer.from(vtt, 'utf8');
}

function sendVtt(req, res, body) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Type, Content-Length');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', 'inline; filename="subtitles.vtt"');
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Content-Length', body.length);
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (req.method === 'HEAD') {
        return res.end();
    }

    return res.end(body);
}

// Původní proxy zůstává kvůli filmům a kompatibilitě.
async function handleSubtitleVtt(req, res) {
    const { url, u, p } = req.query;

    if (typeof url !== 'string' ||
        typeof u !== 'string' ||
        typeof p !== 'string' ||
        !url || !u || !p) {
        return res.status(400)
            .type('text/plain')
            .send('Chybí parametry.');
    }

    try {
        const body = await downloadSubtitleVtt(url, u, p);

        console.log(
            `[VTT Proxy] Hotový WebVTT: ${body.length} bajtů`
        );

        return sendVtt(req, res, body);
    } catch (e) {
        console.error(`[VTT Proxy] ${e.message}`);

        return res.status(500)
            .type('text/plain')
            .send('Chyba při stahování titulků.');
    }
}

app.get('/subtitles.vtt', handleSubtitleVtt);
app.get('/sub-proxy', handleSubtitleVtt);

// ============================================================
// READY VTT CACHE
// ============================================================

// Hotové titulky jsou pouze v paměti serveru.
// Žádné přihlašovací údaje se neukládají do veřejné URL.

const READY_VTT_TTL = 2 * 60 * 60 * 1000;
const READY_MAX_ENTRIES = 64;
const READY_MAX_BYTES = 16 * 1024 * 1024;

const readyCacheSecret = crypto.randomBytes(32);
const readyByKey = new Map();
const readyByToken = new Map();
const readyPending = new Map();

let readyCacheBytes = 0;

function makeReadyKey(rawUrl, creds) {
    return crypto
        .createHmac('sha256', readyCacheSecret)
        .update(JSON.stringify([
            rawUrl,
            creds.username,
            creds.passMd5
        ]))
        .digest('hex');
}

function removeReadyEntry(entry) {
    readyByKey.delete(entry.key);
    readyByToken.delete(entry.token);
    readyCacheBytes -= entry.body.length;
}

function pruneReadyCache() {
    const now = Date.now();

    for (const entry of readyByKey.values()) {
        if (entry.expires <= now) {
            removeReadyEntry(entry);
        }
    }
}

function getReadyEntry(key) {
    const entry = readyByKey.get(key);

    if (!entry) return null;

    if (entry.expires <= Date.now()) {
        removeReadyEntry(entry);
        return null;
    }

    // Posun na konec Map = nedávno použitá položka.
    readyByKey.delete(key);
    readyByKey.set(key, entry);

    return entry;
}

function storeReadyEntry(key, body) {
    pruneReadyCache();

    if (body.length > READY_MAX_BYTES) {
        throw new Error('Titulky jsou příliš velké pro cache.');
    }

    while (
        readyByKey.size >= READY_MAX_ENTRIES ||
        readyCacheBytes + body.length > READY_MAX_BYTES
    ) {
        const oldest = readyByKey.values().next().value;

        if (!oldest) break;

        removeReadyEntry(oldest);
    }

    const entry = {
        key,
        token: crypto.randomBytes(24).toString('hex'),
        body,
        expires: Date.now() + READY_VTT_TTL
    };

    readyByKey.set(key, entry);
    readyByToken.set(entry.token, entry);
    readyCacheBytes += body.length;

    return entry;
}

async function prepareReadySubtitle(sub, creds, req) {
    const proxyUrl = new URL(sub.url);
    const rawUrl = proxyUrl.searchParams.get('url');

    if (!rawUrl) {
        throw new Error('Chybí zdrojová URL titulku.');
    }

    const sourceUrl = validateSubtitleUrl(rawUrl);
    const key = makeReadyKey(sourceUrl, creds);

    let entry = getReadyEntry(key);

    if (entry) {
        console.log('[READY VTT] Používám připravený soubor.');
    } else {
        let pending = readyPending.get(key);

        if (!pending) {
            pending = (async () => {
                console.log('[READY VTT] Stahuji a převádím titulky...');

                const body = await downloadSubtitleVtt(
                    sourceUrl,
                    creds.username,
                    creds.passMd5
                );

                const stored = storeReadyEntry(key, body);

                console.log(
                    `[READY VTT] Připraveno: ${body.length} bajtů`
                );

                return stored;
            })();

            readyPending.set(key, pending);
        }

        try {
            entry = await pending;
        } finally {
            if (readyPending.get(key) === pending) {
                readyPending.delete(key);
            }
        }
    }

    const readyUrl = new URL(
        `/ready-vtt/${entry.token}.vtt`,
        getBaseUrl(req)
    ).toString();

    // Stabilní ID podle zdrojového souboru.
    const sourceId = crypto
        .createHash('sha256')
        .update(sourceUrl)
        .digest('hex')
        .slice(0, 24);

    return {
        ...sub,
        id: `ready_${sourceId}`,
        url: readyUrl
    };
}

// Stejné jednoduché odeslání jako u funkčního testu.
// Tady už se NIC nestahuje ani nepřevádí.
app.get('/ready-vtt/:token.vtt', (req, res) => {
    const token = req.params.token;

    if (!/^[a-f0-9]{48}$/.test(token)) {
        return res.status(404)
            .type('text/plain')
            .send('Titulky nenalezeny.');
    }

    const entry = readyByToken.get(token);

    if (!entry || entry.expires <= Date.now()) {
        if (entry) removeReadyEntry(entry);

        return res.status(404)
            .type('text/plain')
            .send('Připravené titulky již nejsou dostupné.');
    }

    console.log(
        `[READY VTT] Odesílám hotový soubor: ${entry.body.length} bajtů`
    );

    return sendVtt(req, res, entry.body);
});

// ============================================================
// KONFIGURAČNÍ STRÁNKA
// ============================================================

app.get('/:config/configure', (req, res) => {
    res.redirect('/');
});

app.get(['/', '/configure'], (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="cs">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sosáč Titulky - Stremio Addon</title>
<style>
body { font-family: system-ui, sans-serif; background: #0f172a; color: #f8fafc; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 1rem; box-sizing: border-box; }
.card { background: #1e293b; padding: 2rem; border-radius: 1rem; width: 100%; max-width: 440px; box-shadow: 0 20px 25px -5px rgba(0,0,0,.5); }
h1 { font-size: 1.5rem; color: #38bdf8; text-align: center; margin-bottom: .5rem; }
p { font-size: .875rem; color: #94a3b8; text-align: center; margin-bottom: 1.5rem; }
.field { margin-bottom: 1.25rem; }
label { display: block; font-size: .875rem; margin-bottom: .5rem; color: #cbd5e1; }
input { width: 100%; padding: .75rem; border-radius: .5rem; border: 1px solid #334155; background: #0f172a; color: white; box-sizing: border-box; }
button, .btn { width: 100%; padding: .875rem; border-radius: .5rem; border: none; background: #0284c7; color: white; font-weight: 600; cursor: pointer; text-align: center; text-decoration: none; display: block; box-sizing: border-box; font: inherit; }
button:hover, .btn:hover { background: #0369a1; }
button:focus-visible, input:focus-visible { outline: 2px solid #38bdf8; outline-offset: 2px; }
.input-row { display: flex; gap: .5rem; }
.input-row input { min-width: 0; flex: 1; }
.input-row button { width: auto; flex-shrink: 0; padding: .75rem; }
.remember { display: flex; align-items: flex-start; gap: .5rem; cursor: pointer; }
.remember input { width: auto; margin-top: .2rem; }
.remember span { font-size: .875rem; color: #cbd5e1; }
#result { display: none; margin-top: 1.5rem; padding-top: 1.5rem; border-top: 1px solid #334155; }
#result .field { margin-bottom: .75rem; }
#status { color: #7dd3fc; font-size: .875rem; margin: .75rem 0; min-height: 1.25rem; }
#installUrl { font-size: .8rem; }
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
<input type="text" id="username" required autocomplete="username" placeholder="TvojeJmeno">
</div>
<div class="field">
<label for="password">Heslo</label>
<div class="input-row">
<input type="password" id="password" required autocomplete="current-password" placeholder="••••••••">
<button type="button" id="showPassword" aria-label="Zobrazit heslo">Zobrazit</button>
</div>
</div>
<div class="field">
<label class="remember" for="rememberPassword">
<input type="checkbox" id="rememberPassword">
<span>Zapamatovat heslo na tomto zařízení</span>
</label>
</div>
<button type="submit">Vygenerovat instalační odkaz</button>
</form>
<div id="result">
<div class="field">
<label for="installUrl">Instalační odkaz (HTTPS)</label>
<div class="input-row">
<input id="installUrl" type="text" readonly spellcheck="false">
<button type="button" id="copyUrl">Kopírovat</button>
</div>
</div>
<a id="stremioBtn" href="#" class="btn">Instalovat do Stremio</a>
</div>
<div id="status" role="status" aria-live="polite"></div>
</div>
<script>
(function () {
    'use strict';
    var username = document.getElementById('username');
    var password = document.getElementById('password');
    var remember = document.getElementById('rememberPassword');
    var status = document.getElementById('status');
    var result = document.getElementById('result');
    var installUrl = document.getElementById('installUrl');
    var storageKey = 'sosac-subtitles-config';

    try {
        var saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
        username.value = saved.username || '';
        remember.checked = saved.rememberPassword === true;
        if (remember.checked) password.value = saved.password || '';
    } catch (e) {}

    document.getElementById('showPassword').addEventListener('click', function () {
        var visible = password.type === 'password';
        password.type = visible ? 'text' : 'password';
        this.textContent = visible ? 'Skrýt' : 'Zobrazit';
        this.setAttribute('aria-label', visible ? 'Skrýt heslo' : 'Zobrazit');
    });

    document.getElementById('configForm').addEventListener('submit', function (e) {
        e.preventDefault();

        var u = username.value.trim();
        var p = password.value;

        if (!u || !p) return;

        if (typeof CryptoJS === 'undefined') {
            status.textContent = 'Nepodařilo se načíst knihovnu pro vytvoření instalačního odkazu.';
            return;
        }

        var md5 = CryptoJS.MD5(p).toString();
        var path = '/' + encodeURIComponent(u) + ':' + md5 + '/manifest.json';
        var httpsUrl = window.location.origin + path;
        var stremioUrl = 'stremio://' + window.location.host + path;

        installUrl.value = httpsUrl;
        document.getElementById('stremioBtn').href = stremioUrl;
        result.style.display = 'block';
        status.textContent = 'Odkaz je připravený. Pro instalaci použijte tlačítko níže.';

        try {
            localStorage.setItem(storageKey, JSON.stringify({
                username: u,
                rememberPassword: remember.checked,
                password: remember.checked ? p : ''
            }));
        } catch (e) {
            status.textContent = 'Odkaz je připravený, ale prohlížeč nemohl uložit údaje.';
        }
    });

    document.getElementById('copyUrl').addEventListener('click', async function () {
        var value = installUrl.value;
        if (!value) return;

        try {
            if (!navigator.clipboard || !navigator.clipboard.writeText) {
                throw new Error('Clipboard unavailable');
            }

            await navigator.clipboard.writeText(value);
            status.textContent = 'Instalační odkaz zkopírován.';
        } catch (e) {
            installUrl.focus();
            installUrl.select();

            try {
                if (document.execCommand('copy')) {
                    status.textContent = 'Instalační odkaz zkopírován.';
                    return;
                }
            } catch (ignored) {}

            status.textContent = 'Odkaz je označený. Zkopírujte ho ručně.';
        }
    });
})();
</script>
</body>
</html>`);
});

// ============================================================
// MANIFEST
// ============================================================

app.get('/manifest.json', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');

    res.json({
        ...manifest,
        behaviorHints: {
            configurable: true,
            configurationRequired: true
        }
    });
});

app.get('/:config/manifest.json', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');

    res.json({
        ...manifest,
        behaviorHints: {
            configurable: true,
            configurationRequired: false
        }
    });
});

// ============================================================
// SUBTITLE RESOURCE
// ============================================================

app.get('/:config/subtitles/:type/:id/:extra?.json', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Content-Type', 'application/json');

    const creds = parseUserConfig(req.params.config);

    if (!creds) {
        return res.json({ subtitles: [] });
    }

    const { type, id } = req.params;

    try {
        const idParts = id.split(':');

        const cleanId = idParts[0]
            .replace(/^(sosac_m_|sosac2_|sosac_)/, '');

        const season = idParts[1]
            ? normalizeInt(idParts[1])
            : null;

        const episode = idParts[2]
            ? normalizeInt(idParts[2])
            : null;

        console.log('');
        console.log('========================================');
        console.log(`[Subtitle Request] type=${type}, id=${id}`);
        console.log(`[Subtitle Request] cleanId=${cleanId}, season=${season}, episode=${episode}`);
        console.log('========================================');

        // ----------------------------------------------------
        // FILMY – původní způsob zůstává
        // ----------------------------------------------------

        if (type === 'movie') {
            const targetData = await fetchSosacMovie(
                cleanId,
                creds.username,
                creds.passMd5
            );

            if (!targetData) {
                console.log('[Movie] Film nenalezen.');
                return res.json({ subtitles: [] });
            }

            const extracted = extractAllStreamujIds(targetData);

            console.log(
                `[Movie] Streamuj IDs: ${extracted.ids.join(', ') || '(žádné)'}`
            );

            let subtitles = [];

            for (const videoId of extracted.ids.slice(0, 10)) {
                const foundSubs = await fetchSubtitlesFromStreamuj(
                    videoId,
                    creds.username,
                    creds.passMd5,
                    req
                );

                if (foundSubs.length > 0) {
                    subtitles.push(...foundSubs);
                    break;
                }
            }

            const uniqueSubtitles = [];
            const seenUrls = new Set();

            for (const sub of subtitles) {
                if (!seenUrls.has(sub.url)) {
                    seenUrls.add(sub.url);
                    uniqueSubtitles.push(sub);
                }
            }

            console.log(
                `[Movie] Vrácím ${uniqueSubtitles.length} titulků.`
            );

            return res.json({
                subtitles: uniqueSubtitles
            });
        }

        // ----------------------------------------------------
        // SERIÁLY – PŘEDNAČTENÍ HOTOVÉHO VTT
        // ----------------------------------------------------

        if (type === 'series') {
            console.log(`[Series] Hledám epizodu ID=${cleanId}`);

            const targetData = await fetchSosacSeriesRaw(
                cleanId,
                creds.username,
                creds.passMd5
            );

            if (!targetData) {
                console.log('[Series] Epizoda nenalezena.');
                return res.json({ subtitles: [] });
            }

            console.log(
                `[Series] Sosáč episode: season=${targetData.s}, episode=${targetData.ep}, streamuj=${targetData.l}`
            );

            let foundSubs = [];

            // Hlavní cesta: přímé Streamuj ID epizody.
            if (targetData.l) {
                const streamujId = String(targetData.l).trim();

                console.log(
                    `[Series] Používám Streamuj ID: ${streamujId}`
                );

                foundSubs = await fetchSubtitlesFromStreamuj(
                    streamujId,
                    creds.username,
                    creds.passMd5,
                    req
                );
            }

            // Fallback: další nalezená Streamuj ID.
            if (foundSubs.length === 0) {
                const extracted = extractAllStreamujIds(targetData);

                console.log(
                    `[Series] Fallback Streamuj ID: ${extracted.ids.join(', ') || '(žádné)'}`
                );

                for (const streamujId of extracted.ids.slice(0, 10)) {
                    foundSubs = await fetchSubtitlesFromStreamuj(
                        streamujId,
                        creds.username,
                        creds.passMd5,
                        req
                    );

                    if (foundSubs.length > 0) {
                        break;
                    }
                }
            }

            if (foundSubs.length === 0) {
                console.log('[Series] Žádné české titulky nenalezeny.');
                return res.json({ subtitles: [] });
            }

            // Nejdřív stáhnout a převést.
            // Teprve potom vrátit Stremiu URL hotového souboru.
            const responseSubs = await Promise.all(
                foundSubs.map(async sub => {
                    try {
                        return await prepareReadySubtitle(
                            sub,
                            creds,
                            req
                        );
                    } catch (e) {
                        console.error(
                            `[READY VTT] Přednačítání selhalo: ${e.message}`
                        );

                        // Zachováme původní proxy jako fallback.
                        return sub;
                    }
                })
            );

            // Bez přihlašovacích údajů a bez plných URL.
            console.log('[FINAL RESPONSE]', JSON.stringify({
                subtitles: responseSubs.map(sub => ({
                    id: sub.id,
                    lang: sub.lang,
                    file_name: sub.file_name,
                    ready: sub.url.includes('/ready-vtt/')
                }))
            }, null, 2));

            return res.json({
                subtitles: responseSubs
            });
        }

        console.log(`[Result] Nepodporovaný typ: ${type}`);
        return res.json({ subtitles: [] });

    } catch (e) {
        console.error('[Handler Error]:', e.message);
        return res.json({ subtitles: [] });
    }
});

// ============================================================
// START
// ============================================================

app.listen(PORT, () => {
    console.log(`Sosáč + Streamuj CZ Titulky v${manifest.version}`);
    console.log(`Addon běží na portu ${PORT}`);
    console.log(`Port: ${PORT}`);
});
