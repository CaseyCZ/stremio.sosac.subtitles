const express = require('express');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');

const app = express();
app.disable('etag');
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
});
const PORT = process.env.PORT || 7000;
const SOSAC_API_DOMAIN = 'kodi-api.sosac.to';
const STREAMUJ_PLAYER_API = 'https://www.streamuj.tv/json_api_player.php';
const CINEMETA_BASE_URL = 'https://v3-cinemeta.strem.io';
const DIRECT_DIAGNOSTICS = process.env.DIRECT_DIAGNOSTICS !== '0';
const DIRECT_DIAGNOSTIC_SAMPLE_BYTES = 16 * 1024;
const HYBRID_APPLE_UA = /\bStremio-Apple\/0\.6\.5\b/i;
const SUBTITLE_CACHE_DIR = process.env.SUBTITLE_CACHE_DIR ||
    path.join(os.tmpdir(), 'sosac-subtitle-files');
const SUBTITLE_FILE_MAX_BYTES = 2 * 1024 * 1024;
const SUBTITLE_SOURCE_CACHE_MAX = 256;
const SUBTITLE_SOURCE_REFRESH_MS = 2 * 60 * 60 * 1000;

const manifest = {
    id: 'org.stremio.sosac.streamuj.subtitles.public',
    version: require('./package.json').version,
    name: 'Sosáč + Streamuj CZ Titulky',
    description: 'Komunitní doplněk s přímými titulky ze Sosáč / Streamuj.tv',
    types: ['movie', 'series'],
    idPrefixes: ['tt', 'sosac', 'sosac2', 'tmdb'],
    resources: ['subtitles'],
    catalogs: [],
    behaviorHints: {
        configurable: true,
        configurationRequired: true
    }
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
        hostname === 'www.sosac.tv' ||
        hostname === 'v3-cinemeta.strem.io';
}

function httpsGet(url, username, passMd5, customHeaders = {}, redirects = 0, timeoutMs = 20000) {
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
                    ? `pass=${encodeURIComponent(username)}%3A%3A%3A${passMd5}; sublanguage=1; quality=1; videolanguage=cs`
                    : 'sublanguage=1; quality=1; videolanguage=cs',
                ...customHeaders
            },
            timeout: timeoutMs
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
                        redirects + 1,
                        timeoutMs
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

    const text = String(value).replace(/^[SE]/i, '');
    if (!/^\d+$/.test(text)) return null;
    const n = Number(text);
    return Number.isSafeInteger(n) ? n : null;
}

function parseUserConfig(configStr) {
    if (!configStr || !configStr.includes(':')) {
        return null;
    }

    const splitAt = configStr.indexOf(':');
    const username = configStr.slice(0, splitAt);
    const passMd5 = configStr.slice(splitAt + 1);

    if (!username || /[\r\n;]/.test(username) || !/^[a-f0-9]{32}$/i.test(passMd5)) {
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


function safeHeaderValue(value, max = 240) {
    return String(value || '').replace(/[\r\n]+/g, ' ').slice(0, max);
}

function subtitleUrlShape(rawUrl) {
    try {
        const url = new URL(rawUrl);
        const last = url.pathname.split('/').filter(Boolean).pop() || '';
        const extMatch = last.match(/\.([a-z0-9]{1,8})$/i);
        return {
            host: url.hostname,
            pathExtension: extMatch ? `.${extMatch[1].toLowerCase()}` : 'none',
            queryKeys: Array.from(new Set(Array.from(url.searchParams.keys()))).sort(),
            hasQuery: Boolean(url.search),
            pathSegments: url.pathname.split('/').filter(Boolean).length
        };
    } catch (_) {
        return { host: 'invalid', pathExtension: 'none', queryKeys: [], hasQuery: false, pathSegments: 0 };
    }
}

function dispositionFileExtension(value) {
    const text = String(value || '');
    const match = text.match(/filename\*?=(?:UTF-8''|["'])?([^;"']+)/i);
    if (!match) return 'none';
    const name = decodeURIComponent(match[1].trim().replace(/^["']|["']$/g, ''));
    const ext = name.match(/\.([a-z0-9]{1,8})$/i);
    return ext ? `.${ext[1].toLowerCase()}` : 'none';
}

function detectSubtitleSample(buffer) {
    const raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
    const text = raw.toString('utf8').replace(/^\uFEFF/, '').trimStart();
    if (!text) return 'empty';
    if (/^WEBVTT(?:[ \t\r\n]|$)/i.test(text)) return 'webvtt';
    if (/^(?:\d+[ \t]*\r?\n)?(?:\d{1,3}:)?[0-5]\d:[0-5]\d[,.]\d{3}[ \t]*-->[ \t]*(?:\d{1,3}:)?[0-5]\d:[0-5]\d[,.]\d{3}/.test(text)) return 'srt';
    if (/^<!doctype\s+html|^<html\b|^<head\b|^<body\b/i.test(text)) return 'html';
    if (/^[{[]/.test(text)) return 'json-or-structured-text';
    return 'unknown-text';
}

function probeSubtitleRequest(rawUrl, creds, authenticated) {
    return new Promise((resolve) => {
        const startedAt = Date.now();
        const chain = [];
        let finished = false;

        const finish = result => {
            if (finished) return;
            finished = true;
            resolve({
                mode: authenticated ? 'authenticated' : 'anonymous',
                elapsedMs: Date.now() - startedAt,
                redirects: chain,
                ...result
            });
        };

        const requestUrl = (value, redirects) => {
            let target;
            try {
                target = new URL(validateSubtitleUrl(value));
            } catch (e) {
                finish({ ok: false, error: 'invalid-url' });
                return;
            }

            const headers = {
                'User-Agent': 'Stremio-Direct-Subtitle-Diagnostic/3.0',
                'Accept': 'text/vtt,text/plain,application/x-subrip,*/*',
                'Accept-Encoding': 'identity',
                'Range': `bytes=0-${DIRECT_DIAGNOSTIC_SAMPLE_BYTES - 1}`
            };

            if (authenticated) {
                headers.Referer = 'https://www.streamuj.tv/';
                headers.Cookie = `pass=${encodeURIComponent(creds.username)}%3A%3A%3A${creds.passMd5}; sublanguage=1; quality=1; videolanguage=cs`;
            }

            const req = https.get(target, { headers, timeout: 10000 }, res => {
                const status = res.statusCode || 0;
                const shape = subtitleUrlShape(target.toString());
                const redirectInfo = {
                    status,
                    host: shape.host,
                    pathExtension: shape.pathExtension
                };

                if ([301, 302, 303, 307, 308].includes(status)) {
                    const location = res.headers.location;
                    if (location) {
                        try {
                            const next = new URL(location, target);
                            const nextShape = subtitleUrlShape(next.toString());
                            redirectInfo.toHost = nextShape.host;
                            redirectInfo.toPathExtension = nextShape.pathExtension;
                        } catch (_) {
                            redirectInfo.toHost = 'invalid';
                        }
                    }
                    chain.push(redirectInfo);
                    res.resume();

                    if (!location || redirects >= 3) {
                        finish({ ok: false, status, error: !location ? 'redirect-without-location' : 'too-many-redirects' });
                        return;
                    }

                    let nextUrl;
                    try {
                        nextUrl = new URL(location, target).toString();
                        validateSubtitleUrl(nextUrl);
                    } catch (_) {
                        finish({ ok: false, status, error: 'redirect-to-disallowed-url' });
                        return;
                    }
                    requestUrl(nextUrl, redirects + 1);
                    return;
                }

                chain.push(redirectInfo);

                const chunks = [];
                let sampled = 0;
                res.on('data', chunk => {
                    if (sampled >= DIRECT_DIAGNOSTIC_SAMPLE_BYTES) return;
                    const part = Buffer.from(chunk);
                    const remaining = DIRECT_DIAGNOSTIC_SAMPLE_BYTES - sampled;
                    const piece = part.length > remaining ? part.subarray(0, remaining) : part;
                    chunks.push(piece);
                    sampled += piece.length;
                });
                res.on('end', () => {
                    const sample = Buffer.concat(chunks);
                    const finalShape = subtitleUrlShape(target.toString());
                    const contentType = safeHeaderValue(res.headers['content-type'], 120).toLowerCase();
                    const contentDisposition = safeHeaderValue(res.headers['content-disposition'], 240);
                    const detectedFormat = detectSubtitleSample(sample);
                    const contentTypeLooksSubtitle =
                        /text\/vtt|application\/x-subrip|application\/subrip|text\/plain/.test(contentType);

                    finish({
                        ok: status >= 200 && status < 300,
                        status,
                        finalHost: finalShape.host,
                        finalPathExtension: finalShape.pathExtension,
                        finalQueryKeys: finalShape.queryKeys,
                        contentType: contentType || 'missing',
                        dispositionExtension: dispositionFileExtension(contentDisposition),
                        contentLength: safeHeaderValue(res.headers['content-length'], 40) || 'missing',
                        contentRange: safeHeaderValue(res.headers['content-range'], 80) || 'missing',
                        acceptRanges: safeHeaderValue(res.headers['accept-ranges'], 80) || 'missing',
                        cors: safeHeaderValue(res.headers['access-control-allow-origin'], 120) || 'missing',
                        server: safeHeaderValue(res.headers.server, 120) || 'missing',
                        detectedFormat,
                        sampleBytes: sample.length,
                        usableAsSubtitle: status >= 200 && status < 300 &&
                            (detectedFormat === 'webvtt' || detectedFormat === 'srt' || contentTypeLooksSubtitle)
                    });
                });
                res.on('error', err => finish({ ok: false, status, error: `response-${err.code || 'error'}` }));
            });

            req.on('timeout', () => {
                req.destroy();
                finish({ ok: false, error: 'timeout' });
            });
            req.on('error', err => finish({ ok: false, error: `request-${err.code || 'error'}` }));
        };

        requestUrl(rawUrl, 0);
    });
}

async function diagnoseDirectSubtitleTracks(foundSubs, creds, req, videoId) {
    if (!DIRECT_DIAGNOSTICS) return;

    const client = {
        userAgent: safeHeaderValue(req.headers['user-agent'], 300) || 'missing',
        accept: safeHeaderValue(req.headers.accept, 200) || 'missing',
        acceptLanguage: safeHeaderValue(req.headers['accept-language'], 120) || 'missing',
        origin: safeHeaderValue(req.headers.origin, 160) || 'missing',
        refererHost: (() => {
            try {
                return req.headers.referer ? new URL(req.headers.referer).hostname : 'missing';
            } catch (_) {
                return 'invalid';
            }
        })()
    };
    console.log('[DIRECT DIAG CLIENT]', JSON.stringify(client));

    const tracks = (Array.isArray(foundSubs) ? foundSubs : []).slice(0, 3);
    for (let i = 0; i < tracks.length; i++) {
        const sub = tracks[i];
        const shape = subtitleUrlShape(sub.sourceUrl);
        const [anonymous, authenticated] = await Promise.all([
            probeSubtitleRequest(sub.sourceUrl, creds, false),
            probeSubtitleRequest(sub.sourceUrl, creds, true)
        ]);

        console.log('[DIRECT DIAG]', JSON.stringify({
            videoId,
            track: i + 1,
            lang: sub.lang || 'und',
            sourceKind: sub.sourceKind || 'html',
            urlShape: shape,
            anonymous,
            authenticated
        }));
    }
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

    // Odkaz v poli l patří danému filmu/epizodě a má přednost
    // před dalšími odkazy v metadatech.
    if (ep && ep.l) recursiveSearch(ep.l);
    recursiveSearch(ep);

    return {
        ids: Array.from(ids),
        directSubs: Array.from(directSubs),
        mp4Urls: Array.from(mp4Urls)
    };
}

// ============================================================
// STREAMUJ – JSON PLAYER API (podle Kodi Sosac Unofficial)
// ============================================================
// Kodi: resources/lib/stream_api.py, get_video_links().
// Heslo v naší konfiguraci už je MD5 původního hesla. Znovu ho
// nehashujeme. Přihlašovací údaje posíláme jen upstream přes HTTPS.

function isRecord(value) {
    return value !== null && typeof value === 'object' &&
        !Array.isArray(value);
}

function normalizeSubtitleLanguage(value) {
    const key = String(value || '').trim().normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const aliases = {
        cs: 'cze', cz: 'cze', ces: 'cze', cze: 'cze',
        czech: 'cze', cesky: 'cze', cestina: 'cze',
        sk: 'slk', slk: 'slk', slo: 'slk',
        slovak: 'slk', slovensky: 'slk', slovencina: 'slk', slovenstina: 'slk',
        en: 'eng', eng: 'eng', english: 'eng', anglicky: 'eng', anglictina: 'eng',
        de: 'ger', deu: 'ger', ger: 'ger', german: 'ger',
        fr: 'fre', fra: 'fre', fre: 'fre', french: 'fre',
        es: 'spa', spa: 'spa', spanish: 'spa',
        it: 'ita', ita: 'ita', italian: 'ita',
        pl: 'pol', pol: 'pol', polish: 'pol',
        hu: 'hun', hun: 'hun', hungarian: 'hun',
        ru: 'rus', rus: 'rus', russian: 'rus',
        uk: 'ukr', ukr: 'ukr', ukrainian: 'ukr',
        pt: 'por', por: 'por', portuguese: 'por',
        nl: 'dut', nld: 'dut', dut: 'dut', dutch: 'dut',
        ro: 'rum', ron: 'rum', rum: 'rum', romanian: 'rum',
        hr: 'hrv', hrv: 'hrv', croatian: 'hrv',
        sr: 'srp', srp: 'srp', serbian: 'srp',
        sl: 'slv', slv: 'slv', slovenian: 'slv',
        da: 'dan', dan: 'dan', danish: 'dan',
        sv: 'swe', swe: 'swe', swedish: 'swe',
        no: 'nor', nor: 'nor', norwegian: 'nor',
        fi: 'fin', fin: 'fin', finnish: 'fin',
        tr: 'tur', tur: 'tur', turkish: 'tur',
        el: 'gre', ell: 'gre', gre: 'gre', greek: 'gre',
        ja: 'jpn', jpn: 'jpn', japanese: 'jpn',
        ko: 'kor', kor: 'kor', korean: 'kor',
        zh: 'chi', zho: 'chi', chi: 'chi', chinese: 'chi'
    };
    return aliases[key] || null;
}

function subtitleLanguageName(lang) {
    return ({ cze: 'čeština', slk: 'slovenština', eng: 'angličtina', und: 'neurčený jazyk',
        ger: 'němčina', fre: 'francouzština', spa: 'španělština',
        ita: 'italština', pol: 'polština', hun: 'maďarština',
        rus: 'ruština', ukr: 'ukrajinština' })[lang] || lang;
}

// Přijímáme jen URL ze skutečného pole subtitles, nikoli video streamy.
// Neznámý jazyk nevydáváme za češtinu. Duplicitní URL přeskočíme.
function parsePlayerSubtitleTracks(data, videoId) {
    if (!isRecord(data) || !isRecord(data.URL)) {
        throw new Error('Streamuj API nevrátilo očekávanou strukturu URL.');
    }
    const tracks = [];
    const seen = new Set();
    for (const [audio, variants] of Object.entries(data.URL)) {
        if (!isRecord(variants) || !isRecord(variants.subtitles)) continue;
        for (const [language, rawUrl] of Object.entries(variants.subtitles)) {
            if (typeof rawUrl !== 'string') continue;
            const lang = normalizeSubtitleLanguage(language);
            if (!lang) continue;
            let sourceUrl;
            try {
                sourceUrl = normalizeSubtitleUrl(rawUrl);
            } catch (_) {
                continue;
            }
            const key = `${lang}:${sourceUrl}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const audioLabel = String(audio).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 20);
            const name = subtitleLanguageName(lang) +
                (audioLabel ? ` (${audioLabel})` : '');
            tracks.push({
                id: `streamuj_api_${videoId}_${tracks.length}`,
                sourceUrl,
                lang,
                file_name: `Streamuj.tv - ${name}.vtt`,
                sourceKind: 'player-api',
                videoId
            });
        }
    }
    const priority = { cze: 0, slk: 1, eng: 2 };
    tracks.sort((a, b) => (priority[a.lang] ?? 3) - (priority[b.lang] ?? 3));
    return tracks.slice(0, 12);
}

async function fetchSubtitlesFromPlayerApi(videoId, username, passMd5) {
    if (!/^[a-zA-Z0-9]{15,40}$/.test(String(videoId))) {
        throw new Error('Neplatné Streamuj ID.');
    }
    if (!username || !/^[a-f0-9]{32}$/i.test(passMd5 || '')) {
        throw new Error('Chybí platná konfigurace Streamuj.');
    }
    const url = new URL(STREAMUJ_PLAYER_API);
    url.searchParams.set('action', 'get-video-links');
    url.searchParams.set('d', '19');
    url.searchParams.set('link', String(videoId));
    url.searchParams.set('login', username);
    url.searchParams.set('password', passMd5);
    url.searchParams.set('location',
        process.env.STREAMUJ_LOCATION === '2' ? '2' : '1');

    // URL se záměrně neloguje: obsahuje přihlašovací hash.
    console.log(`[PLAYER API] Načítám Streamuj ID: ${videoId}`);
    const raw = await httpsGet(url.toString(), username, passMd5, {
        'Accept': 'application/json,text/plain,*/*',
        'Referer': `https://www.streamuj.tv/video/${videoId}`
    }, 0, 30000);
    const data = safeJsonParse(raw);
    if (!isRecord(data) || (data.errormessage && data.errormessage !== '0')) {
        throw new Error('Streamuj API hlásí chybu nebo nevrátilo JSON.');
    }
    return parsePlayerSubtitleTracks(data, videoId);
}

// JSON Player API d=19 je první cesta. HTML zůstává pouze jako záloha
// pro dohledání přímé URL u starších videí nebo při změně dostupnosti API.
async function fetchSubtitlesFromStreamuj(videoId, username, passMd5, req) {
    try {
        const subtitles = await fetchSubtitlesFromPlayerApi(
            videoId, username, passMd5);
        if (subtitles.length) {
            console.log(`[PLAYER API] Nalezeno titulků: ${subtitles.length}`);
            return subtitles;
        }
        console.log('[PLAYER API] Žádné podporované titulky; zkouším HTML.');
    } catch (e) {
        console.warn(`[PLAYER API] ${e.message}; zkouším HTML.`);
    }
    return fetchSubtitlesFromHtml(videoId, username, passMd5, req);
}

// ============================================================
// STREAMUJ – VYHLEDÁNÍ TITULKŮ
// ============================================================

async function fetchSubtitlesFromHtml(
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

            const lang = normalizeSubtitleLanguage(subLang) || 'und';
            const key = `${lang}:${sourceUrl}`;
            if (seenUrls.has(key)) {
                return;
            }

            seenUrls.add(key);

            subtitles.push({
                id,
                sourceUrl,
                lang,
                file_name: `Streamuj.tv - ${subtitleLanguageName(lang)}.vtt`,
                sourceKind: 'html',
                videoId
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

        // Projdeme všechny stopy: čeština nemusí být v sub0.
        const subRegex = /\bsub\d+\s*:\s*["']([^"']+)["']/gi;
        let match;
        while ((match = subRegex.exec(html)) !== null) {
            const val = decodeHtmlEntities(match[1]);
            const splitAt = val.indexOf('>');

            if (splitAt >= 0) {
                const subLang =
                    val.slice(0, splitAt).trim();

                const rawSubUrl =
                    val.slice(splitAt + 1).trim();

                if (rawSubUrl.includes('streamuj=subtitles') ||
                    /\.(srt|vtt)(?:\?|$)/i.test(rawSubUrl)) {
                    addSubtitle(
                        rawSubUrl,
                        subLang,
                        `streamuj_${videoId}_${subtitles.length}`
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
                    '',
                    `streamuj_fb_${videoId}_${subtitles.length}`
                );
            }
        }

    } catch (e) {
        console.error(
            `[Subtitle] Streamuj ${videoId} chyba: ${e.message}`
        );
    }

    console.log(`[Subtitle] Nalezeno titulků: ${subtitles.length}`);
    const priority = { cze: 0, slk: 1, eng: 2 };
    return subtitles.sort((a, b) => (priority[a.lang] ?? 3) - (priority[b.lang] ?? 3))
        .slice(0, 12);
}

// ============================================================
// IMDb -> SOSÁČ RESOLVER
// ============================================================
// Stremio často žádá titulky pod IMDb ID (tt...). Kodi API Sosáče ale
// detail filmu/seriálu očekává pod interním Sosáč ID. Pro IMDb požadavek
// proto načteme metadata z Cinemety, vyhledáme kandidáty v Sosáči a
// preferujeme přesnou shodu IMDb pole; název + rok slouží jako fallback.

const imdbResolveCache = new Map();

function normalizeTitleForMatch(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function uniqueTitleStrings(values) {
    const seen = new Set();
    const result = [];
    for (const value of values || []) {
        const text = String(value || '').trim();
        const key = normalizeTitleForMatch(text);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        result.push(text);
    }
    return result;
}

function titleMatchScore(a, b) {
    const left = normalizeTitleForMatch(a);
    const right = normalizeTitleForMatch(b);
    if (!left || !right) return 0;
    if (left === right) return 1;
    if (left.startsWith(right) || right.startsWith(left)) return 0.9;
    if (left.includes(right) || right.includes(left)) return 0.82;

    const aa = new Set(left.split(' ').filter(Boolean));
    const bb = new Set(right.split(' ').filter(Boolean));
    if (!aa.size || !bb.size) return 0;
    let common = 0;
    for (const token of aa) if (bb.has(token)) common++;
    return common / Math.max(aa.size, bb.size);
}

function collectSosacTitles(item) {
    const values = [];
    const add = value => {
        if (typeof value === 'string') values.push(value);
        else if (Array.isArray(value)) value.forEach(add);
        else if (isRecord(value)) Object.values(value).forEach(add);
    };
    add(item && item.n);
    add(item && item.originalName);
    add(item && item.title);
    return uniqueTitleStrings(values);
}

function normalizeImdbCandidate(value) {
    if (typeof value === 'string') {
        const text = value.trim();
        const match = text.match(/\btt\d{5,10}\b/i);
        if (match) return match[0].toLowerCase();
        if (/^\d{5,10}$/.test(text)) return `tt${text.padStart(7, '0')}`.toLowerCase();
        return null;
    }
    if (typeof value === 'number' && Number.isInteger(value) && value >= 10000) {
        const text = String(value);
        if (text.length <= 10) return `tt${text.padStart(7, '0')}`.toLowerCase();
    }
    return null;
}

function extractSosacImdbId(item) {
    if (!isRecord(item)) return null;
    for (const key of ['imdb', 'imdb_id', 'imdbId', 'imdbid', 'imdbID', 'm']) {
        if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
        const found = normalizeImdbCandidate(item[key]);
        if (found) return found;
    }
    return null;
}

function metadataYear(meta) {
    const direct = Number(meta && meta.year);
    if (Number.isFinite(direct) && direct > 1800) return Math.trunc(direct);
    const match = String(meta && meta.releaseInfo || '').match(/\b(18|19|20|21)\d{2}\b/);
    return match ? Number(match[0]) : undefined;
}

function sosacCandidateScore(item, wantedTitles, year) {
    const candidateTitles = collectSosacTitles(item);
    let score = 0;
    for (const wanted of wantedTitles) {
        for (const candidate of candidateTitles) {
            score = Math.max(score, titleMatchScore(wanted, candidate));
        }
    }

    const candidateYear = Number(item && item.y);
    if (year && Number.isFinite(candidateYear) && candidateYear > 1800) {
        const diff = Math.abs(year - Math.trunc(candidateYear));
        if (diff === 0) score += 0.12;
        else if (diff === 1) score += 0.06;
        else if (diff >= 3) score -= 0.20;
    }
    return score;
}

function readImdbResolveCache(key) {
    const entry = imdbResolveCache.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
        imdbResolveCache.delete(key);
        return undefined;
    }
    return entry.value;
}

function writeImdbResolveCache(key, value, ttlMs) {
    imdbResolveCache.set(key, { value, expiresAt: Date.now() + ttlMs });
    while (imdbResolveCache.size > 512) {
        imdbResolveCache.delete(imdbResolveCache.keys().next().value);
    }
}

async function fetchCinemetaMeta(type, imdbId) {
    try {
        const endpoint = `${CINEMETA_BASE_URL}/meta/${type}/${encodeURIComponent(imdbId)}.json`;
        const raw = await httpsGet(endpoint, '', '', {
            'Accept': 'application/json,text/plain,*/*'
        }, 0, 10000);
        const data = safeJsonParse(raw);
        return {
            meta: isRecord(data) && isRecord(data.meta) ? data.meta : null,
            technicalError: false
        };
    } catch (e) {
        console.warn(`[IMDB RESOLVE] Cinemeta ${type}/${imdbId} selhala: ${e.message}`);
        return {
            meta: null,
            technicalError: true
        };
    }
}

async function searchSosac(type, query, username, passMd5) {
    const collection = type === 'movie' ? 'movies' : 'serials';
    const url = new URL(`https://${SOSAC_API_DOMAIN}/${collection}/simple-search`);
    url.searchParams.set('q', String(query || '').trim());
    url.searchParams.set('pocet', '100');
    url.searchParams.set('stranka', '1');

    const raw = await httpsGet(url.toString(), username, passMd5, {
        'Referer': 'https://sosac.tv/',
        'Origin': 'https://sosac.tv/',
        'Accept': 'application/json,text/plain,*/*'
    });
    const data = safeJsonParse(raw);
    if (Array.isArray(data)) return data;
    if (!isRecord(data)) return [];
    for (const key of ['items', 'results', 'movies', 'serials']) {
        if (Array.isArray(data[key])) return data[key];
    }
    return [];
}

async function resolveSosacIdFromImdb(type, imdbId, creds) {
    const normalizedImdb = String(imdbId || '').toLowerCase();
    if (!/^tt\d{5,10}$/.test(normalizedImdb)) return null;

    const cacheKey = `${type}:${normalizedImdb}`;
    const cached = readImdbResolveCache(cacheKey);
    if (cached !== undefined) return cached;

    const cinemetaResult = await fetchCinemetaMeta(type, normalizedImdb);
    const meta = cinemetaResult.meta;
    if (!meta) {
        if (cinemetaResult.technicalError) {
            console.log(`[IMDB RESOLVE] ${type} ${normalizedImdb}: technická chyba Cinemety se necachuje`);
            return null;
        }
        writeImdbResolveCache(cacheKey, null, 30 * 60 * 1000);
        return null;
    }

    const wantedTitles = uniqueTitleStrings([
        meta.name,
        meta.originalName,
        ...(Array.isArray(meta.nameTranslations) ? meta.nameTranslations : [])
    ]);
    const year = metadataYear(meta);
    let best = null;
    let bestScore = -1;

    for (const title of wantedTitles.slice(0, 4)) {
        let results = [];
        try {
            results = await searchSosac(type, title, creds.username, creds.passMd5);
        } catch (e) {
            console.warn(`[IMDB RESOLVE] Sosáč search "${title}" selhal: ${e.message}`);
            continue;
        }

        for (const item of results) {
            if (!isRecord(item) || item._id === undefined || item._id === null) continue;

            const itemImdb = extractSosacImdbId(item);
            if (itemImdb === normalizedImdb) {
                const resolved = String(item._id);
                console.log(`[IMDB RESOLVE] ${type} ${normalizedImdb} -> Sosáč ${resolved} (IMDb match)`);
                writeImdbResolveCache(cacheKey, resolved, 12 * 60 * 60 * 1000);
                return resolved;
            }

            const score = sosacCandidateScore(item, wantedTitles, year);
            if (score > bestScore) {
                best = item;
                bestScore = score;
            }
        }

        if (bestScore >= 1.05) break;
    }

    if (!best || bestScore < 0.68) {
        console.log(`[IMDB RESOLVE] ${type} ${normalizedImdb}: Sosáč shoda nenalezena`);
        writeImdbResolveCache(cacheKey, null, 30 * 60 * 1000);
        return null;
    }

    const resolved = String(best._id);
    console.log(`[IMDB RESOLVE] ${type} ${normalizedImdb} -> Sosáč ${resolved} (score ${bestScore.toFixed(2)})`);
    writeImdbResolveCache(cacheKey, resolved, 12 * 60 * 60 * 1000);
    return resolved;
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

    if (!isRecord(data)) return null;

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

        return isRecord(data) ? data.item || data.episode || data : null;
    } catch (e) {
        console.error(`[Sosac] Series chyba: ${e.message}`);
        return null;
    }
}

async function resolveSosacEpisode(id, season, episode, creds, skipDirectLookup = false) {
    const direct = skipDirectLookup
        ? null
        : await fetchSosacSeriesRaw(id, creds.username, creds.passMd5);
    const hasPosition = season !== null && episode !== null;
    if (direct && (!hasPosition ||
        (normalizeInt(direct.s) === season && normalizeInt(direct.ep) === episode))) {
        return direct;
    }
    if (!hasPosition) return null;

    // Některé video doplňky posílají ID seriálu + řadu a díl.
    // Kodi API vrací detail seriálu jako { info, "3": { "7": epizoda } }.
    console.log(`[Series] Dohledávám řadu ${season}, díl ${episode} v seriálu ${id}.`);
    try {
        const raw = await httpsGet(
            `https://${SOSAC_API_DOMAIN}/serials/${encodeURIComponent(id)}`,
            creds.username, creds.passMd5,
            { 'Referer': 'https://sosac.tv/', 'Accept': 'application/json' }
        );
        const data = safeJsonParse(raw);
        const selected = data && data[String(season)] && data[String(season)][String(episode)];
        if (!isRecord(selected)) return null;
        if ((selected.s !== undefined && normalizeInt(selected.s) !== season) ||
            (selected.ep !== undefined && normalizeInt(selected.ep) !== episode)) return null;
        return selected;
    } catch (e) {
        console.warn(`[Series] Detail seriálu není dostupný: ${e.message}`);
        return null;
    }
}

// ============================================================
// HYBRIDNÍ KOMPATIBILITA – PŘÍMÝ ODKAZ + VTT FALLBACK
// ============================================================

function convertSrtToVtt(content) {
    const text = String(content ?? '')
        .replace(/^\uFEFF/, '')
        .replace(/\r\n?/g, '\n')
        .trim();

    if (!text) throw new Error('Prázdný soubor titulků.');
    if (/^WEBVTT(?:[ \t]|\n|$)/i.test(text)) return text + '\n';

    const timeRegex =
        /^(?:(\d+):)?([0-5]\d):([0-5]\d)[,.](\d{3})[ \t]*-->[ \t]*(?:(\d+):)?([0-5]\d):([0-5]\d)[,.](\d{3})([ \t]+.*)?$/;
    const lines = text.split('\n');
    const cues = [];
    let current = null;

    const formatTime = (h, m, s, ms) =>
        String(Number(h || 0)).padStart(2, '0') + ':' + m + ':' + s + '.' + ms;

    const finishCue = () => {
        if (!current) return;
        const body = current.body.join('\n')
            .replace(/\n[ \t]*\n+/g, '\n')
            .trim();
        if (body) cues.push(current.time + '\n' + body);
        current = null;
    };

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
                time: formatTime(match[1], match[2], match[3], match[4]) +
                    ' --> ' +
                    formatTime(match[5], match[6], match[7], match[8]) +
                    (match[9] || ''),
                body: []
            };
            continue;
        }

        if (current) {
            if (line.includes('-->')) {
                throw new Error('Neplatný časový řádek SRT.');
            }
            current.body.push(line);
        } else if (line.trim()) {
            throw new Error('Neznámý text před prvním titulkem.');
        }
    }

    finishCue();
    if (!cues.length) throw new Error('V SRT nebyly nalezeny žádné titulky.');
    return 'WEBVTT\n\n' + cues.join('\n\n') + '\n';
}

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
        throw new Error('Streamuj nevrátil platná textová data titulků.');
    }

    const vtt = convertSrtToVtt(subData);
    if (!/^WEBVTT(?:[ \t]|\n|$)/i.test(vtt)) {
        throw new Error('Nepodařilo se vytvořit WebVTT.');
    }

    const body = Buffer.from(vtt, 'utf8');
    if (!body.length || body.length > SUBTITLE_FILE_MAX_BYTES) {
        throw new Error('Neplatná velikost WebVTT.');
    }
    return body;
}

const subtitleFileSecret = crypto.randomBytes(32);
const subtitleBySource = new Map();
const subtitleFilePending = new Map();

function subtitleFileSourceKey(sourceUrl, creds) {
    return crypto.createHmac('sha256', subtitleFileSecret)
        .update(JSON.stringify([sourceUrl, creds.username, creds.passMd5]))
        .digest('hex');
}

function subtitleFilePath(hash) {
    return path.join(SUBTITLE_CACHE_DIR, `${hash}.vtt`);
}

async function readSubtitleFile(hash) {
    try {
        const body = await fs.promises.readFile(subtitleFilePath(hash));
        if (!body.length || body.length > SUBTITLE_FILE_MAX_BYTES) return null;
        if (crypto.createHash('sha256').update(body).digest('hex') !== hash) return null;
        return body;
    } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
    }
}

async function storeSubtitleFile(body) {
    const hash = crypto.createHash('sha256').update(body).digest('hex');
    if (await readSubtitleFile(hash)) return hash;

    await fs.promises.mkdir(SUBTITLE_CACHE_DIR, { recursive: true });
    const temporary = path.join(
        SUBTITLE_CACHE_DIR,
        `.subtitle-${crypto.randomBytes(12).toString('hex')}.tmp`
    );

    try {
        await fs.promises.writeFile(temporary, body, { flag: 'wx', mode: 0o600 });
        try {
            await fs.promises.rename(temporary, subtitleFilePath(hash));
        } catch (e) {
            if (e.code !== 'EEXIST') throw e;
        }
    } finally {
        await fs.promises.rm(temporary, { force: true });
    }
    return hash;
}

async function prepareCompatibilitySubtitleFile(sub, creds, req) {
    const sourceUrl = validateSubtitleUrl(sub.sourceUrl);
    const key = subtitleFileSourceKey(sourceUrl, creds);
    const cached = subtitleBySource.get(key);
    let hash = cached &&
        Date.now() - cached.checkedAt < SUBTITLE_SOURCE_REFRESH_MS
        ? cached.hash : null;

    if (hash && !(await readSubtitleFile(hash))) {
        subtitleBySource.delete(key);
        hash = null;
    }

    if (!hash) {
        let pending = subtitleFilePending.get(key);
        if (!pending) {
            pending = (async () => {
                const body = await downloadSubtitleVtt(
                    sourceUrl, creds.username, creds.passMd5
                );
                const result = await storeSubtitleFile(body);
                subtitleBySource.delete(key);
                subtitleBySource.set(key, {
                    hash: result,
                    checkedAt: Date.now()
                });
                while (subtitleBySource.size > SUBTITLE_SOURCE_CACHE_MAX) {
                    subtitleBySource.delete(subtitleBySource.keys().next().value);
                }
                console.log(`[SUBTITLE HYBRID FILE] Připraven WebVTT: ${body.length} B, hash=${result.slice(0, 12)}`);
                return result;
            })();
            subtitleFilePending.set(key, pending);
        }

        try {
            hash = await pending;
        } finally {
            if (subtitleFilePending.get(key) === pending) {
                subtitleFilePending.delete(key);
            }
        }
    }

    const publicPath =
        `/stremio-sosac-subtitles/subtitle-file/v1/${hash}.vtt`;
    return {
        id: `sosac-hybrid-${sub.lang || 'und'}-${hash.slice(0, 12)}`,
        lang: sub.lang || 'und',
        url: new URL(publicPath, getBaseUrl(req)).toString(),
        delivery: 'proxy-vtt'
    };
}

function shouldUseCompatibilityProxy(req, sub) {
    const ua = String(req.headers['user-agent'] || '');
    if (!HYBRID_APPLE_UA.test(ua)) return false;

    const shape = subtitleUrlShape(sub.sourceUrl);
    // Stremio-Apple 0.6.5 může vracet unsupportedFileType("NULL")
    // u Streamuj URL bez přípony a bez názvu souboru.
    return shape.pathExtension === 'none';
}

function sendVtt(req, res, body) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="subtitles.vtt"');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader(
        'Access-Control-Expose-Headers',
        'Content-Length, Content-Range, Accept-Ranges, Content-Disposition'
    );

    if (req.method === 'GET' &&
        /^bytes=/i.test(req.headers.range || '') &&
        !req.headers['if-range']) {
        const ranges = req.range(body.length, { combine: true });

        if (ranges === -1) {
            res.setHeader('Content-Range', `bytes */${body.length}`);
            res.setHeader('Content-Length', 0);
            return res.status(416).end();
        }

        if (Array.isArray(ranges) &&
            String(ranges.type).toLowerCase() === 'bytes' &&
            ranges.length === 1) {
            const { start, end } = ranges[0];
            const part = body.subarray(start, end + 1);
            res.status(206);
            res.setHeader(
                'Content-Range',
                `bytes ${start}-${end}/${body.length}`
            );
            res.setHeader('Content-Length', part.length);
            return res.end(part);
        }
    }

    res.setHeader('Content-Length', body.length);
    if (req.method === 'HEAD') return res.end();
    return res.end(body);
}

app.get('/subtitle-file/v1/:hash.vtt', async (req, res) => {
    const hash = String(req.params.hash || '');
    traceSubtitleHttp(req, res, {
        resource: 'hybrid-file',
        hash: hash.slice(0, 12)
    });

    if (!/^[a-f0-9]{64}$/i.test(hash)) {
        return res.status(404).type('text/plain').send('Titulky nenalezeny.');
    }

    try {
        const body = await readSubtitleFile(hash.toLowerCase());
        if (!body) {
            return res.status(404)
                .type('text/plain')
                .send('Titulky už nejsou v cache.');
        }

        console.log(`[SUBTITLE HYBRID SERVE] hash=${hash.slice(0, 12)} bytes=${body.length} ua=${safeHeaderValue(req.headers['user-agent'], 120) || 'missing'}`);
        return sendVtt(req, res, body);
    } catch (e) {
        console.error(`[SUBTITLE HYBRID SERVE] ${e.message}`);
        return res.status(500).type('text/plain').send('Chyba titulků.');
    }
});

// ============================================================
// PŘÍMÉ TITULKY – STREAMUJ -> STREMIO
// ============================================================

// Server pouze dohledá správnou Streamuj URL. Samotný soubor titulků
// se nestahuje, nepřevádí ani necachuje na našem serveru.
function traceSubtitleHttp(req, res, resource) {
    const requestId = crypto.randomBytes(6).toString('hex');
    const startedAt = process.hrtime.bigint();
    res.locals.subtitleRequestId = requestId;
    const log = (event, details = {}) => console.log('[SUBTITLE HTTP]',
        JSON.stringify({
            requestId,
            event,
            method: req.method,
            ...resource,
            elapsedMs: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6),
            ...details
        }));

    log('START');
    res.once('finish', () => log('FINISH', {
        status: res.statusCode,
        bytes: Number(res.getHeader('Content-Length') || 0)
    }));
    res.once('close', () => {
        if (!res.writableFinished) log('CLOSED_BEFORE_FINISH');
    });
}

function prepareDirectSubtitleTracks(foundSubs) {
    const seen = new Set();
    const direct = [];

    for (const sub of Array.isArray(foundSubs) ? foundSubs : []) {
        try {
            const url = validateSubtitleUrl(sub.sourceUrl);
            const lang = sub.lang || 'und';
            const key = `${lang}:${url}`;
            if (seen.has(key)) continue;
            seen.add(key);
            direct.push({
                id: `sosac-direct-${lang}-${direct.length + 1}`,
                lang,
                url
            });
        } catch (_) {
            // Neplatné nebo nepovolené zdrojové URL pouze přeskočíme.
        }
    }

    const priority = { cze: 0, slk: 1, eng: 2 };
    return direct
        .sort((a, b) => (priority[a.lang] ?? 3) - (priority[b.lang] ?? 3))
        .slice(0, 12);
}

async function prepareHybridSubtitleTracks(req, foundSubs, creds) {
    const source = Array.isArray(foundSubs) ? foundSubs : [];
    const direct = prepareDirectSubtitleTracks(source);
    if (!source.length || !HYBRID_APPLE_UA.test(String(req.headers['user-agent'] || ''))) {
        return direct;
    }

    const result = [];
    const seen = new Set();

    for (const sub of source.slice(0, 12)) {
        let track = null;

        if (shouldUseCompatibilityProxy(req, sub)) {
            try {
                track = await prepareCompatibilitySubtitleFile(sub, creds, req);
                console.log(`[SUBTITLE HYBRID] Apple 0.6.5 + URL bez přípony -> VTT fallback (${sub.lang || 'und'})`);
            } catch (e) {
                console.error(`[SUBTITLE HYBRID] VTT fallback selhal: ${e.message}; vracím direct.`);
            }
        }

        if (!track) {
            try {
                const url = validateSubtitleUrl(sub.sourceUrl);
                track = {
                    id: `sosac-direct-${sub.lang || 'und'}-${result.length + 1}`,
                    lang: sub.lang || 'und',
                    url,
                    delivery: 'direct'
                };
            } catch (_) {
                continue;
            }
        }

        const key = `${track.lang}:${track.url}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(track);
    }

    const priority = { cze: 0, slk: 1, eng: 2 };
    return result
        .sort((a, b) => (priority[a.lang] ?? 3) - (priority[b.lang] ?? 3))
        .slice(0, 12);
}

async function findDirectSubtitles(req, targetData, creds) {
    const extracted = extractAllStreamujIds(targetData);

    for (const videoId of extracted.ids.slice(0, 10)) {
        const found = await fetchSubtitlesFromStreamuj(
            videoId, creds.username, creds.passMd5, req
        );

        if (found.length && DIRECT_DIAGNOSTICS) {
            await diagnoseDirectSubtitleTracks(found, creds, req, videoId);
        }

        const prepared = await prepareHybridSubtitleTracks(
            req, found, creds
        );

        if (prepared.length) {
            const hybridCount = prepared.filter(
                sub => sub.delivery === 'proxy-vtt'
            ).length;
            if (hybridCount) {
                console.log(`[SUBTITLE HYBRID] Streamuj ID ${videoId}: ${prepared.length} stop, proxy-vtt=${hybridCount}`);
            } else {
                console.log(`[SUBTITLE DIRECT] Streamuj ID ${videoId}: ${prepared.length} stop`);
            }
            return prepared;
        }
    }

    return [];
}

// Stremio dostává pouze přímé Streamuj URL.
// Do logu záměrně nezapisujeme celé adresy ani jejich query parametry.
function buildSubtitleResponse(req, res, subtitles) {
    const result = {
        subtitles: subtitles.map(sub => ({
            id: sub.id,
            lang: sub.lang,
            url: sub.url
        }))
    };

    console.log('[FINAL RESPONSE]', JSON.stringify({
        requestId: res.locals.subtitleRequestId,
        count: result.subtitles.length,
        tracks: subtitles.map(sub => ({
            id: sub.id,
            lang: sub.lang,
            delivery: sub.delivery || (String(sub.url || '').includes('/subtitle-file/v1/') ? 'proxy-vtt' : 'direct'),
            pathExtension: subtitleUrlShape(sub.url).pathExtension
        }))
    }));

    return result;
}

// Krátká cache omezuje opakované dotazy na Sosáč/Streamuj.
// Přímé URL držíme jen 2 minuty, stejně jako hlavní addon 0.5.0.
const subtitleLookupCache = new Map();
const subtitleLookupPending = new Map();
const subtitleLookupSecret = crypto.randomBytes(32);

function subtitleLookupKey(req, creds, identity) {
    return crypto.createHmac('sha256', subtitleLookupSecret)
        .update(JSON.stringify([
            getBaseUrl(req),
            identity.type,
            identity.id,
            creds.username,
            creds.passMd5
        ]))
        .digest('hex');
}

async function resolveSubtitleRequest(req, creds, identity, lookup) {
    const key = subtitleLookupKey(req, creds, identity);
    const cached = subtitleLookupCache.get(key);

    if (cached && Date.now() - cached.createdAt < 2 * 60 * 1000) {
        console.log('[SUBTITLE LOOKUP] Používám krátkou direct cache.');
        return cached.subtitles;
    }

    subtitleLookupCache.delete(key);

    let pending = subtitleLookupPending.get(key);
    if (!pending) {
        pending = (async () => {
            const subtitles = await lookup();
            if (subtitles.length) {
                subtitleLookupCache.set(key, {
                    subtitles,
                    createdAt: Date.now()
                });
                while (subtitleLookupCache.size > 128) {
                    subtitleLookupCache.delete(
                        subtitleLookupCache.keys().next().value
                    );
                }
            }
            return subtitles;
        })();
        subtitleLookupPending.set(key, pending);
    }

    try {
        return await pending;
    } finally {
        if (subtitleLookupPending.get(key) === pending) {
            subtitleLookupPending.delete(key);
        }
    }
}

// ============================================================
// KONFIGURAČNÍ STRÁNKA
// ============================================================

app.get('/:config/configure', (req, res) => {
    res.redirect('/configure');
});

app.get(['/', '/configure'], (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="cs">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CZ Titulky pro Stremio konfigurace</title>
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
<h1>CZ Titulky pro Stremio konfigurace</h1>
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
        var path = '/stremio-sosac-subtitles/' + encodeURIComponent(u) + ':' + md5 + '/manifest.json';
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
// STREMIO SDK: MANIFEST AND SUBTITLE RESOURCE
// ============================================================
// The SDK owns the subtitle resource routing and handler interface.
// A small Express adapter preserves the existing username:MD5 installation
// URLs and accepts both path-style and query-style extra parameters.
// The custom configuration page remains unchanged.
const subtitleRequestContext = new AsyncLocalStorage();
const builder = new addonBuilder(manifest);

function normalizeSubtitleExtras(extra) {
    const normalized = {};
    if (!isRecord(extra)) return normalized;
    for (const [key, rawValue] of Object.entries(extra)) {
        const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
        if (typeof value !== 'string') continue;
        normalized[key] = value;
    }
    if (normalized.videoHash) normalized.videoHash = normalized.videoHash.trim().toLowerCase();
    if (normalized.videoSize) normalized.videoSize = normalized.videoSize.trim();
    return normalized;
}

// The SDK expects /subtitles/type/id/filename=...&videoHash=....json.
// Some clients send the same parameters after .json instead. Normalize that
// variant before the SDK router parses it. Decode once and re-encode once,
// so an encoded & in a filename cannot become a parameter separator.
function normalizeSubtitleRequestUrl(req, res, next) {
    if (req.url.length > 8192) {
        return res.status(414).type('text/plain').send('Požadavek je příliš dlouhý.');
    }
    const question = req.url.indexOf('?');
    if (question === -1) return next();
    const pathname = req.url.slice(0, question);
    const match = /^\/subtitles\/[^/]+\/[^/]+(?:\/([^/]*))?\.json$/i.exec(pathname);
    if (!match) return next();

    const extras = new URLSearchParams(match[1] || '');
    const query = new URLSearchParams(req.url.slice(question + 1));
    for (const [key, value] of query) {
        // The canonical path takes precedence when both forms are supplied.
        if (!extras.has(key)) extras.append(key, value);
    }
    const basePath = match[1] === undefined
        ? pathname.slice(0, -5) : pathname.slice(0, -(match[1].length + 6));
    const encoded = Array.from(extras.entries())
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join('&');
    req.url = basePath + (encoded ? '/' + encoded : '') + '.json';
    return next();
}

builder.defineSubtitlesHandler(async function(args) {
    const context = subtitleRequestContext.getStore();
    const req = context && context.req;
    const res = context && context.res;
    const { type, id } = args;
    const extra = normalizeSubtitleExtras(args.extra);
    const config = isRecord(args.config) ? args.config : {};
    const creds = typeof config.username === 'string' && typeof config.passMd5 === 'string'
        ? parseUserConfig(`${config.username}:${config.passMd5}`) : null;

    if (!req || !res) throw new Error('Chybí kontext HTTP požadavku.');
    traceSubtitleHttp(req, res, { resource: 'subtitles', type, id });
    if (!creds) return buildSubtitleResponse(req, res, []);

    try {
        const idParts = id.split(':');
        const cleanId = idParts[0].replace(/^(sosac_m_|sosac2_|sosac_)/, '');
        const season = idParts[1] ? normalizeInt(idParts[1]) : null;
        const episode = idParts[2] ? normalizeInt(idParts[2]) : null;
        console.log('');
        console.log('========================================');
        console.log(`[Subtitle Request] type=${type}, id=${id}`);
        console.log(`[Subtitle Request] cleanId=${cleanId}, season=${season}, episode=${episode}`);
        console.log(`[Subtitle Request] extraKeys=${Object.keys(extra).join(',') || 'none'}`);
        console.log('[Subtitle Client]', JSON.stringify({
            userAgent: safeHeaderValue(req.headers['user-agent'], 300) || 'missing',
            accept: safeHeaderValue(req.headers.accept, 200) || 'missing',
            acceptLanguage: safeHeaderValue(req.headers['accept-language'], 120) || 'missing',
            filenameExtension: (() => {
                const name = String(extra.filename || '');
                const match = name.match(/\.([a-z0-9]{1,8})$/i);
                return match ? `.${match[1].toLowerCase()}` : 'none';
            })(),
            hasVideoHash: Boolean(extra.videoHash),
            hasVideoSize: Boolean(extra.videoSize)
        }));
        console.log('========================================');

        // Preserve the existing Sosáč IDs, including :movies and :episodes.
        const validIdShape = idParts.length === 1 ||
            (idParts.length === 2 &&
                idParts[1] === (type === 'movie' ? 'movies' : 'episodes')) ||
            (type === 'series' && idParts.length === 3 &&
                season !== null && episode !== null);
        if (!/^(?:\d+|tt\d+)$/.test(cleanId) ||
            !['movie', 'series'].includes(type) || !validIdShape) {
            return buildSubtitleResponse(req, res, []);
        }

        // Extras are passed through the SDK interface. Sosáč IDs identify the
        // actual item; no unverified videoHash-to-Streamuj mapping is invented.
        const subtitles = await resolveSubtitleRequest(req, creds, { type, id }, async () => {
            const isImdbRequest = /^tt\d{5,10}$/i.test(cleanId);

            if (!isImdbRequest) {
                const targetData = type === 'movie'
                    ? await fetchSosacMovie(cleanId, creds.username, creds.passMd5)
                    : await resolveSosacEpisode(
                        cleanId,
                        season,
                        episode,
                        creds,
                        false
                    );
                if (!targetData) return [];
                return findDirectSubtitles(req, targetData, creds);
            }

            // Nejdřív zachováme původní 2.9.8 chování:
            // IMDb ID zkusíme přímo proti Sosáč API. Až když tato cesta
            // nedá použitelný titulek, použijeme Cinemeta -> interní Sosáč ID.
            console.log(`[IMDB DIRECT] ${type} ${cleanId}: zkouším původní Sosáč lookup`);
            let directTargetData = null;

            try {
                directTargetData = type === 'movie'
                    ? await fetchSosacMovie(
                        cleanId,
                        creds.username,
                        creds.passMd5
                    )
                    : await resolveSosacEpisode(
                        cleanId,
                        season,
                        episode,
                        creds,
                        false
                    );
            } catch (e) {
                console.log(`[IMDB DIRECT] ${type} ${cleanId}: přímý lookup selhal (${e.message})`);
            }

            if (directTargetData) {
                const directSubtitles = await findDirectSubtitles(
                    req,
                    directTargetData,
                    creds
                );
                if (directSubtitles.length) {
                    console.log(`[IMDB DIRECT] ${type} ${cleanId}: nalezeno ${directSubtitles.length} stop bez Cinemety`);
                    return directSubtitles;
                }
                console.log(`[IMDB DIRECT] ${type} ${cleanId}: bez použitelného titulku, zkouším fallback`);
            } else {
                console.log(`[IMDB DIRECT] ${type} ${cleanId}: Sosáč nic nevrátil, zkouším fallback`);
            }

            const targetId = await resolveSosacIdFromImdb(
                type,
                cleanId,
                creds
            );
            if (!targetId) {
                console.log(`[IMDB FALLBACK] ${type} ${cleanId}: interní Sosáč ID nenalezeno`);
                return [];
            }

            console.log(`[IMDB FALLBACK] ${type} ${cleanId}: zkouším Sosáč ID ${targetId}`);
            const mappedTargetData = type === 'movie'
                ? await fetchSosacMovie(
                    targetId,
                    creds.username,
                    creds.passMd5
                )
                : await resolveSosacEpisode(
                    targetId,
                    season,
                    episode,
                    creds,
                    true
                );

            if (!mappedTargetData) return [];
            return findDirectSubtitles(req, mappedTargetData, creds);
        });
        return buildSubtitleResponse(req, res, subtitles);
    } catch (e) {
        console.error('[Handler Error]:', e.message);
        return buildSubtitleResponse(req, res, []);
    }
});

const addonInterface = builder.getInterface();

// The official router handles the resource and serializes its SDK response.
// Its built-in JSON-config prefix is not suitable for our existing legacy
// username:MD5 URLs, so Express removes that prefix and supplies a structured
// config object through this per-request adapter. No global credential state.
const sdkRouter = getRouter({
    manifest: addonInterface.manifest,
    get(resource, type, id, extra) {
        const context = subtitleRequestContext.getStore();
        const config = context && context.creds ? context.creds : {};
        return Promise.resolve(addonInterface.get(resource, type, id, extra, config))
            .then(result => {
                // Keep the original exact byte count for clients and diagnostics.
                if (context && context.res && !result.redirect) {
                    context.res.setHeader('Content-Length',
                        Buffer.byteLength(JSON.stringify(result), 'utf8'));
                }
                return result;
            });
    }
});

// Keep the same addon ID and the existing installation URLs.
app.get('/manifest.json', (req, res) => {
    res.json(addonInterface.manifest);
});

app.get('/health', (req, res) => {
    res.json({
        ok: true,
        version: addonInterface.manifest.version,
        directSubtitles: true,
        subtitleProxy: true,
        hybridSubtitles: true,
        appleCompatibilityUa: 'Stremio-Apple/0.6.5',
        streamujDevice: 19
    });
});
app.get('/:config/manifest.json', (req, res) => {
    res.json({
        ...addonInterface.manifest,
        behaviorHints: {
            configurable: true,
            configurationRequired: false
        }
    });
});

app.use('/:config', (req, res, next) => {
    const creds = parseUserConfig(req.params.config);
    subtitleRequestContext.run({ req, res, creds }, () => {
        normalizeSubtitleRequestUrl(req, res, () => sdkRouter(req, res, next));
    });
});

// ============================================================
// START
// ============================================================

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Sosáč + Streamuj CZ Titulky v${manifest.version}`);
        console.log(`Addon běží na portu ${PORT}`);
    });
}

module.exports = { app };
