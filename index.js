const express = require('express');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 7000;

const SOSAC_API_DOMAIN = 'kodi-api.sosac.to';

const manifest = {
    id: 'org.stremio.sosac.streamuj.subtitles.public',
    version: '2.8.2',
    name: 'Sosáč + Streamuj CZ Titulky',
    description: 'Komunitní doplněk pro české titulky ze Sosáč / Streamuj.tv',
    types: ['movie', 'series'],
    idPrefixes: ['tt', 'sosac', 'sosac2', 'tmdb'],
    resources: ['subtitles'],
    catalogs: []
};


/* =========================================================
   HTTPS GET
   ========================================================= */

function httpsGet(url, username, passMd5, customHeaders = {}) {

    return new Promise((resolve, reject) => {

        const options = {

            headers: {

                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',

                'Accept': '*/*',

                'Referer':
                    'https://www.streamuj.tv/',

                'Cookie':
                    username && passMd5
                        ? `pass=${username}%3A%3A%3A${passMd5}; sublanguage=1; quality=1; videolanguage=cs`
                        : 'sublanguage=1; quality=1; videolanguage=cs',

                ...customHeaders
            },

            rejectUnauthorized: false,

            timeout: 20000
        };


        const req = https.get(
            url,
            options,
            (res) => {

                const chunks = [];


                res.on(
                    'data',
                    chunk => {
                        chunks.push(
                            Buffer.from(chunk)
                        );
                    }
                );


                res.on(
                    'end',
                    () => {

                        const data =
                            Buffer
                                .concat(chunks)
                                .toString('utf8');


                        if (
                            res.statusCode >= 200 &&
                            res.statusCode < 400
                        ) {

                            resolve(data);

                        } else {

                            reject(
                                new Error(
                                    `HTTP Status ${res.statusCode} na adrese ${url}`
                                )
                            );

                        }

                    }
                );

            }
        );


        req.on(
            'error',
            err => reject(err)
        );


        req.on(
            'timeout',
            () => {

                req.destroy();

                reject(
                    new Error(
                        `Timeout při GET ${url}`
                    )
                );

            }
        );

    });

}


/* =========================================================
   JSON
   ========================================================= */

function safeJsonParse(raw) {

    if (
        !raw ||
        typeof raw !== 'string'
    ) {
        return null;
    }


    const text =
        raw.trim();


    if (
        !text ||
        text.startsWith('<')
    ) {
        return null;
    }


    try {

        return JSON.parse(text);

    } catch (e) {

        return null;

    }

}


/* =========================================================
   HTML ENTITIES
   ========================================================= */

function decodeHtmlEntities(text) {

    return String(text)

        .replace(
            /&amp;/gi,
            '&'
        )

        .replace(
            /&quot;/gi,
            '"'
        )

        .replace(
            /&#39;/gi,
            "'"
        )

        .replace(
            /&gt;/gi,
            '>'
        )

        .replace(
            /&lt;/gi,
            '<'
        );

}


/* =========================================================
   INTEGER
   ========================================================= */

function normalizeInt(value) {

    if (
        value === null ||
        value === undefined ||
        value === ''
    ) {
        return null;
    }


    const n =
        Number.parseInt(
            String(value).replace(
                /^S/i,
                ''
            ),
            10
        );


    return Number.isFinite(n)
        ? n
        : null;

}


/* =========================================================
   EXTRACT STREAMUJ IDS
   ========================================================= */

function extractAllStreamujIds(ep) {

    const ids =
        new Set();

    const mp4Urls =
        new Set();

    const directSubs =
        new Set();


    function addId(value) {

        if (!value) {
            return;
        }


        const id =
            String(value).trim();


        if (
            /^[a-zA-Z0-9]{15,40}$/.test(id)
        ) {

            ids.add(id);

        }

    }


    function parseString(str) {

        if (
            !str ||
            typeof str !== 'string'
        ) {
            return;
        }


        const clean =
            decodeHtmlEntities(
                str.trim()
            );


        if (!clean) {
            return;
        }


        /* -----------------------------------------
           Streamuj CDN MP4
           ----------------------------------------- */

        const mp4Match =
            clean.match(
                /https?:\/\/s\d+\.streamuj\.tv\/vid\/[^\s"'<>]+\/([a-zA-Z0-9]{15,40})_(?:sd|hd|720p|1080p|480p)\.mp4(?:\?[^\s"'<>]*)?/i
            );


        if (mp4Match) {

            mp4Urls.add(clean);

            addId(
                mp4Match[1]
            );

            console.log(
                `[Extract] Streamuj ID z MP4: ${mp4Match[1]}`
            );

            return;

        }


        /* -----------------------------------------
           Obecné MP4
           ----------------------------------------- */

        if (
            /\.mp4(?:\?|$)/i.test(clean)
        ) {

            mp4Urls.add(clean);


            const filenameMatch =
                clean.match(
                    /\/([a-zA-Z0-9]{15,40})_(?:sd|hd|720p|1080p|480p)\.mp4(?:\?|$)/i
                );


            if (filenameMatch) {

                addId(
                    filenameMatch[1]
                );

            }

        }


        /* -----------------------------------------
           Přímé titulky
           ----------------------------------------- */

        if (

            clean.includes(
                'streamuj=subtitles'
            )

            ||

            /\.(vtt|srt)(?:\?|$)/i.test(clean)

        ) {

            directSubs.add(clean);

        }


        /* -----------------------------------------
           Streamuj stránka
           ----------------------------------------- */

        const pageMatch =
            clean.match(
                /https?:\/\/www\.streamuj\.tv\/(?:video|vid)\/([a-zA-Z0-9]{10,40})/i
            );


        if (pageMatch) {

            addId(
                pageMatch[1]
            );

        }


        /* -----------------------------------------
           Samotné ID
           ----------------------------------------- */

        if (
            /^[a-zA-Z0-9]{15,40}$/.test(clean)
        ) {

            addId(clean);

        }

    }


    function recursiveSearch(obj) {

        if (!obj) {
            return;
        }


        if (
            typeof obj === 'string'
        ) {

            parseString(obj);

            return;

        }


        if (
            Array.isArray(obj)
        ) {

            obj.forEach(
                recursiveSearch
            );

            return;

        }


        if (
            typeof obj === 'object'
        ) {

            Object.values(obj).forEach(
                recursiveSearch
            );

        }

    }


    recursiveSearch(ep);


    return {

        ids:
            Array.from(ids),

        directSubs:
            Array.from(directSubs),

        mp4Urls:
            Array.from(mp4Urls)

    };

}


/* =========================================================
   USER CONFIG
   ========================================================= */

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
        configStr.slice(
            0,
            splitAt
        );


    const passMd5 =
        configStr.slice(
            splitAt + 1
        );


    if (
        !username ||
        !passMd5
    ) {

        return null;

    }


    return {

        username,
        passMd5

    };

}


/* =========================================================
   PROXY URL
   ========================================================= */

function buildProxyUrl(
    req,
    rawSubUrl,
    username,
    passMd5
) {

    const proto =
        req.headers['x-forwarded-proto'] ||
        req.protocol ||
        'https';


    const host =
        req.get('host');


    return (

        `${proto}://${host}/sub-proxy` +

        `?url=${encodeURIComponent(rawSubUrl)}` +

        `&u=${encodeURIComponent(username)}` +

        `&p=${encodeURIComponent(passMd5)}`

    );

}


/* =========================================================
   STREAMUJ TITULKY
   ========================================================= */

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


        console.log(
            `[Subtitle] Streamuj ID: ${videoId}`
        );


        console.log(
            `[Subtitle] GET: ${remoteUrl}`
        );


        const html =
            await httpsGet(
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


        if (!html) {

            return subtitles;

        }


        console.log(
            `[Subtitle] HTML: ${html.length} znaků`
        );


        /* -----------------------------------------
           Hlavní způsob - sub0
           ----------------------------------------- */

        const subMatch =
            html.match(
                /sub0\s*:\s*["']([^"']+)["']/i
            );


        if (
            subMatch &&
            subMatch[1]
        ) {

            const val =
                decodeHtmlEntities(
                    subMatch[1]
                );


            const parts =
                val.split('>');


            if (
                parts.length >= 2
            ) {

                const subLang =
                    parts
                        .shift()
                        .trim() ||
                    'čeština';


                let rawSubUrl =
                    parts
                        .join('>')
                        .trim();


                if (
                    !rawSubUrl.startsWith(
                        'http'
                    )
                ) {

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

                    const proxyUrl =
                        buildProxyUrl(
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

                        id:
                            `streamuj_${videoId}`,

                        url:
                            proxyUrl,

                        lang:
                            'cs',

                        file_name:
                            `Streamuj.tv - ${subLang}`

                    });

                }

            }

        }


        /* -----------------------------------------
           Fallback - hledání streamuj=subtitles
           ----------------------------------------- */

        if (
            subtitles.length === 0
        ) {

            const fallbackRegex =
                /(https?:\/\/[^"'\s<>]+\?[^"'\s<>]*streamuj=subtitles[^"'\s<>]*)/gi;


            let match;


            while (
                (match =
                    fallbackRegex.exec(html)) !== null
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

                    url:
                        proxyUrl,

                    lang:
                        'cs',

                    file_name:
                        'Streamuj.tv - České titulky'

                });

            }

        }


        /* -----------------------------------------
           Další fallback - sub1, sub2...
           ----------------------------------------- */

        if (
            subtitles.length === 0
        ) {

            const subRegex =
                /sub\d+\s*:\s*["']([^"']+)["']/gi;


            let match;


            while (
                (match =
                    subRegex.exec(html)) !== null
            ) {

                const val =
                    decodeHtmlEntities(
                        match[1]
                    );


                const parts =
                    val.split('>');


                if (
                    parts.length < 2
                ) {
                    continue;
                }


                const subLang =
                    parts
                        .shift()
                        .trim() ||
                    'čeština';


                let rawSubUrl =
                    parts
                        .join('>')
                        .trim();


                if (
                    !rawSubUrl.startsWith(
                        'http'
                    )
                ) {

                    rawSubUrl =
                        rawSubUrl.startsWith('/')
                            ? `https://www.streamuj.tv${rawSubUrl}`
                            : `https://www.streamuj.tv/${rawSubUrl}`;

                }


                if (
                    rawSubUrl.includes(
                        'streamuj=subtitles'
                    )
                    ||
                    /\.(srt|vtt)(?:\?|$)/i.test(
                        rawSubUrl
                    )
                ) {

                    const proxyUrl =
                        buildProxyUrl(
                            req,
                            rawSubUrl,
                            username,
                            passMd5
                        );


                    subtitles.push({

                        id:
                            `streamuj_sub_${videoId}_${subtitles.length}`,

                        url:
                            proxyUrl,

                        lang:
                            'cs',

                        file_name:
                            `Streamuj.tv - ${subLang}`

                    });

                }

            }

        }

    } catch (e) {

        console.error(
            `[Subtitle] Streamuj ${videoId} chyba: ${e.message}`
        );

    }


    return subtitles;

}


/* =========================================================
   SOSAC FILM
   ========================================================= */

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


    if (!data) {

        return null;

    }


    return (

        data.item ||

        data.movie ||

        data

    );

}


/* =========================================================
   SOSAC SERIES
   ========================================================= */

async function fetchSosacSeriesRaw(
    episodeId,
    username,
    passMd5
) {

    const endpoint =
        `https://${SOSAC_API_DOMAIN}/episodes/${encodeURIComponent(episodeId)}`;


    console.log(
        `[Sosac] Series RAW GET: ${endpoint}`
    );


    try {

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


        if (!data) {

            console.log(
                '[Sosac] Series API nevrátil platný JSON.'
            );

            return null;

        }


        console.log(
            `[Sosac RAW JSON] ${JSON.stringify(data).substring(0, 30000)}`
        );


        return data;

    } catch (e) {

        console.error(
            `[Sosac] Series chyba: ${e.message}`
        );


        return null;

    }

}


/* =========================================================
   SUBTITLE PROXY
   ========================================================= */

app.get(
    '/sub-proxy',
    async (req, res) => {

        const {
            url,
            u,
            p
        } = req.query;


        if (
            !url ||
            !u ||
            !p
        ) {

            return res
                .status(400)
                .send(
                    'Chybí parametry.'
                );

        }


        try {

            const targetUrl =
                decodeURIComponent(url);


            console.log(
                `[Proxy] GET: ${targetUrl}`
            );


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
                    .replace(
                        /^\uFEFF/,
                        ''
                    )
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
                'Access-Control-Allow-Headers',
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


            return res.send(
                subData
            );

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


/* =========================================================
   CONFIGURE REDIRECT
   ========================================================= */

app.get(
    '/:config/configure',
    (req, res) => {

        res.redirect('/');

    }
);


/* =========================================================
   CONFIGURATION PAGE
   ========================================================= */

app.get(
    ['/', '/configure'],
    (req, res) => {

        res.send(`

<!DOCTYPE html>

<html lang="cs">

<head>

<meta charset="UTF-8">

<meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
>

<title>
Sosáč Titulky - Stremio Addon
</title>


<style>

body {

    font-family:
        system-ui,
        sans-serif;

    background:
        #0f172a;

    color:
        #f8fafc;

    display:
        flex;

    justify-content:
        center;

    align-items:
        center;

    min-height:
        100vh;

    margin:
        0;

    padding:
        1rem;

    box-sizing:
        border-box;

}


.card {

    background:
        #1e293b;

    padding:
        2rem;

    border-radius:
        1rem;

    width:
        100%;

    max-width:
        440px;

    box-shadow:
        0 20px 25px -5px rgba(0,0,0,0.5);

}


h1 {

    font-size:
        1.5rem;

    font-weight:
        700;

    color:
        #38bdf8;

    text-align:
        center;

    margin-bottom:
        0.5rem;

}


p {

    font-size:
        0.875rem;

    color:
        #94a3b8;

    text-align:
        center;

    margin-bottom:
        1.5rem;

}


.field {

    margin-bottom:
        1.25rem;

}


label {

    display:
        block;

    font-size:
        0.875rem;

    margin-bottom:
        0.5rem;

    color:
        #cbd5e1;

}


input {

    width:
        100%;

    padding:
        0.75rem;

    border-radius:
        0.5rem;

    border:
        1px solid #334155;

    background:
        #0f172a;

    color:
        white;

    box-sizing:
        border-box;

}


button,
.btn {

    width:
        100%;

    padding:
        0.875rem;

    border-radius:
        0.5rem;

    border:
        none;

    background:
        #0284c7;

    color:
        white;

    font-weight:
        600;

    cursor:
        pointer;

    text-align:
        center;

    text-decoration:
        none;

    display:
        block;

    box-sizing:
        border-box;

}


button:hover,
.btn:hover {

    background:
        #0369a1;

}


#result {

    display:
        none;

    margin-top:
        1.5rem;

    padding-top:
        1.5rem;

    border-top:
        1px solid #334155;

}

</style>


<script src="https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.1.1/crypto-js.min.js"></script>

</head>


<body>


<div class="card">


<h1>
Sosáč CZ Titulky
</h1>


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

    placeholder="TvojeJmeno"

>

</div>


<div class="field">


<label for="password">

Heslo

</label>


<input

    type="password"

    id="password"

    required

    placeholder="••••••••"

>


</div>


<button type="submit">

Vygenerovat instalační odkaz

</button>


</form>


<div id="result">


<a

    id="stremioBtn"

    href="#"

    class="btn"

>

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


/* =========================================================
   MANIFEST
   ========================================================= */

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

                configurable:
                    true,

                configurationRequired:
                    true

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

                configurable:
                    true,

                configurationRequired:
                    false

            }

        });

    }
);


/* =========================================================
   SUBTITLE REQUEST
   ========================================================= */

app.get(
    '/:config/subtitles/:type/:id/:extra?.json',
    async (req, res) => {

        res.setHeader(
            'Access-Control-Allow-Origin',
            '*'
        );


        res.setHeader(
            'Access-Control-Allow-Headers',
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


        const {
            type,
            id
        } = req.params;


        try {

            /* -----------------------------------------
               ID
               ----------------------------------------- */

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
                    ? normalizeInt(
                        idParts[1]
                    )
                    : null;


            const episode =
                idParts[2]
                    ? normalizeInt(
                        idParts[2]
                    )
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


            /* =====================================================
               MOVIE
               ===================================================== */

            if (
                type === 'movie'
            ) {

                const targetData =
                    await fetchSosacMovie(
                        cleanId,
                        creds.username,
                        creds.passMd5
                    );


                if (!targetData) {

                    console.log(
                        '[Movie] Film nenalezen.'
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
                    `[Movie] Streamuj IDs: ${extracted.ids.join(', ') || '(žádné)'}`
                );


                let subtitles = [];


                for (
                    const videoId of extracted.ids.slice(0, 10)
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


                const uniqueSubtitles =
                    [];


                const seenUrls =
                    new Set();


                for (
                    const sub of subtitles
                ) {

                    if (
                        !seenUrls.has(
                            sub.url
                        )
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
                    `[Movie] Vrácím ${uniqueSubtitles.length} titulků.`
                );


                return res.json({

                    subtitles:
                        uniqueSubtitles

                });

            }


            /* =====================================================
               SERIES
               ===================================================== */

            if (
                type === 'series'
            ) {

                /*
                 * Stremio může poslat například:
                 *
                 * sosac2_156567:episodes
                 *
                 * cleanId = 156567
                 *
                 * 156567 je ID KONKRÉTNÍ EPIZODY
                 *
                 * API:
                 *
                 * /episodes/156567
                 *
                 * vrací například:
                 *
                 * {
                 *   "s": 3,
                 *   "ep": 7,
                 *   "l": "690as69652ae00412411"
                 * }
                 */


                console.log(
                    `[Series] Hledám epizodu ID=${cleanId}`
                );


                const targetData =
                    await fetchSosacSeriesRaw(
                        cleanId,
                        creds.username,
                        creds.passMd5
                    );


                if (!targetData) {

                    console.log(
                        '[Series] Epizoda nenalezena.'
                    );


                    return res.json({

                        subtitles: []

                    });

                }


                console.log(
                    `[Series] Sosáč episode: season=${targetData.s}, episode=${targetData.ep}, streamuj=${targetData.l}`
                );


                /* -----------------------------------------
                   Přímé Streamuj ID
                   ----------------------------------------- */

                if (
                    targetData.l
                ) {

                    const streamujId =
                        String(
                            targetData.l
                        ).trim();


                    console.log(
                        `[Series] Používám Streamuj ID: ${streamujId}`
                    );


                    const foundSubs =
                        await fetchSubtitlesFromStreamuj(
                            streamujId,
                            creds.username,
                            creds.passMd5,
                            req
                        );


                    if (
                        foundSubs.length > 0
                    ) {

                        console.log(
                            `[Series] Nalezeno titulků: ${foundSubs.length}`
                        );


                        return res.json({

                            subtitles:
                                foundSubs

                        });

                    }


                    console.log(
                        '[Series] Streamuj titulky nenalezeny přes hlavní cestu.'
                    );

                }


                /* -----------------------------------------
                   Fallback - hledání všech Streamuj ID
                   ----------------------------------------- */

                const extracted =
                    extractAllStreamujIds(
                        targetData
                    );


                console.log(
                    `[Series] Fallback Streamuj ID: ${extracted.ids.join(', ') || '(žádné)'}`
                );


                for (
                    const streamujId of extracted.ids.slice(0, 10)
                ) {

                    const foundSubs =
                        await fetchSubtitlesFromStreamuj(
                            streamujId,
                            creds.username,
                            creds.passMd5,
                            req
                        );


                    if (
                        foundSubs.length > 0
                    ) {

                        console.log(
                            `[Series] Fallback nalezeno titulků: ${foundSubs.length}`
                        );


                        return res.json({

                            subtitles:
                                foundSubs

                        });

                    }

                }


                console.log(
                    '[Series] Žádné české titulky nenalezeny.'
                );


                return res.json({

                    subtitles: []

                });

            }


            /* =====================================================
               UNKNOWN TYPE
               ===================================================== */

            console.log(
                `[Result] Nepodporovaný typ: ${type}`
            );


            return res.json({

                subtitles: []

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


/* =========================================================
   START SERVER
   ========================================================= */

app.listen(
    PORT,
    () => {

        console.log(
            `Sosáč + Streamuj CZ Titulky v${manifest.version}`
        );


        console.log(
            `Addon běží na portu ${PORT}`
        );


        console.log(
            `Port: ${PORT}`
        );

    }
);
