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

Hlavní Sosáč addon:

👉 **https://130.61.49.108/configure**

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

## 🔒 Ochrana soukromí

Heslo se při generování instalačního odkazu převádí na MD5 hash přímo v prohlížeči. **MD5 není šifrování** a hash je nutné považovat za citlivý přihlašovací údaj.

Instalační URL obsahuje uživatelské jméno a MD5 hash. Proto instalační odkaz nesdílej veřejně ani jej nevkládej do screenshotů nebo logů.

HTTPS chrání přenos mezi klientem a serverem. Doplněk nemá vlastní databázi uživatelských účtů.

## ⚠️ Upozornění

Tento projekt je neoficiální komunitní addon. Není oficiálně spojen ani podporován službami **Stremio, Sosáč.tv ani Streamuj.tv**.
