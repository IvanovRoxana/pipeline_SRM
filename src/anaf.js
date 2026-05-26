// =============================================================
//  STRATUL 2a — Extragere ANAF v9 (date identificare + fiscale)
// =============================================================
//  Sursa oficiala: https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva
//  Reguli ANAF (NU sunt optionale):
//    - maxim 100 CUI-uri per request
//    - maxim 1 request / secunda
//  Documentatie: https://static.anaf.ro/static/10/Anaf/Informatii_R/Servicii_web/doc_WS_V9.txt
// =============================================================

const ANAF_URL = "https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva";
const LOT_MAX = 100;        // limita impusa de ANAF
const PAUZA_MS = 1200;      // > 1 secunda, cu marja de siguranta
const TIMEOUT_MS = 30000;   // ANAF poate raspunde lent in orele aglomerate
const MAX_INCERCARI = 4;    // incercarea initiala + 3 retry-uri

// Pauza simpla intre loturi, ca sa respectam rate-limit-ul.
const asteapta = (ms) => new Promise((r) => setTimeout(r, ms));

function calculeazaBackoff(incercare) {
  const baza = 1500 * 2 ** (incercare - 1);
  const jitter = Math.floor(Math.random() * 500);
  return baza + jitter;
}

function esteEroareTemporara(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

// Curata un CUI: scoate prefixul "RO", spatii, si il face numar.
// ANAF vrea CUI-ul ca NUMAR, nu string (vezi documentatia v9).
function curataCui(valoare) {
  const doarCifre = String(valoare).toUpperCase().replace(/^RO/, "").replace(/\D/g, "");
  return doarCifre ? Number(doarCifre) : null;
}

// Imparte o lista lunga in loturi de cate `marime`.
function imparteInLoturi(lista, marime) {
  const loturi = [];
  for (let i = 0; i < lista.length; i += marime) {
    loturi.push(lista.slice(i, i + marime));
  }
  return loturi;
}

// Trimite UN lot la ANAF si intoarce raspunsul brut.
async function interogheazaLot(cuiuri, dataInterogare, optiuni = {}) {
  const corp = cuiuri.map((cui) => ({ cui, data: dataInterogare }));
  const timeoutMs = optiuni.timeoutMs ?? TIMEOUT_MS;
  const incercari = optiuni.incercari ?? MAX_INCERCARI;

  for (let incercare = 1; incercare <= incercari; incercare++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const raspuns = await fetch(ANAF_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "cui-pipeline/1.0",
        },
        body: JSON.stringify(corp),
        signal: controller.signal,
      });

      const text = await raspuns.text();

      let json = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }

      if (!raspuns.ok) {
        // ANAF intoarce uneori 404 pentru request-uri valide in care toate
        // CUI-urile sunt in notFound. Daca avem structura asteptata, nu e eroare.
        if (json && (Array.isArray(json.found) || Array.isArray(json.notFound))) {
          return json;
        }

        const mesaj = `ANAF a raspuns cu status ${raspuns.status}: ${text.slice(0, 300)}`;
        if (esteEroareTemporara(raspuns.status) && incercare < incercari) {
          const pauza = calculeazaBackoff(incercare);
          console.warn(`[ANAF] Incercarea ${incercare}/${incercari} a esuat temporar (${raspuns.status}). Reiau in ${pauza} ms.`);
          await asteapta(pauza);
          continue;
        }
        throw new Error(mesaj);
      }

      if (json) return json;

      {
        const mesaj = `ANAF a returnat JSON invalid: ${text.slice(0, 300)}`;
        if (incercare < incercari) {
          const pauza = calculeazaBackoff(incercare);
          console.warn(`[ANAF] ${mesaj}. Reiau in ${pauza} ms.`);
          await asteapta(pauza);
          continue;
        }
        throw new Error(mesaj);
      }
    } catch (e) {
      const temporara = e.name === "AbortError" || /fetch failed|network|socket|ECONNRESET|ETIMEDOUT/i.test(e.message);
      if (temporara && incercare < incercari) {
        const pauza = calculeazaBackoff(incercare);
        console.warn(`[ANAF] Incercarea ${incercare}/${incercari} a esuat (${e.name === "AbortError" ? "timeout" : e.message}). Reiau in ${pauza} ms.`);
        await asteapta(pauza);
        continue;
      }
      throw e.name === "AbortError" ? new Error(`Timeout ANAF dupa ${timeoutMs} ms`) : e;
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error("ANAF a esuat dupa toate incercarile.");
}

// Extrage din raspunsul ANAF doar campurile care ne intereseaza,
// intr-o forma plata si predictibila. Parsare DEFENSIVA: v9 nu
// respecta mereu ordinea/structura din documentatie, deci verificam totul.
function extrageCampuri(intrare) {
  const g = intrare?.date_generale ?? {};
  const tva = intrare?.inregistrare_scop_Tva ?? {};
  const incasare = intrare?.inregistrare_RTVAI ?? {};
  const inactiv = intrare?.stare_inactiv ?? {};
  const split = intrare?.inregistrare_SplitTVA ?? {};
  const sediu = intrare?.adresa_sediu_social ?? {};

  return {
    cui: String(g.cui ?? "").trim(),
    denumire: g.denumire ?? null,
    adresa: g.adresa ?? null,
    nrRegCom: g.nrRegCom ?? null,
    codCaen: g.cod_CAEN ?? null,
    stareInregistrare: g.stare_inregistrare ?? null,
    dataInregistrare: g.data_inregistrare ?? null,
    formaJuridica: g.forma_juridica ?? null,
    telefon: g.telefon ?? null,
    iban: g.iban ?? null,
    judetSediu: sediu.sdenumire_Judet ?? null,
    localitateSediu: sediu.sdenumire_Localitate ?? null,
    // Statusuri fiscale -> le tinem ca boolean clar
    platitorTva: tva.scpTVA === true,
    tvaLaIncasare: incasare.statusTvaIncasare === true,
    inactiv: inactiv.statusInactivi === true,
    dataRadiere: inactiv.dataRadiere ?? null,
    splitTva: split.statusSplitTVA === true,
    roEFactura: g.statusRO_e_Factura === true,
  };
}

// FUNCTIA PRINCIPALA a modulului.
// Primeste o lista de CUI-uri (orice format), intoarce un Map: cui -> date.
// Loghează progresul ca sa stii unde e jobul cand ai mii de CUI-uri.
async function getIdentificare(listaCuiBruta, optiuni = {}) {
  const dataInterogare = optiuni.data ?? new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // Curatam si eliminam duplicatele / valorile invalide.
  const cuiuriValide = [...new Set(listaCuiBruta.map(curataCui).filter(Boolean))];
  const loturi = imparteInLoturi(cuiuriValide, LOT_MAX);

  const rezultate = new Map();
  const negasite = [];
  const esuate = [];

  console.log(`[ANAF] ${cuiuriValide.length} CUI-uri valide, ${loturi.length} loturi.`);

  for (let i = 0; i < loturi.length; i++) {
    try {
      const date = await interogheazaLot(loturi[i], dataInterogare, optiuni);
      if (!date || typeof date !== "object") {
        throw new Error("Raspuns ANAF gol sau intr-un format neasteptat.");
      }
      for (const item of date.found ?? []) {
        const campuri = extrageCampuri(item);
        if (campuri.cui) rezultate.set(campuri.cui, campuri);
      }
      for (const c of date.notFound ?? []) negasite.push(String(c));
      console.log(`[ANAF] Lot ${i + 1}/${loturi.length} OK (${(date.found ?? []).length} gasite)`);
    } catch (e) {
      console.error(`[ANAF] Lot ${i + 1}/${loturi.length} a esuat: ${e.message}`);
      esuate.push({ lot: i + 1, cuiuri: loturi[i].map(String), eroare: e.message });
      // Nu oprim tot jobul pentru un lot picat; continuam si raportam la final.
    }
    // Respectam rate-limit-ul: pauza intre loturi (nu si dupa ultimul).
    if (i < loturi.length - 1) await asteapta(PAUZA_MS);
  }

  if (negasite.length) console.log(`[ANAF] ${negasite.length} CUI-uri negasite la ANAF.`);
  if (esuate.length) console.warn(`[ANAF] ${esuate.length} loturi au ramas esuate dupa retry. Vezi raport_anaf_esuate.json.`);
  return { rezultate, negasite, esuate };
}

module.exports = { getIdentificare, curataCui };
