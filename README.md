# 🎬 Sosáč + Streamuj.tv – CZ Titulky pro Stremio

Neoficiální komunitní doplněk (addon) pro [Stremio](https://www.stremio.com/), který umožňuje načítat české titulky ze serverů **Sosáč.tv** a **Streamuj.tv**.

Doplněk funguje výhradně jako poskytovatel titulků (`subtitles`), takže nenarušuje funkčnost ostatních video doplňků (např. SosacTV2, Torrentio apod.).

   [Odkaz - Stremio WEB](https://web.stremio.com/) 
Takže naše testy jsou:

* PC Stremio Web: filmy + seriály ✅
* IOS Stremio Web (ikona na ploše): filmy + seriály ✅
* Pc Official app: filmy + seriály ✅
* Iphone IPA (Sideload) : filmy + seriály ✅
* Google TV: filmy + seriály ✅
* Apple TV: filmy + seriály ❌
---

## 🚀 Rychlá instalace

1. Otevři konfigurační stránku:  
   👉 **[stremio-sosac-subtitlescz.onrender.com](https://stremio-sosac-subtitlescz.onrender.com)**
2. Zadej svoje přihlašovací údaje ze **Sosáč.tv** (jméno a heslo).
3. Klikni na **Instalovat do Stremia**.
4. Stremio se automaticky otevře a nabídne potvrzení instalace.

---

## ✨ Hlavní funkce

* 💬 **České titulky:** Automatické párování titulků k filmům a seriálům ze Sosáče.
* 🔒 **Bezpečnost na prvním místě:** Vaše heslo se neukládá na žádném serveru. Převod hesla na MD5 hash probíhá přímo ve vašem prohlížeči.
* 🧩 **Plná kompatibilita:** Registrováno čistě jako titulkový zdroj – ideální v kombinaci s jakýmkoliv jiným přehrávačem ve Stremiu.
* ⚡ **Bezplatný hosting:** Běží na cloudové platformě Render.com.

---

## 🔒 Ochrana soukromí

Tento doplněk neukládá žádná uživatelská data, logy ani hesla do databáze. Přihlašovací údaje se předávají přímo v šifrované URL adrese požadavku do rozhraní Stremia pro ověření vůči API Streamuj.tv.

---

## 🛠️ Lokální spuštění & Vývoj

Pokud si chceš kód upravit nebo spustit lokálně:

1. **Klonování repozitáře:**
   ```bash
   git clone [https://github.com/TVOJE_JMENO/stremio-sosac-subtitles.git](https://github.com/TVOJE_JMENO/stremio-sosac-subtitles.git)
   cd stremio-sosac-subtitles
