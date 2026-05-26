// =============================================================
//  STRATUL 4 — Livrare in Microsoft Dynamics 365 / Dataverse
// =============================================================
//  Metoda: UPSERT pe ALTERNATE KEY (cheia = CUI).
//  Dynamics decide singur: daca firma exista -> update; daca nu -> create.
//  Nu includem header "If-Match": asta face PATCH-ul sa fie upsert.
//
//  PRECONDITIE (se face o singura data, in Power Apps maker portal, ~15 min):
//    1. Pe entitatea Account creezi un camp text, ex. "new_cui".
//    2. La sectiunea Keys creezi o Alternate Key pe acel camp.
//    3. Astepti sa ruleze jobul de indexare (apare ca "Active").
//  Fara pasul asta, upsert-ul pe alternate key NU functioneaza.
//
//  Autentificare: OAuth2 client credentials (App Registration in Azure AD).
//  Ai nevoie de: tenantId, clientId, clientSecret, si url-ul mediului
//  (ex. https://orgname.crm4.dynamics.com).
// =============================================================

// --- numele REALE de coloana din Dynamics ---
// Inlocuieste prefixul "new_" cu prefixul publisher-ului tau real.
// Cheia obiectului = numele neutru din normalizare.js; valoarea = coloana Dynamics.
const MAPARE_DYNAMICS = {
  denumire: "name",                       // camp standard pe Account
  cui: "new_cui",                         // ALTERNATE KEY
  adresa: "address1_composite",
  judet: "new_judet",
  localitate: "address1_city",
  nrRegCom: "new_nrregcom",
  codCaen: "new_codcaen",
  formaJuridica: "new_formajuridica",
  telefon: "telephone1",
  iban: "new_iban",
  stareInregistrare: "new_stareinregistrare",
  platitorTva: "new_platitortva",
  tvaLaIncasare: "new_tvalaincasare",
  splitTva: "new_splittva",
  roEFactura: "new_roefactura",
  inactiv: "new_inactiv",
  anBilant: "new_anbilant",
  cifraAfaceri: "new_cifraafaceri",
  profitNet: "new_profitnet",
  pierdereNeta: "new_pierderenet",
  profitBrut: "new_profitbrut",
  venituriTotale: "new_venituritotale",
  cheltuieliTotale: "new_cheltuielitotale",
  numarAngajati: "new_numarangajati",
  datorii: "new_datorii",
  capitalTotal: "new_capitaltotal",
};

const ENTITY_SET = "accounts";           // EntitySet (plural!) pentru Account
const CHEIE_ALTERNATE = "new_cui";       // numele coloanei alternate key
const PAUZA_MS = 200;                    // mic throttle, sa nu lovim limite Dataverse
const TIMEOUT_MS = 30000;
const MAX_INCERCARI = 4;

const asteapta = (ms) => new Promise((r) => setTimeout(r, ms));

function calculeazaBackoff(incercare, retryAfter) {
  const retryAfterSecunde = Number(retryAfter);
  if (Number.isFinite(retryAfterSecunde) && retryAfterSecunde > 0) {
    return retryAfterSecunde * 1000;
  }
  return 1000 * 2 ** (incercare - 1) + Math.floor(Math.random() * 500);
}

function esteEroareTemporara(status) {
  return status === 408 || status === 429 || status >= 500;
}

async function fetchCuTimeout(url, optiuni, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...optiuni, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Obtine un token OAuth2 (client credentials) pentru Dataverse.
async function getToken({ tenantId, clientId, clientSecret, resourceUrl }) {
  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: `${resourceUrl}/.default`,
  });

  const r = await fetchCuTimeout(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) throw new Error(`Token Dynamics esuat: ${r.status} ${await r.text()}`);
  const data = await r.json();
  return data.access_token;
}

// Transforma un rand normalizat in payload cu numele de coloana Dynamics.
// Sarim valorile null ca sa nu suprascriem cu gol date deja existente.
function construiestePayload(rand) {
  const payload = {};
  for (const [neutru, coloana] of Object.entries(MAPARE_DYNAMICS)) {
    const val = rand[neutru];
    if (val !== null && val !== undefined) payload[coloana] = val;
  }
  return payload;
}

// Upsert UN rand. Cheia merge in URL; corpul NU mai contine cheia.
async function upsertRand({ rand, token, resourceUrl }) {
  const cui = rand.cui;
  const cuiEscapat = String(cui).replace(/'/g, "''");
  const url =
    `${resourceUrl}/api/data/v9.2/${ENTITY_SET}(${CHEIE_ALTERNATE}='${cuiEscapat}')`;

  const payload = construiestePayload(rand);
  delete payload[CHEIE_ALTERNATE]; // cheia e deja in URL

  for (let incercare = 1; incercare <= MAX_INCERCARI; incercare++) {
    try {
      const r = await fetchCuTimeout(url, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "OData-MaxVersion": "4.0",
          "OData-Version": "4.0",
          // FARA "If-Match" -> comportament de UPSERT (creeaza daca nu exista).
        },
        body: JSON.stringify(payload),
      });

      // 204 = update reusit; 201 = create reusit. Ambele sunt OK.
      if (r.status === 204 || r.status === 201) {
        return r.status === 201 ? "creat" : "actualizat";
      }

      const text = await r.text();
      if (esteEroareTemporara(r.status) && incercare < MAX_INCERCARI) {
        const pauza = calculeazaBackoff(incercare, r.headers.get("retry-after"));
        console.warn(`[DYNAMICS] Upsert CUI ${cui} a primit ${r.status}. Reiau in ${pauza} ms.`);
        await asteapta(pauza);
        continue;
      }

      throw new Error(`Upsert CUI ${cui} esuat: ${r.status} ${text}`);
    } catch (e) {
      const temporara = e.name === "AbortError" || /fetch failed|network|socket|ECONNRESET|ETIMEDOUT/i.test(e.message);
      if (temporara && incercare < MAX_INCERCARI) {
        const pauza = calculeazaBackoff(incercare);
        console.warn(`[DYNAMICS] Upsert CUI ${cui} a esuat (${e.name === "AbortError" ? "timeout" : e.message}). Reiau in ${pauza} ms.`);
        await asteapta(pauza);
        continue;
      }
      throw e.name === "AbortError" ? new Error(`Upsert CUI ${cui} timeout dupa ${TIMEOUT_MS} ms`) : e;
    }
  }

  throw new Error(`Upsert CUI ${cui} esuat dupa toate incercarile.`);
}

// FUNCTIA PRINCIPALA: trimite toate randurile in Dynamics.
async function livreazaInDynamics(randuri, config) {
  const token = await getToken(config);
  const raport = { creat: 0, actualizat: 0, erori: [] };

  console.log(`[DYNAMICS] Incep livrarea a ${randuri.length} randuri...`);

  for (let i = 0; i < randuri.length; i++) {
    const rand = randuri[i];
    try {
      const rezultat = await upsertRand({ rand, token, resourceUrl: config.resourceUrl });
      raport[rezultat]++;
    } catch (e) {
      raport.erori.push({ cui: rand.cui, eroare: e.message });
      console.error(`[DYNAMICS] ${e.message}`);
    }
    if (i % 50 === 0 && i > 0) {
      console.log(`[DYNAMICS] Progres: ${i}/${randuri.length}`);
    }
    await asteapta(PAUZA_MS);
  }

  console.log(
    `[DYNAMICS] Gata. Create: ${raport.creat}, Actualizate: ${raport.actualizat}, Erori: ${raport.erori.length}`
  );
  return raport;
}

module.exports = { livreazaInDynamics };
