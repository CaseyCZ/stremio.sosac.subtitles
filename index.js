const express = require('express');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 7000;

const SOSAC_API_DOMAIN = 'kodi-api.sosac.to';

const manifest = {
    id: 'org.stremio.sosac.streamuj.subtitles.public',
    version: '2.9.0',
    name: 'Sosáč + Streamuj CZ Titulky',
    description: 'Komunitní doplněk pro české titulky ze Sosáč / Streamuj.tv',
    types: ['movie', 'series'],
    idPrefixes: ['sosac', 'sosac2', 'tt'],
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

                'Referer': 'https://www.streamuj.tv/',

                'Cookie':
                    `pass=${username}%3A%3A%3A${passMd5}; sublanguage=1; quality=1; videolanguage=cs`,

                ...customHeaders
            },

            rejectUnauthorized: false,
            timeout: 15000
        };

        const req = https.get(url, options, (res) => {

            let data = '';

            res.on('data', chunk => {
                data += chunk;
            });

            res.on('end', () => {

                if (res.statusCode >= 200 && res.statusCode < 400) {
                    resolve(data);
                } else {
                    reject(
                        new Error(
                            `HTTP Status ${res.statusCode} na adrese ${url}`
                        )
                    );
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


/* =========================================================
   HLEDÁNÍ STREAMUJ ID V OBJEKTU
   ========================================================= */

function extractAllStreamujIds(obj) {

    const ids = new Set();
    const directSubs = new Set();

    const parseString = (str) => {

        if (!str || typeof str !== 'string') {
            return;
        }


        /* ---------------------------------------------
           MP4 URL

           například:

           https://s1.streamuj.tv/vid/.../69ads04210a8ec621219_sd.mp4
           --------------------------------------------- */

        const mp4Matches = str.matchAll(
            /\/([a-zA-Z0-9]{15,30})_(?:sd|hd|720p|1080p|480p)\.mp4(?:\?[^"'\\s]*)?/gi
        );

        for (const match of mp4Matches) {

            if (match[1]) {
                ids.add(match[1]);
            }
        }


        /* ---------------------------------------------
           /video/ID
           /vid/ID
           --------------------------------------------- */

        const videoMatches = str.matchAll(
            /\/(?:video|vid)\/([a-zA-Z0-9]{10,35})(?:[/?_]|$)/gi
        );

        for (const match of videoMatches) {

            if (match[1]) {
                ids.add(match[1]);
            }
        }


        /* ---------------------------------------------
           streamuj=subtitles
           --------------------------------------------- */

        if (
            str.includes('streamuj=subtitles') ||
            /\.vtt(?:\?|$)/i.test(str) ||
            /\.srt(?:\?|$)/i.test(str)
        ) {

            directSubs.add(str);
        }


        /* ---------------------------------------------
           Samostatné ID

           Např.
           69ads04210a8ec621219
           --------------------------------------------- */

        if (/^[a-zA-Z0-9]{15,30}$/.test(str)) {

            ids.add(str);
        }
    };


    const recursiveSearch = (value) => {

        if (value == null) {
            return;
        }


        if (typeof value === 'string') {

            parseString(value);
            return;
        }


        if (Array.isArray(value)) {

            value.forEach(item => {
                recursiveSearch(item);
            });

            return;
        }


        if (typeof value === 'object') {

            Object.values(value).forEach(val => {
                recursiveSearch(val);
            });
        }
    };


    recursiveSearch(obj);


    return {
        ids: [...ids],
        directSubs: [...directSubs]
    };
}


/* =========================================================
   STREAMUJ → TITULKY
   ========================================================= */

async function fetchSubtitlesFromStreamuj(
    videoId,
    username,
    passMd5,
    reqHost
) {

    const subtitles = [];

    try {

        const remoteUrl =
            `https://www.streamuj.tv/video/${videoId}?remote=1`;

        console.log(
            `[STREAMUJ] Načítám metadata: ${remoteUrl}`
        );


        const html = await httpsGet(
            remoteUrl,
            username,
            passMd5
        );


        if (!html) {

            console.log(
                `[STREAMUJ] Prázdná odpověď pro ${videoId}`
            );

            return subtitles;
        }


        /*
         * Streamuj vrací například:
         *
         * sub0: "čeština>https://www.streamuj.tv/video/69ads04210a8ec621219?streamuj=subtitles&id=ecf54ed32370803c79c2"
         */


        const subMatch = html.match(
            /sub0\s*:\s*"([^"]+)"/i
        );


        if (!subMatch || !subMatch[1]) {

            console.log(
                `[STREAMUJ] Titulky nenalezeny pro ${videoId}`
            );

            return subtitles;
        }


        const val = subMatch[1];

        const parts = val.split('>');


        if (parts.length < 2) {

            console.log(
                `[STREAMUJ] Neočekávaný formát sub0 pro ${videoId}: ${val}`
            );

            return subtitles;
        }


        const subLang =
            parts[0].trim();

        let rawSubUrl =
            parts.slice(1).join('>').trim();


        if (!rawSubUrl.startsWith('http')) {

            if (rawSubUrl.startsWith('/')) {

                rawSubUrl =
                    `https://www.streamuj.tv${rawSubUrl}`;

            } else {

                rawSubUrl =
                    `https://www.streamuj.tv/${rawSubUrl}`;
            }
        }


        console.log(
            `[STREAMUJ] Nalezena URL titulků: ${rawSubUrl}`
        );


        /*
         * Proxy přes náš addon.
         *
         * Stremio tedy nemusí samo řešit autentizaci Streamuj.
         */

        const proxyUrl =
            `https://${reqHost}/sub-proxy` +
            `?url=${encodeURIComponent(rawSubUrl)}` +
            `&u=${encodeURIComponent(username)}` +
            `&p=${encodeURIComponent(passMd5)}`;


        subtitles.push({
            id: `streamuj_${videoId}`,
            url: proxyUrl,
            lang: 'cs',
            file_name: `Streamuj.tv - ${subLang}`
        });


    } catch (e) {

        console.error(
            `[STREAMUJ] Chyba při získávání titulků pro ${videoId}:`,
            e.message
        );
    }


    return subtitles;
}


/* =========================================================
   KONFIGURACE UŽIVATELE
   ========================================================= */

function parseUserConfig(configStr) {

    if (!configStr || !configStr.includes(':')) {
        return null;
    }


    /*
     * Důležité:
     * split pouze na první :
     */

    const separator =
        configStr.indexOf(':');


    const username =
        configStr.substring(0, separator);

    const passMd5 =
        configStr.substring(separator + 1);


    if (!username || !passMd5) {
        return null;
    }


    return {
        username,
        passMd5
    };
}


/* =========================================================
   SUBTITLE PROXY
   ========================================================= */

app.get('/sub-proxy', async (req, res) => {

    const {
        url,
        u,
        p
    } = req.query;


    if (!url || !u || !p) {

        return res
            .status(400)
            .send('Chybí parametry.');
    }


    try {

        const subData = await httpsGet(
            decodeURIComponent(url),
            u,
            p
        );


        res.setHeader(
            'Access-Control-Allow-Origin',
            '*'
        );

        res.setHeader(
            'Content-Type',
            'text/vtt; charset=utf-8'
        );


        return res.send(subData);


    } catch (e) {

        console.error(
            '[SUB-PROXY ERROR]',
            e.message
        );


        return res
            .status(500)
            .send('Chyba při stahování titulků.');
    }
});


/* =========================================================
   CONFIGURE
   ========================================================= */

app.get(
    '/:config/configure',
    (req, res) => res.redirect('/')
);


/* =========================================================
   WEB KONFIGURACE
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

    box-shadow:
        0 20px 25px -5px rgba(0,0,0,0.5);
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


<script
    src="https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.1.1/crypto-js.min.js">
</script>

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


/* =========================================================
   SUBTITLES
   ========================================================= */

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


        /* -----------------------------------------------
           Přihlášení
           ----------------------------------------------- */

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


        console.log('');
        console.log('========================================');
        console.log('[SUBTITLE REQUEST]');
        console.log(`type    = ${type}`);
        console.log(`id      = ${id}`);
        console.log(`extra   = ${req.params.extra || ''}`);
        console.log('========================================');


        let subtitles = [];


        try {

            /* =================================================
               MOVIE / SERIES ID
               ================================================= */

            const idParts =
                id.split(':');


            const cleanId =
                idParts[0]
                .replace(
                    /^(sosac_m_|sosac2_|sosac_|tt)/,
                    ''
                );


            const season =
                idParts[1]
                    ? parseInt(idParts[1], 10)
                    : null;


            const episode =
                idParts[2]
                    ? parseInt(idParts[2], 10)
                    : null;


            console.log(
                `[REQUEST] cleanId=${cleanId}`
            );

            console.log(
                `[REQUEST] season=${season}`
            );

            console.log(
                `[REQUEST] episode=${episode}`
            );


            /* =================================================
               STREAMUJ ID PŘÍMO Z REQUESTU
               ================================================= */

            let streamujId = null;


            const fullRequest =
                req.originalUrl || req.url;


            const directIdMatch =
                fullRequest.match(
                    /\/([a-zA-Z0-9]{15,30})_(?:sd|hd|720p|1080p|480p)\.mp4/i
                ) ||
                fullRequest.match(
                    /(?:video|vid)\/([a-zA-Z0-9]{10,35})/i
                );


            if (
                directIdMatch &&
                directIdMatch[1]
            ) {

                streamujId =
                    directIdMatch[1];


                console.log(
                    `[REQUEST] Přímé Streamuj ID: ${streamujId}`
                );
            }


            /* =================================================
               KDYŽ UŽ MÁME STREAMUJ ID
               ================================================= */

            if (streamujId) {

                subtitles =
                    await fetchSubtitlesFromStreamuj(
                        streamujId,
                        creds.username,
                        creds.passMd5,
                        req.headers.host
                    );
            }


            /* =================================================
               JINAK HLEDÁME PŘES SOSÁČ
               ================================================= */

            else {

                let targetData = null;


                /* =================================================
                   SERIES
                   ================================================= */

                if (type === 'series') {

                    console.log(
                        '[SERIES] Začínám hledat epizodu'
                    );


                    /*
                     * Nejprve zkusíme konkrétní epizodu:
                     */

                    if (
                        season !== null &&
                        episode !== null
                    ) {

                        try {

                            const epUrl =
                                `https://${SOSAC_API_DOMAIN}/episodes/${cleanId}`;


                            console.log(
                                `[SERIES] EP endpoint: ${epUrl}`
                            );


                            const rawEp =
                                await httpsGet(
                                    epUrl,
                                    creds.username,
                                    creds.passMd5
                                );


                            if (
                                rawEp &&
                                !rawEp
                                    .trim()
                                    .startsWith('<')
                            ) {

                                const parsedEp =
                                    JSON.parse(rawEp);


                                const candidates = [
                                    parsedEp,
                                    parsedEp.item,
                                    parsedEp.episode,
                                    parsedEp.data
                                ];


                                for (
                                    const candidate
                                    of candidates
                                ) {

                                    if (
                                        candidate &&
                                        typeof candidate === 'object'
                                    ) {

                                        const epSeason =
                                            candidate.season ??
                                            candidate.s ??
                                            candidate.season_number;


                                        const epNumber =
                                            candidate.episode ??
                                            candidate.e ??
                                            candidate.ep ??
                                            candidate.episode_number ??
                                            candidate.number;


                                        if (
                                            Number(epSeason) === Number(season) &&
                                            Number(epNumber) === Number(episode)
                                        ) {

                                            targetData =
                                                candidate;

                                            break;
                                        }
                                    }
                                }


                                /*
                                 * Některé odpovědi nemusí mít season/episode
                                 * přímo v root objektu.
                                 */

                                if (!targetData) {

                                    if (
                                        parsedEp.item &&
                                        typeof parsedEp.item === 'object'
                                    ) {

                                        targetData =
                                            parsedEp.item;
                                    }

                                    else if (
                                        parsedEp.episode &&
                                        typeof parsedEp.episode === 'object'
                                    ) {

                                        targetData =
                                            parsedEp.episode;
                                    }
                                }
                            }


                        } catch (e) {

                            console.log(
                                '[SERIES] /episodes chyba:',
                                e.message
                            );
                        }
                    }


                    /* =================================================
                       SERIES / EPISODES FALLBACK
                       ================================================= */

                    if (!targetData) {

                        try {

                            const seriesUrl =
                                `https://${SOSAC_API_DOMAIN}/series/${cleanId}/episodes`;


                            console.log(
                                `[SERIES] Series endpoint: ${seriesUrl}`
                            );


                            const rawList =
                                await httpsGet(
                                    seriesUrl,
                                    creds.username,
                                    creds.passMd5
                                );


                            if (
                                rawList &&
                                !rawList
                                    .trim()
                                    .startsWith('<')
                            ) {

                                const epData =
                                    JSON.parse(rawList);


                                let list = [];


                                if (
                                    Array.isArray(epData)
                                ) {

                                    list =
                                        epData;
                                }

                                else if (
                                    Array.isArray(epData.items)
                                ) {

                                    list =
                                        epData.items;
                                }

                                else if (
                                    Array.isArray(epData.episodes)
                                ) {

                                    list =
                                        epData.episodes;
                                }

                                else if (
                                    Array.isArray(epData.results)
                                ) {

                                    list =
                                        epData.results;
                                }

                                else if (
                                    Array.isArray(epData.data)
                                ) {

                                    list =
                                        epData.data;
                                }


                                console.log(
                                    `[SERIES] Počet epizod: ${list.length}`
                                );


                                /*
                                 * Najdeme požadovanou sezónu + epizodu
                                 */

                                const targetEp =
                                    list.find(ep => {

                                        if (
                                            !ep ||
                                            typeof ep !== 'object'
                                        ) {

                                            return false;
                                        }


                                        const epSeason =
                                            ep.season ??
                                            ep.s ??
                                            ep.season_number ??
                                            ep.seasonNumber;


                                        const epNumber =
                                            ep.episode ??
                                            ep.e ??
                                            ep.ep ??
                                            ep.episode_number ??
                                            ep.episodeNumber ??
                                            ep.number;


                                        return (
                                            Number(epSeason) === Number(season) &&
                                            Number(epNumber) === Number(episode)
                                        );
                                    });


                                if (targetEp) {

                                    targetData =
                                        targetEp;


                                    console.log(
                                        '[SERIES] Požadovaná epizoda nalezena.'
                                    );

                                } else {

                                    console.log(
                                        `[SERIES] Epizoda ${season}:${episode} nebyla v seznamu nalezena.`
                                    );
                                }
                            }


                        } catch (e) {

                            console.log(
                                '[SERIES] /series/.../episodes chyba:',
                                e.message
                            );
                        }
                    }
                }


                /* =================================================
                   MOVIE
                   ================================================= */

                else if (type === 'movie') {

                    const endpoint =
                        `https://${SOSAC_API_DOMAIN}/movies/${cleanId}`;


                    console.log(
                        `[MOVIE] Volám: ${endpoint}`
                    );


                    const rawData =
                        await httpsGet(
                            endpoint,
                            creds.username,
                            creds.passMd5,
                            {
                                'Referer':
                                    'https://sosac.tv/',

                                'Origin':
                                    'https://sosac.tv',

                                'Accept':
                                    'application/json'
                            }
                        );


                    if (
                        rawData &&
                        !rawData
                            .trim()
                            .startsWith('<')
                    ) {

                        const data =
                            JSON.parse(rawData);


                        targetData =
                            data.item ||
                            data.movie ||
                            data;
                    }
                }


                /* =================================================
                   NAŠLI JSME DATA → HLEDÁME STREAMUJ ID
                   ================================================= */

                if (targetData) {

                    console.log(
                        '[DATA] Hledám Streamuj ID v datech...'
                    );


                    const extracted =
                        extractAllStreamujIds(
                            targetData
                        );


                    console.log(
                        '[DATA] Nalezená Streamuj ID:',
                        extracted.ids
                    );


                    console.log(
                        '[DATA] Přímé titulky:',
                        extracted.directSubs
                    );


                    /* -----------------------------------------------
                       Máme přímo subtitle URL
                       ----------------------------------------------- */

                    if (
                        extracted.directSubs.length > 0
                    ) {

                        for (
                            const directUrl
                            of extracted.directSubs
                        ) {

                            /*
                             * Pouze pokud jde opravdu
                             * o Streamuj subtitle URL.
                             */

                            if (
                                directUrl.includes(
                                    'streamuj=subtitles'
                                )
                            ) {

                                const proxyUrl =
                                    `https://${req.headers.host}/sub-proxy` +
                                    `?url=${encodeURIComponent(directUrl)}` +
                                    `&u=${encodeURIComponent(creds.username)}` +
                                    `&p=${encodeURIComponent(creds.passMd5)}`;


                                subtitles.push({
                                    id:
                                        `streamuj_direct_${Buffer
                                            .from(directUrl)
                                            .toString('base64')
                                            .replace(/[/+=]/g, '')
                                            .substring(0, 30)}`,

                                    url:
                                        proxyUrl,

                                    lang:
                                        'cs',

                                    file_name:
                                        'Streamuj.tv - CZ'
                                });


                                console.log(
                                    `[DATA] Použita přímá URL titulků.`
                                );


                                break;
                            }
                        }
                    }


                    /* -----------------------------------------------
                       Máme Streamuj video ID
                       ----------------------------------------------- */

                    if (
                        subtitles.length === 0 &&
                        extracted.ids.length > 0
                    ) {

                        /*
                         * Nebereme pouze první ID.
                         * Zkusíme všechna.
                         */

                        for (
                            const streamujId
                            of extracted.ids
                        ) {

                            console.log(
                                `[STREAMUJ] Zkouším ID ${streamujId}`
                            );


                            const found =
                                await fetchSubtitlesFromStreamuj(
                                    streamujId,
                                    creds.username,
                                    creds.passMd5,
                                    req.headers.host
                                );


                            if (
                                found &&
                                found.length > 0
                            ) {

                                subtitles.push(
                                    ...found
                                );


                                console.log(
                                    `[STREAMUJ] Titulky nalezeny pro ${streamujId}`
                                );


                                break;
                            }
                        }
                    }
                }
                else {

                    console.log(
                        '[DATA] Nebyla nalezena data epizody/filmu.'
                    );
                }
            }


            /* =================================================
               DEDUPLIKACE
               ================================================= */

            const uniqueSubtitles = [];

            const seenUrls =
                new Set();


            subtitles.forEach(sub => {

                if (
                    sub &&
                    sub.url &&
                    !seenUrls.has(sub.url)
                ) {

                    seenUrls.add(
                        sub.url
                    );

                    uniqueSubtitles.push(
                        sub
                    );
                }
            });


            console.log(
                `[RESULT] Vrací se ${uniqueSubtitles.length} titulků`
            );


            return res.json({
                subtitles:
                    uniqueSubtitles
            });


        } catch (e) {

            console.error(
                '[HANDLER ERROR]:',
                e.message
            );


            return res.json({
                subtitles: []
            });
        }
    }
);


/* =========================================================
   SERVER
   ========================================================= */

app.listen(
    PORT,
    () => {

        console.log(
            `Addon běží na portu ${PORT}`
        );

        console.log(
            `Port: ${PORT}`
        );

        console.log(
            `API: https://${SOSAC_API_DOMAIN}`
        );
    }
);
