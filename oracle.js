process.env.PORT = process.env.PORT || '7001';
process.env.PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://130.61.49.108:8443';
process.env.SUBTITLE_CACHE_DIR = process.env.SUBTITLE_CACHE_DIR || '/home/ubuntu/.cache/stremio-sosac-subtitles';

const { app } = require('./index');
const { version } = require('./package.json');

const PORT = Number(process.env.PORT) || 7001;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Sosáč + Streamuj CZ Titulky v${version}`);
    console.log(`Oracle Cloud: addon běží na interním portu ${PORT}`);
    console.log(`Veřejná adresa: ${process.env.PUBLIC_BASE_URL}`);
});
