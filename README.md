# 🎬 Sosáč + Streamuj.tv – CZ Titulky pro Stremio

Neoficiální doplněk pro [Stremio](https://www.stremio.com/), který poskytuje české a další dostupné titulky ze zdrojů **Sosáč.tv** a **Streamuj.tv**.

Doplněk funguje pouze jako poskytovatel titulků (`subtitles`). Video streamy neposkytuje.

## 🚀 Rychlá instalace

![Aktuální verze](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FCaseyCZ%2Fstremio.sosac.subtitles%2FMaster%2Fpackage.json&query=%24.version&label=Aktu%C3%A1ln%C3%AD%20verze&color=blue&prefix=v)

👉 **[CZ Titulky pro Stremio – konfigurace](https://130.61.49.108:8443/configure)**

1. Otevři konfigurační stránku.
2. Zadej přihlašovací údaje ze **Sosáč.tv**.
3. Klikni na **Vygenerovat instalační odkaz**.
4. Klikni na **Instalovat do Stremio**.

Hlavní Sosáč addon je dostupný na:

👉 **https://130.61.49.108/configure**

## ☁️ Hosting

Addon běží na **Oracle Cloud** na Ubuntu 24.04 ARM.

```text
Internet
   ↓
https://130.61.49.108:8443
   ↓
Nginx + Let's Encrypt
   ↓
127.0.0.1:7001
   ↓
PM2 → stremio-subtitles
```

- veřejný HTTPS port: `8443`
- interní Node.js port: `7001`
- proces: `stremio-subtitles`
- správce procesů: PM2
- HTTPS: Nginx + Let's Encrypt
- certifikát se automaticky obnovuje

## ✨ Hlavní funkce

- 💬 titulky pro filmy a seriály
- 🇨🇿 čeština, 🇸🇰 slovenština a další jazyky podle dostupnosti Streamuj.tv
- 🎞️ převod SRT → WebVTT
- 🔗 podpora IMDb a Sosáč identifikátorů
- 📁 titulky jsou připravené na serveru a poskytované přes veřejnou HTTPS URL
- ⚡ cache opakovaných požadavků a připravených souborů
- 🧩 samostatný addon, který nezasahuje do přehrávání videa

## ✅ Otestovaná kompatibilita

| Platforma | Filmy | Seriály |
| --- | :---: | :---: |
| Google TV | ✅ | ✅ |
| Android – Play Store | ✅ | ✅ |
| Android – sideload APK | ✅ | ✅ |
| PC Stremio Web | ✅ | ✅ |
| PC oficiální aplikace | ✅ | ✅ |
| iOS Stremio Web | ✅ | ✅ |
| iPhone IPA | ✅ | ✅ |
| macOS App + Web | ✅ | ✅ |
| Apple TV – sideload IPA | ✅ | ✅ |

## 🛠️ Oracle Cloud / PM2

Repo obsahuje konfiguraci pro aktuální Oracle server:

```text
oracle.js
ecosystem.config.js
```

Aktuální hodnoty:

```text
PORT=7001
PUBLIC_BASE_URL=https://130.61.49.108:8443
SUBTITLE_CACHE_DIR=/home/ubuntu/.cache/stremio-sosac-subtitles
```

Spuštění přes PM2:

```bash
npm install
pm2 start ecosystem.config.js
pm2 save
```

Po změně kódu:

```bash
git pull
pm2 restart stremio-subtitles --update-env
pm2 save
```

## 🔒 Ochrana soukromí

Heslo se při generování instalačního odkazu převádí na MD5 hash přímo v prohlížeči. **MD5 není šifrování** a hash je nutné považovat za citlivý přihlašovací údaj.

Instalační URL obsahuje uživatelské jméno a MD5 hash. Proto instalační odkaz nesdílej veřejně ani jej nevkládej do screenshotů nebo logů.

HTTPS chrání přenos mezi klientem a serverem. Doplněk nemá vlastní databázi uživatelských účtů.

## 📁 Struktura projektu

```text
index.js               # hlavní logika addonu
oracle.js              # spuštění na Oracle Cloud
 ecosystem.config.js   # PM2 konfigurace
package.json
README.md
```

## ⚠️ Upozornění

Tento projekt je neoficiální komunitní addon. Není oficiálně spojen ani podporován službami **Stremio, Sosáč.tv ani Streamuj.tv**.
