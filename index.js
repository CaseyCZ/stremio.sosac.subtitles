const express = require('express');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { AsyncLocalStorage } = require('async_hooks');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');

const app = express();
// Seznam odkazuje na připravené soubory; po restartu se musí načíst znovu.
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

const manifest = {
    id: 'org.stremio.sosac.streamuj.subtitles.public',
    version: require('./package.json').version,
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

// JSON je první cesta. HTML ponecháváme jako zálohu pro starší videa
// nebo změnu dostupnosti API. Převod a předání jsou u obou stejné.
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
                file_name: `Streamuj.tv - ${subtitleLanguageName(lang)}.vtt`
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

async function resolveSosacEpisode(id, season, episode, creds) {
    const direct = await fetchSosacSeriesRaw(id, creds.username, creds.passMd5);
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

// Nelogujeme celou URL ani hlavičky: mohou obsahovat konfiguraci účtu.
// finish potvrzuje odeslání ze serveru, nikoli přijetí do nabídky klienta.
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

function sendVtt(req, res, body) {
    // Stejné jednoduché předání jako ve funkčním diagnostickém addonu.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');

    // Range platí pouze pro GET. HEAD popisuje vždy celý soubor.
    if (req.method === 'GET' && /^bytes=/i.test(req.headers.range || '') &&
        !req.headers['if-range']) {
        const ranges = req.range(body.length, { combine: true });
        if (ranges === -1) {
            res.setHeader('Content-Range', `bytes */${body.length}`);
            res.setHeader('Content-Length', 0);
            return res.status(416).end();
        }
        if (Array.isArray(ranges) && ranges.type.toLowerCase() === 'bytes' && ranges.length === 1) {
            const { start, end } = ranges[0];
            res.status(206);
            res.setHeader('Content-Range', `bytes ${start}-${end}/${body.length}`);
            const part = body.subarray(start, end + 1);
            res.setHeader('Content-Length', part.length);
            return res.end(part);
        }
    }
    res.setHeader('Content-Length', body.length);

    if (req.method === 'HEAD') return res.end();
    return res.end(body);
}

// Původní proxy zůstává kvůli filmům a kompatibilitě.
async function handleSubtitleVtt(req, res) {
    traceSubtitleHttp(req, res, { resource: 'legacy-vtt' });
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
// JEDNOTNÉ PŘEDÁNÍ HOTOVÝCH TITULKOVÝCH SOUBORŮ
// ============================================================

// Soubor má adresu podle SHA-256 svého obsahu. Nemá dvouhodinovou
// expiraci ani náhodný token měněný při každém novém stažení.
// SUBTITLE_CACHE_DIR lze nastavit na trvalý disk; běžný Render disk
// je dočasný. Do veřejných URL ani do souborů neukládáme hesla.
const SUBTITLE_CACHE_DIR = process.env.SUBTITLE_CACHE_DIR ||
    path.join(os.tmpdir(), 'sosac-subtitle-files');
const SUBTITLE_FILE_MAX_BYTES = 2 * 1024 * 1024;
const SUBTITLE_SOURCE_CACHE_MAX = 256;
const SUBTITLE_SOURCE_REFRESH_MS = 2 * 60 * 60 * 1000;
const subtitleCacheSecret = crypto.randomBytes(32);
const subtitleBySource = new Map();
const subtitlePending = new Map();

function subtitleSourceKey(sourceUrl, creds) {
    return crypto.createHmac('sha256', subtitleCacheSecret)
        .update(JSON.stringify([sourceUrl, creds.username, creds.passMd5]))
        .digest('hex');
}

function subtitleFilePath(hash) {
    return path.join(SUBTITLE_CACHE_DIR, `${hash}.vtt`);
}

async function readSubtitleFile(hash) {
    try {
        const body = await fs.promises.readFile(subtitleFilePath(hash));
        if (body.length > SUBTITLE_FILE_MAX_BYTES ||
            crypto.createHash('sha256').update(body).digest('hex') !== hash) {
            return null;
        }
        return body;
    } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
    }
}

async function storeSubtitleFile(body) {
    if (!Buffer.isBuffer(body) || !body.length ||
        body.length > SUBTITLE_FILE_MAX_BYTES) {
        throw new Error('Neplatná velikost souboru titulků.');
    }

    const hash = crypto.createHash('sha256').update(body).digest('hex');
    const existing = await readSubtitleFile(hash);
    if (existing) return hash;

    await fs.promises.mkdir(SUBTITLE_CACHE_DIR, { recursive: true });
    const temporary = path.join(
        SUBTITLE_CACHE_DIR,
        `.subtitle-${crypto.randomBytes(12).toString('hex')}.tmp`
    );

    try {
        await fs.promises.writeFile(temporary, body, {
            flag: 'wx', mode: 0o600
        });
        await fs.promises.rename(temporary, subtitleFilePath(hash));
    } finally {
        await fs.promises.rm(temporary, { force: true });
    }
    return hash;
}

async function prepareSubtitleFile(sub, creds, req) {
    const sourceUrl = validateSubtitleUrl(sub.sourceUrl);
    const key = subtitleSourceKey(sourceUrl, creds);
    const cached = subtitleBySource.get(key);
    // Obnovujeme pouze zdrojový obsah, nikdy neexpirujeme hotovou URL.
    let hash = cached && Date.now() - cached.checkedAt < SUBTITLE_SOURCE_REFRESH_MS
        ? cached.hash : null;

    // Pokud soubor na disku chybí, znovu jej připravíme.
    if (hash && !(await readSubtitleFile(hash))) {
        subtitleBySource.delete(key);
        hash = null;
    }

    if (!hash) {
        let pending = subtitlePending.get(key);
        if (!pending) {
            pending = (async () => {
                console.log('[SUBTITLE FILE] Stahuji a převádím titulky...');
                const body = await downloadSubtitleVtt(
                    sourceUrl, creds.username, creds.passMd5
                );
                const result = await storeSubtitleFile(body);
                subtitleBySource.delete(key);
                subtitleBySource.set(key, { hash: result, checkedAt: Date.now() });
                while (subtitleBySource.size > SUBTITLE_SOURCE_CACHE_MAX) {
                    subtitleBySource.delete(subtitleBySource.keys().next().value);
                }
                console.log(`[SUBTITLE FILE] Připraveno: ${body.length} bajtů`);
                return result;
            })();
            subtitlePending.set(key, pending);
        }
        try {
            hash = await pending;
        } finally {
            if (subtitlePending.get(key) === pending) {
                subtitlePending.delete(key);
            }
        }
    } else {
        console.log('[SUBTITLE FILE] Používám připravený soubor.');
        // Obnovení pořadí omezené paměťové mapy.
        subtitleBySource.delete(key);
        subtitleBySource.set(key, cached);
    }

    const publicPath = `/subtitle-file/v1/${hash}.vtt`;
    return {
        id: `file_v1_${hash}_${sub.lang}`,
        lang: sub.lang,
        file_name: sub.file_name,
        url: new URL(publicPath, getBaseUrl(req)).toString()
    };
}

async function prepareSubtitleTracks(req, foundSubs, creds) {
    const sources = new Set();
    const unique = foundSubs.filter(sub => {
        const key = `${sub.lang}:${sub.sourceUrl}`;
        if (sources.has(key)) return false;
        sources.add(key);
        return true;
    }).slice(0, 12);
    const prepared = await Promise.all(unique.map(async sub => {
        try {
            return await prepareSubtitleFile(sub, creds, req);
        } catch (e) {
            console.error(`[SUBTITLE FILE] Příprava selhala: ${e.message}`);
            return null;
        }
    }));
    const seen = new Set();
    return prepared.filter(sub => {
        if (!sub || seen.has(sub.id)) return false;
        seen.add(sub.id);
        return true;
    });
}

async function findPreparedSubtitles(req, targetData, creds) {
    const extracted = extractAllStreamujIds(targetData);
    for (const videoId of extracted.ids.slice(0, 10)) {
        const found = await fetchSubtitlesFromStreamuj(
            videoId, creds.username, creds.passMd5, req);
        let prepared = await prepareSubtitleTracks(req, found, creds);
        const missingCzech = found.some(sub => sub.lang === 'cze') &&
            !prepared.some(sub => sub.lang === 'cze');
        if ((!prepared.length || missingCzech) &&
            found.some(sub => sub.sourceKind === 'player-api')) {
            console.log('[PLAYER API] Soubor není dostupný; zkouším HTML zálohu.');
            const fallback = await fetchSubtitlesFromHtml(
                videoId, creds.username, creds.passMd5, req);
            prepared.push(...await prepareSubtitleTracks(req, fallback, creds));
        }
        // Další video přeskočíme až po úspěšném stažení titulků.
        if (prepared.length) {
            const seen = new Set();
            const priority = { cze: 0, slk: 1, eng: 2 };
            return prepared.filter(sub => {
                if (seen.has(sub.id)) return false;
                seen.add(sub.id);
                return true;
            }).sort((a, b) => (priority[a.lang] ?? 3) - (priority[b.lang] ?? 3));
        }
    }
    return [];
}

// Stremio receives only the three fields required by the SDK.
// file_name and sourceKind remain internal metadata, not protocol fields.
function buildSubtitleResponse(req, res, subtitles) {
    const result = { subtitles: subtitles.map(sub => ({
        id: sub.id,
        lang: sub.lang,
        url: sub.url
    })) };
    console.log('[FINAL RESPONSE]', JSON.stringify({
        requestId: res.locals.subtitleRequestId,
        subtitles: result.subtitles.map(sub => ({
            id: sub.id,
            lang: sub.lang,
            filePath: new URL(sub.url).pathname
        }))
    }, null, 2));
    return result;
}

// Krátká cache úspěšných výsledků šetří opakované dotazy na obě API.
// Je oddělená podle účtu, videa a veřejné adresy. Prázdné výsledky
// neukládáme a před použitím ověřujeme, že soubory stále existují.
const subtitleLookupCache = new Map();
const subtitleLookupPending = new Map();
async function resolveSubtitleRequest(req, creds, identity, lookup) {
    const key = subtitleSourceKey(JSON.stringify([
        getBaseUrl(req), identity.type, identity.id
    ]), creds);
    const cached = subtitleLookupCache.get(key);
    if (cached && Date.now() - cached.createdAt < 2 * 60 * 1000) {
        const files = await Promise.all(cached.subtitles.map(sub => {
            const hash = path.basename(new URL(sub.url).pathname, '.vtt');
            return readSubtitleFile(hash);
        }));
        if (files.every(Boolean)) {
            console.log('[SUBTITLE LOOKUP] Používám připravený výsledek.');
            return cached.subtitles;
        }
    }
    subtitleLookupCache.delete(key);
    let pending = subtitleLookupPending.get(key);
    if (!pending) {
        pending = (async () => {
            const subtitles = await lookup();
            if (subtitles.length) {
                subtitleLookupCache.set(key, { subtitles, createdAt: Date.now() });
                while (subtitleLookupCache.size > 128) {
                    subtitleLookupCache.delete(subtitleLookupCache.keys().next().value);
                }
            }
            return subtitles;
        })();
        subtitleLookupPending.set(key, pending);
    }
    try {
        return await pending;
    } finally {
        if (subtitleLookupPending.get(key) === pending) subtitleLookupPending.delete(key);
    }
}

// Při načtení této adresy se již nic nestahuje ze Streamuj.
// GET i HEAD čtou stejný hotový soubor.
app.get('/subtitle-file/v1/:hash.vtt', async (req, res) => {
    const hash = req.params.hash;
    traceSubtitleHttp(req, res, { resource: 'file', hash });
    if (!/^[a-f0-9]{64}$/.test(hash)) {
        return res.status(404).type('text/plain').send('Titulky nenalezeny.');
    }

    try {
        const body = await readSubtitleFile(hash);
        if (!body) {
            console.log('[SUBTITLE FILE] Soubor není dostupný; obnovte titulky v přehrávači.');
            return res.status(404).type('text/plain').send('Soubor není dostupný.');
        }
        console.log(`[SUBTITLE FILE] Odesílám hotový soubor: ${body.length} bajtů`);
        return sendVtt(req, res, body);
    } catch (e) {
        console.error(`[SUBTITLE FILE] Čtení selhalo: ${e.message}`);
        return res.status(500).type('text/plain').send('Chyba při čtení titulků.');
    }
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
            const targetData = type === 'movie'
                ? await fetchSosacMovie(cleanId, creds.username, creds.passMd5)
                : await resolveSosacEpisode(cleanId, season, episode, creds);
            if (!targetData) return [];
            return findPreparedSubtitles(req, targetData, creds);
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
