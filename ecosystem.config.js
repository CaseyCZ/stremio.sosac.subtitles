module.exports = {
  apps: [
    {
      name: 'stremio-subtitles',
      script: './oracle.js',
      cwd: __dirname,
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: 'production',
        PORT: 7001,
        PUBLIC_BASE_URL: 'https://130.61.49.108:8443',
        SUBTITLE_CACHE_DIR: '/home/ubuntu/.cache/stremio-sosac-subtitles'
      }
    }
  ]
};
