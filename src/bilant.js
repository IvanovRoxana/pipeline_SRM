// =============================================================
//  STRATUL 2b — Bilanturi din DATE DESCHISE (data.gov.ro)
// =============================================================
//  De ce NU scraping pe mfinante.gov.ro:
//    pagina foloseste protectie anti-bot ("bobcmn") + cookie legat de
//    IP si timp -> fragil, se rupe lunar. NU merita.
//
//  In schimb: Ministerul Finantelor publica ACELEASI date ca date deschise
//  pe data.gov.ro, in fisiere anuale:
//    - un fisier .txt  = datele de bilant (o linie per firma)
//    - un fisier .csv  = specificatia coloanelor (ce inseamna fiecare camp)
//  Le incarcam local UNA pe an, construim un index CUI -> indicatori,
//  si cautam instant. Zero rate-limit, zero cookie, legal.
//
//  Pagina setului (de unde iei link-urile de descarcare manuala, o data/an):
//    https://data.gov.ro/dataset/situatii_financiare_2024
// =============================================================

const fs = require("fs");
const readline = require("readline");

// Indicatorii care ne intereseaza pentru SRM. Cheile din stanga sunt
// numele NOASTRE; valorile din dreapta sunt posibile denumiri de coloana
// in fisierul MF (variaza usor de la an la an, de-aia tinem mai multe variante).
// Le potrivim case-insensitive, ignorand spatii/underscore.
const MAPARE_INDICATORI = {
  cifraAfaceri: ["CIFRA_DE_AFACERI_NETA", "CIFRA DE AFACERI NETA", "CA", "i27"],
  profitNet: ["PROFIT_NET", "PROFITUL NET", "PROFIT NET", "i32"],
  pierdereNeta: ["PIERDERE_NET", "PIERDERE NETA", "i33"],
  profitBrut: ["PROFIT_BRUT", "PROFIT BRUT", "i30"],
  venituriTotale: ["VENITURI_TOTAL", "VENITURI TOTALE", "VENITURI TOTAL", "i26"],
  cheltuieliTotale: ["CHELTUIELI_TOTALE", "CHELTUIELI TOTAL", "i29"],
  numarAngajati: ["NUMAR_MEDIU_ANGAJATI", "NUMAR MEDIU ANGAJATI", "NR_MEDIU_ANGAJATI", "i34"],
  activeImobilizate: ["ACTIVE_IMOBILIZATE", "ACTIVE IMOBILIZATE - TOTAL", "i1"],
  activeCirculante: ["ACTIVE_CIRCULANTE", "ACTIVE CIRCULANTE - TOTAL", "i2"],
  datorii: ["DATORII", "i7"],
  capitalTotal: ["CAPITAL_TOTAL", "CAPITALURI_TOTALE", "CAPITALURI - TOTAL", "i10"],
};

// Normalizeaza un nume de coloana: uppercase, fara spatii/underscore.
const norm = (s) => String(s).toUpperCase().replace(/[\s_\-:]+/g, "");

function citesteStartFisier(cale, bytes = 4096) {
  const fd = fs.openSync(cale, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const cititi = fs.readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, cititi).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function detecteazaSeparator(text) {
  const primaLinie = text.split(/\r?\n/).find((linie) => linie.trim()) ?? "";
  const candidati = [";", ",", "\t", "|"];
  return candidati
    .map((sep) => ({ sep, parti: primaLinie.split(sep).length }))
    .sort((a, b) => b.parti - a.parti)[0].sep;
}

// Citeste fisierul .csv cu specificatia coloanelor si intoarce
// un array cu numele coloanelor, in ordine.
function citesteSpecificatia(caleCsv) {
  const continut = fs.readFileSync(caleCsv, "utf8").trim();
  const sep = detecteazaSeparator(continut);
  const linii = continut.split(/\r?\n/).filter((linie) => linie.trim());

  // Format MF uzual: fiecare rand din CSV descrie o coloana din TXT:
  // "Denumire explicita;cod_tehnic". Ex.: "CUI;CUI", "DATORII;i7".
  // Pastram ambele denumiri pentru potriviri stabile intre ani.
  const randuriSpec = linii
    .map((linie) => linie.split(sep).map((c) => c.trim().replace(/^\uFEFF/, "")))
    .filter((campuri) => campuri.length >= 1);

  if (randuriSpec.length > 1 && randuriSpec.every((campuri) => campuri.length <= 3)) {
    return randuriSpec.map((campuri) => ({
      nume: campuri[0] ?? "",
      cod: campuri[1] ?? campuri[0] ?? "",
    }));
  }

  // Fallback pentru cazul in care specificatia este un antet clasic.
  return randuriSpec[0].map((c) => ({ nume: c, cod: c }));
}

// Pentru fiecare indicator dorit, gaseste indexul coloanei in fisier.
function construiesteIndexColoane(coloane) {
  const coloaneNorm = coloane.map((c) => [norm(c.nume), norm(c.cod)].filter(Boolean));
  const index = {};
  for (const [cheia, variante] of Object.entries(MAPARE_INDICATORI)) {
    for (const v of variante) {
      const cautat = norm(v);
      const poz = coloaneNorm.findIndex((nume) =>
        nume.some((n) => n === cautat || n.includes(cautat) || cautat.includes(n))
      );
      if (poz !== -1) {
        index[cheia] = poz;
        break;
      }
    }
  }
  // Gasim si coloana de CUI (cheia de cautare).
  for (const candidat of ["CUI", "COD", "CODFISCAL", "COD_FISCAL", "COD FISCAL"]) {
    const cautat = norm(candidat);
    const poz = coloaneNorm.findIndex((nume) =>
      nume.some((n) => n === cautat || n.includes(cautat) || cautat.includes(n))
    );
    if (poz !== -1) {
      index.__cui = poz;
      break;
    }
  }
  return index;
}

// Converteste un text in numar curat (sau null daca e "-" / gol).
function laNumar(val) {
  if (val == null) return null;
  const t = String(val).trim();
  if (t === "" || t === "-") return null;
  const n = Number(t.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

// FUNCTIA PRINCIPALA: incarca un an de bilanturi intr-un Map: cui -> indicatori.
// Citeste fisierul .txt linie cu linie (streaming) ca sa nu incarce tot
// in memorie dintr-o data -- fisierele au milioane de linii.
async function incarcaBilanturi({ caleTxt, caleCsv, an }) {
  if (!fs.existsSync(caleTxt) || !fs.existsSync(caleCsv)) {
    console.warn(`[BILANT] Fisierele pentru anul ${an} lipsesc. Sar peste bilanturi.`);
    return new Map();
  }

  const coloane = citesteSpecificatia(caleCsv);
  const idx = construiesteIndexColoane(coloane);

  if (idx.__cui === undefined) {
    console.error(`[BILANT] Nu am gasit coloana de CUI in specificatie. Verifica fisierul .csv.`);
    return new Map();
  }

  const probaTxt = citesteStartFisier(caleTxt);
  const sep = detecteazaSeparator(probaTxt || fs.readFileSync(caleCsv, "utf8"));
  const harta = new Map();

  const stream = readline.createInterface({
    input: fs.createReadStream(caleTxt, "utf8"),
    crlfDelay: Infinity,
  });

  let prima = true;
  let contor = 0;

  for await (const linie of stream) {
    // Daca .txt are si el antet, sarim prima linie.
    if (prima) {
      prima = false;
      // Heuristica: daca prima linie contine litere pe pozitia CUI, e antet.
      const test = linie.split(sep)[idx.__cui] ?? "";
      if (!/^\d+$/.test(test.trim())) continue;
    }

    const campuri = linie.split(sep);
    const cui = (campuri[idx.__cui] ?? "").trim();
    if (!cui) continue;

    const inreg = { an };
    for (const cheia of Object.keys(MAPARE_INDICATORI)) {
      if (idx[cheia] !== undefined) {
        inreg[cheia] = laNumar(campuri[idx[cheia]]);
      }
    }
    harta.set(cui, inreg);
    contor++;
  }

  console.log(`[BILANT] Anul ${an}: ${contor} firme incarcate in index.`);
  return harta;
}

// Cauta bilantul unei firme. Primeste indexul deja incarcat.
function getBilant(harta, cui) {
  return harta.get(String(cui).trim()) ?? null;
}

module.exports = { incarcaBilanturi, getBilant };
