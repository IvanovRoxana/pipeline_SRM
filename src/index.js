// =============================================================
//  ORCHESTRATOR — leaga toate straturile
// =============================================================
//  Flux: citeste CUI-uri -> ANAF -> bilant -> normalizare -> livrare.
//
//  Doua moduri:
//    DRY-RUN (implicit): scrie rezultatul intr-un CSV local. Nu atinge
//                        Dynamics. Perfect ca sa verifici datele intai.
//    LIVE: trimite in Dynamics. Pornit doar daca ai setat variabilele
//          de mediu pentru credentiale (vezi mai jos).
//
//  Rulare:
//    node src/index.js cuiuri.csv
//
//  Variabile de mediu pentru modul LIVE (altfel ramane dry-run):
//    DYN_TENANT_ID, DYN_CLIENT_ID, DYN_CLIENT_SECRET, DYN_RESOURCE_URL
//    Ex. DYN_RESOURCE_URL=https://orgname.crm4.dynamics.com
// =============================================================

const fs = require("fs");
const path = require("path");
const { getIdentificare } = require("./anaf");
const { incarcaBilanturi } = require("./bilant");
const { normalizeaza } = require("./normalizare");
const { livreazaInDynamics } = require("./dynamics");

// --- citeste lista de CUI-uri dintr-un CSV/TXT (un CUI per linie sau prima coloana) ---
function citesteCuiuri(cale) {
  const continut = fs.readFileSync(cale, "utf8");
  return continut
    .split(/\r?\n/)
    .map((l) => l.split(/[,;]/)[0].trim()) // prima coloana, oricare ar fi separatorul
    .filter((l) => l && /\d/.test(l));      // doar linii care contin cifre
}

// --- scrie rezultatul normalizat intr-un CSV (pentru dry-run / verificare) ---
function scrieCsv(randuri, cale) {
  if (!randuri.length) {
    fs.writeFileSync(cale, "");
    return;
  }
  const coloane = Object.keys(randuri[0]);
  const escape = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const linii = [coloane.join(",")];
  for (const r of randuri) linii.push(coloane.map((c) => escape(r[c])).join(","));
  fs.writeFileSync(cale, linii.join("\n"), "utf8");
}

async function main() {
  const fisierCui = process.argv[2];
  if (!fisierCui) {
    console.error("Foloseste: node src/index.js <fisier-cuiuri.csv>");
    process.exit(1);
  }

  // 1. SURSA
  const cuiuri = citesteCuiuri(fisierCui);
  console.log(`[MAIN] ${cuiuri.length} CUI-uri citite din ${fisierCui}`);

  // 2a. ANAF (identificare + fiscal)
  const {
    rezultate: identificare,
    negasite,
    esuate: loturiAnafEsuate = [],
  } = await getIdentificare(cuiuri);

  if (loturiAnafEsuate.length) {
    const caleRaportAnaf = path.join(__dirname, "..", "raport_anaf_esuate.json");
    fs.writeFileSync(caleRaportAnaf, JSON.stringify(loturiAnafEsuate, null, 2), "utf8");
    console.warn(`[MAIN] ANAF a lasat ${loturiAnafEsuate.length} loturi nerezolvate dupa retry.`);
    console.warn(`[MAIN] Raport loturi esuate: ${caleRaportAnaf}`);
  }

  // 2b. BILANT (din fisierul oficial data.gov.ro, daca exista local)
  //     Pune fisierele descarcate in folderul ./date/ si actualizeaza numele.
  const anBilant = 2024; // ultimul an disponibil; actualizezi anual
  const bilanturi = await incarcaBilanturi({
    caleTxt: path.join(__dirname, "..", "date", `situatii_${anBilant}.txt`),
    caleCsv: path.join(__dirname, "..", "date", `situatii_${anBilant}.csv`),
    an: anBilant,
  });

  // 3. NORMALIZARE
  const randuri = normalizeaza({ identificare, bilanturi });
  console.log(`[MAIN] ${randuri.length} randuri normalizate (${negasite.length} CUI negasite la ANAF).`);

  // 4. LIVRARE
  const live =
    process.env.DYN_TENANT_ID &&
    process.env.DYN_CLIENT_ID &&
    process.env.DYN_CLIENT_SECRET &&
    process.env.DYN_RESOURCE_URL;

  if (live) {
    const raport = await livreazaInDynamics(randuri, {
      tenantId: process.env.DYN_TENANT_ID,
      clientId: process.env.DYN_CLIENT_ID,
      clientSecret: process.env.DYN_CLIENT_SECRET,
      resourceUrl: process.env.DYN_RESOURCE_URL,
    });
    fs.writeFileSync(
      path.join(__dirname, "..", "raport_livrare.json"),
      JSON.stringify(
        {
          ...raport,
          anaf: {
            negasite,
            loturiEsuate: loturiAnafEsuate,
          },
        },
        null,
        2
      ),
      "utf8"
    );
  } else {
    const caleOut = path.join(__dirname, "..", "rezultat.csv");
    scrieCsv(randuri, caleOut);
    console.log(`[MAIN] DRY-RUN. Niciun credential Dynamics setat.`);
    console.log(`[MAIN] Rezultatul a fost scris in: ${caleOut}`);
    console.log(`[MAIN] Verifica-l, apoi seteaza variabilele DYN_* pentru livrare reala.`);
  }
}

main().catch((e) => {
  console.error("[MAIN] Eroare fatala:", e);
  process.exit(1);
});
