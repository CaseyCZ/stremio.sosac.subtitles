# 🎬 Sosáč + Streamuj.tv – CZ Titulky pro Stremio

Neoficiální komunitní doplněk (addon) pro [Stremio](https://www.stremio.com/), který umožňuje načítat české titulky ze serverů **Sosáč.tv** a **Streamuj.tv**.

Doplněk funguje výhradně jako poskytovatel titulků (`subtitles`). Neposkytuje vlastní video streamy a lze jej používat společně s dalšími video doplňky, například SosacTV2 nebo Torrentio.

👉 [**Otevřít Stremio Web**](https://web.stremio.com/)

## ✅ Otestovaná kompatibilita

| Platforma                        | Filmy | Seriály |
| -------------------------------- | :---: | :-----: |
| PC Stremio Web                   |   ✅   |    ✅    |
| PC oficiální aplikace            |   ✅   |    ✅    |
| iOS Stremio Web (ikona na ploše) |   ✅   |    ✅    |
| iPhone IPA (sideload)            |   ✅   |    ✅    |
| Google TV                        |   ✅   |    ✅    |
| **Apple TV – KSPlayer**          | ⚠️ Některé | ❌ |
---
## 🚀 Rychlá instalace

![Aktuální verze](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FCaseyCZ%2Fstremio.sosac.subtitles%2FMaster%2Fpackage.json&query=%24.version&label=Aktu%C3%A1ln%C3%AD%20verze&color=blue&prefix=v)

1. Otevři konfigurační stránku:
   👉 **[stremio-sosac-subtitlescz.onrender.com](https://stremio-sosac-subtitlescz.onrender.com/)**
2. Zadej svoje přihlašovací údaje ze **Sosáč.tv** (jméno a heslo).
3. Klikni na **Vygenerovat instalační odkaz** a potom na **Instalovat do Stremio**.
4. Stremio se otevře a nabídne potvrzení instalace.

Údaje si můžeš na svém zařízení zapamatovat. Stránka také umožňuje **zobrazit nebo skrýt heslo** a **zkopírovat instalační odkaz**.
---
## ✨ Hlavní funkce

* 💬 **České titulky pro filmy a seriály** – doplněk vyhledává odpovídající titulky podle identifikátorů Sosáče a Streamuj.tv.
* 🎞️ **Převod SRT → WebVTT** – server převádí titulky do formátu WebVTT včetně správného oddělení jednotlivých časových bloků.
* 🧩 **Samostatný titulkový doplněk** – nezasahuje do výběru ani přehrávání video streamů ostatních doplňků.
* ⚡ **Hosting na Renderu** – doplněk běží na cloudové platformě Render.
---
## 🔒 Ochrana soukromí

Heslo se při generování instalačního odkazu převádí na MD5 hash přímo v prohlížeči. **MD5 však není šifrování** a tento hash je nutné považovat za citlivý přihlašovací údaj.

Instalační URL obsahuje uživatelské jméno a MD5 hash. Doplněk je používá při požadavcích na Streamuj.tv. **Instalační odkaz proto nesdílej veřejně ani neposílej do veřejných logů.** HTTPS chrání přenos, ale neznamená, že jsou údaje uvnitř URL zašifrované.

Doplněk v této verzi nemá vlastní databázi uživatelských účtů. Pokud na konfigurační stránce povolíš zapamatování hesla, uloží se do `localStorage` v daném prohlížeči. Na sdíleném zařízení tuto možnost nepoužívej.
