# Pipeline CUI → Dynamics

Extrage automat date despre firme românești din surse **oficiale** și le încarcă în Microsoft Dynamics 365.

## Ce face

Pornind de la o listă de CUI-uri:
1. **ANAF v9** → date de identificare + status fiscal (denumire, adresă, CAEN, TVA, stare, RO e-Factura)
2. **Min. Finanțelor (date deschise)** → indicatori de bilanț (cifră afaceri, profit, angajați)
3. **Normalizare** → lipește totul pe CUI, mapează spre câmpurile tale
4. **Dynamics** → upsert pe alternate key (creează firma dacă nu există, o actualizează dacă există)

## De ce așa și nu altfel

- **ANAF are API oficial**, nu facem scraping pe formularul web. Robust, documentat, gratuit.
- **Bilanțurile vin din fișierul de date deschise**, NU din pagina mfinante.gov.ro — aceasta are protecție anti-bot (cookie legat de IP) și se rupe constant. Fișierul oficial e curat și se actualizează o dată pe an.

## Instalare

Ai nevoie de **Node.js 18+** (folosește `fetch` nativ). Verifică: `node --version`.

```bash
# nu sunt dependențe externe — totul e Node standard
```

## Rulare rapidă (DRY-RUN — nu atinge Dynamics)

```bash
node src/index.js cuiuri.csv
```

Fișierul `cuiuri.csv` = un CUI pe linie (sau prima coloană). Acceptă și formatul `RO12345`.
Rezultatul se scrie în `rezultat.csv` — deschide-l, verifică datele. **Mereu rulează dry-run prima dată.**

## Pasul cu bilanțurile (o dată pe an)

1. Mergi pe https://data.gov.ro/dataset/situatii_financiare_2024
2. Descarcă fișierul `.txt` (datele) și `.csv` (specificația coloanelor) — au același nume.
3. Pune-le în folderul `date/`, redenumite `situatii_2024.txt` și `situatii_2024.csv`.
4. Actualizează `anBilant` în `src/index.js` când apare un an nou.

Fără acest pas, pipeline-ul rulează oricum — doar că rândurile vor avea câmpurile de bilanț goale (`areBilant: false`).

## Trecerea în LIVE (livrare reală în Dynamics)

### A. O dată, în Power Apps (≈15 min)
1. Pe entitatea **Account**, creează un câmp text pentru CUI (ex. `new_cui`).
2. La secțiunea **Keys**, creează o **Alternate Key** pe acel câmp. Așteaptă să devină „Active".
3. (Opțional) Creează celelalte câmpuri custom din `src/dynamics.js` (`new_cifraafaceri` etc.).

### B. Credențiale Azure AD
Creează o **App Registration** cu permisiuni pe Dataverse, apoi:

```bash
cp .env.example .env
# completează DYN_TENANT_ID, DYN_CLIENT_ID, DYN_CLIENT_SECRET, DYN_RESOURCE_URL
```

### C. Rulează
Cu variabilele `DYN_*` setate, pipeline-ul trece automat din dry-run în live:

```bash
node --env-file=.env src/index.js cuiuri.csv
```

Raportul (câte create / actualizate / erori) se scrie în `raport_livrare.json`.

## Personalizare câmpuri Dynamics

Numele reale ale coloanelor din Dynamics se editează **doar** în `src/dynamics.js`, în obiectul `MAPARE_DYNAMICS`. Înlocuiește prefixul `new_` cu prefixul publisher-ului tău. Restul codului nu se atinge.

## Limite de respectat

- **ANAF**: max 100 CUI/request, 1 request/secundă (deja gestionat în cod cu pauză de 1.2s).
- Pentru mii de CUI-uri, jobul durează câteva minute — e normal, e dictat de limita ANAF.

## Robustețe anti-rateuri

Aplicația nu face scraping din pagini HTML pentru datele critice:

- ANAF este interogat prin API-ul oficial `PlatitorTvaRest/v9/tva`.
- Bilanțurile se citesc din fișierele oficiale de date deschise de pe data.gov.ro, descărcate local.

Clientul ANAF are timeout, retry cu backoff și tratează corect răspunsurile temporare `429`/`5xx`. Dacă după toate încercările un lot rămâne eșuat, jobul continuă și scrie detaliile în `raport_anaf_esuate.json`, ca să poți relua doar CUI-urile afectate.

Livrarea în Dynamics are retry pentru erori temporare și respectă headerul `Retry-After` atunci când Dataverse cere pauză.

## Structura

```
src/
  anaf.js         → extragere ANAF v9
  bilant.js       → încărcare bilanțuri din fișierul oficial
  normalizare.js  → lipire pe CUI + formă curată
  dynamics.js     → upsert în Dynamics (aici editezi numele de câmpuri)
  index.js        → orchestrator (leagă tot)
date/             → pui aici fișierele de bilanț
```

## Programare periodică (opțional)

Pentru reîmprospătare automată (ex. lunară), pui scriptul într-un cron job (Linux) sau Task Scheduler (Windows). Bilanțurile le actualizezi manual o dată pe an când MF publică anul nou.
