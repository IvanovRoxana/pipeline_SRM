// =============================================================
//  STRATUL 3 — Normalizare (lipire pe CUI + mapare spre SRM)
// =============================================================
//  Primeste:
//    - identificare: Map cui -> date ANAF
//    - bilanturi:    Map cui -> indicatori MF (poate fi gol)
//  Intoarce: un array de obiecte gata de trimis spre Dynamics,
//  cu numele de campuri pe care le VREI in SRM (le poti redenumi mai jos).
// =============================================================

// AICI mapezi spre numele logice ale campurilor tale din Dynamics.
// Numele REALE de coloana din Dynamics (cu prefixul publisher-ului, ex.
// "new_cui", "cgo_cifraafaceri") le pui in dynamics.js, nu aici. Aici
// tii o forma curata, neutra.
function normalizeaza({ identificare, bilanturi }) {
  const randuri = [];

  for (const [cui, anaf] of identificare.entries()) {
    const bil = bilanturi.get(cui) ?? null;

    randuri.push({
      // --- cheia de upsert ---
      cui,

      // --- identificare (de la ANAF) ---
      denumire: anaf.denumire,
      adresa: anaf.adresa,
      judet: anaf.judetSediu,
      localitate: anaf.localitateSediu,
      nrRegCom: anaf.nrRegCom,
      codCaen: anaf.codCaen,
      formaJuridica: anaf.formaJuridica,
      telefon: anaf.telefon,
      iban: anaf.iban,
      dataInregistrare: anaf.dataInregistrare,

      // --- status fiscal (de la ANAF) ---
      stareInregistrare: anaf.stareInregistrare,
      platitorTva: anaf.platitorTva,
      tvaLaIncasare: anaf.tvaLaIncasare,
      splitTva: anaf.splitTva,
      roEFactura: anaf.roEFactura,
      inactiv: anaf.inactiv,
      dataRadiere: anaf.dataRadiere,

      // --- bilant (de la MF; poate lipsi -> null) ---
      anBilant: bil?.an ?? null,
      cifraAfaceri: bil?.cifraAfaceri ?? null,
      profitNet: bil?.profitNet ?? null,
      pierdereNeta: bil?.pierdereNeta ?? null,
      profitBrut: bil?.profitBrut ?? null,
      venituriTotale: bil?.venituriTotale ?? null,
      cheltuieliTotale: bil?.cheltuieliTotale ?? null,
      numarAngajati: bil?.numarAngajati ?? null,
      activeImobilizate: bil?.activeImobilizate ?? null,
      activeCirculante: bil?.activeCirculante ?? null,
      datorii: bil?.datorii ?? null,
      capitalTotal: bil?.capitalTotal ?? null,

      // --- metadata utila ---
      areBilant: bil != null,
      dataActualizare: new Date().toISOString(),
    });
  }

  return randuri;
}

module.exports = { normalizeaza };
