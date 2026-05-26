const http = require("http");
const { getIdentificare } = require("./anaf");
const { normalizeaza } = require("./normalizare");

const PORT = Number(process.env.PORT || 3000);

function trimiteJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

function citesteBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error("Request prea mare."));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function extrageCuiuri(text) {
  return String(text || "")
    .split(/[\r\n,;]+/)
    .map((linie) => linie.trim())
    .filter(Boolean);
}

const pagina = `<!doctype html>
<html lang="ro">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SRM CUI Pipeline</title>
  <style>
    :root {
      color-scheme: light;
      font-family: Inter, Segoe UI, Arial, sans-serif;
      background: #f6f7f9;
      color: #1d252d;
    }
    body {
      margin: 0;
      min-height: 100vh;
    }
    header {
      background: #ffffff;
      border-bottom: 1px solid #dde3ea;
      padding: 20px 28px;
    }
    main {
      max-width: 1120px;
      margin: 0 auto;
      padding: 28px;
    }
    h1 {
      margin: 0;
      font-size: 24px;
      font-weight: 700;
    }
    .subtitle {
      margin: 6px 0 0;
      color: #5d6b78;
      font-size: 14px;
    }
    .toolbar {
      display: grid;
      grid-template-columns: minmax(260px, 1fr) auto;
      gap: 12px;
      align-items: start;
      margin-bottom: 18px;
    }
    textarea {
      min-height: 112px;
      resize: vertical;
      border: 1px solid #c9d3de;
      border-radius: 8px;
      padding: 12px;
      font: inherit;
      background: #fff;
    }
    button {
      min-height: 44px;
      border: 0;
      border-radius: 8px;
      background: #126f74;
      color: #fff;
      padding: 0 18px;
      font-weight: 700;
      cursor: pointer;
    }
    button:disabled {
      opacity: .6;
      cursor: progress;
    }
    .status {
      min-height: 24px;
      color: #4b5a66;
      font-size: 14px;
      margin-bottom: 14px;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }
    .metric {
      background: #fff;
      border: 1px solid #dde3ea;
      border-radius: 8px;
      padding: 14px;
    }
    .metric strong {
      display: block;
      font-size: 24px;
      margin-bottom: 4px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      background: #fff;
      border: 1px solid #dde3ea;
      border-radius: 8px;
      overflow: hidden;
    }
    th, td {
      border-bottom: 1px solid #edf1f5;
      padding: 10px;
      text-align: left;
      font-size: 13px;
      vertical-align: top;
    }
    th {
      background: #eef3f6;
      color: #35434f;
      font-weight: 700;
    }
    tr:last-child td {
      border-bottom: 0;
    }
    .empty {
      background: #fff;
      border: 1px dashed #c9d3de;
      border-radius: 8px;
      padding: 22px;
      color: #5d6b78;
    }
    @media (max-width: 720px) {
      main { padding: 18px; }
      .toolbar, .summary { grid-template-columns: 1fr; }
      table { display: block; overflow-x: auto; }
    }
  </style>
</head>
<body>
  <header>
    <h1>SRM CUI Pipeline</h1>
    <p class="subtitle">Interogare live ANAF, fara scraping HTML.</p>
  </header>
  <main>
    <section class="toolbar">
      <textarea id="cuiuri" placeholder="Introdu CUI-uri, unul pe linie sau separate prin virgula">14399840</textarea>
      <button id="ruleaza">Ruleaza live</button>
    </section>
    <div id="status" class="status"></div>
    <section class="summary">
      <div class="metric"><strong id="gasite">0</strong>Gasite</div>
      <div class="metric"><strong id="negasite">0</strong>Negasite</div>
      <div class="metric"><strong id="esuate">0</strong>Loturi esuate</div>
    </section>
    <section id="rezultate" class="empty">Rezultatele apar aici.</section>
  </main>
  <script>
    const btn = document.getElementById("ruleaza");
    const statusEl = document.getElementById("status");
    const rezultateEl = document.getElementById("rezultate");
    const gasiteEl = document.getElementById("gasite");
    const negasiteEl = document.getElementById("negasite");
    const esuateEl = document.getElementById("esuate");

    function esc(v) {
      return String(v ?? "").replace(/[&<>"']/g, (c) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[c]));
    }

    function rand(r) {
      return "<tr>" +
        "<td>" + esc(r.cui) + "</td>" +
        "<td>" + esc(r.denumire) + "</td>" +
        "<td>" + esc(r.judet) + "</td>" +
        "<td>" + esc(r.localitate) + "</td>" +
        "<td>" + esc(r.codCaen) + "</td>" +
        "<td>" + esc(r.stareInregistrare) + "</td>" +
        "<td>" + (r.platitorTva ? "Da" : "Nu") + "</td>" +
        "<td>" + (r.roEFactura ? "Da" : "Nu") + "</td>" +
      "</tr>";
    }

    btn.addEventListener("click", async () => {
      btn.disabled = true;
      statusEl.textContent = "Interoghez ANAF live...";
      rezultateEl.className = "empty";
      rezultateEl.textContent = "Se incarca...";
      try {
        const res = await fetch("/api/lookup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cuiuri: document.getElementById("cuiuri").value })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Eroare necunoscuta.");

        gasiteEl.textContent = data.randuri.length;
        negasiteEl.textContent = data.negasite.length;
        esuateEl.textContent = data.esuate.length;
        statusEl.textContent = "Gata. Ultima rulare: " + new Date(data.rulatLa).toLocaleString("ro-RO");

        if (!data.randuri.length) {
          rezultateEl.className = "empty";
          rezultateEl.textContent = "Nu s-au gasit firme pentru CUI-urile introduse.";
          return;
        }

        rezultateEl.className = "";
        rezultateEl.innerHTML = "<table><thead><tr>" +
          "<th>CUI</th><th>Denumire</th><th>Judet</th><th>Localitate</th><th>CAEN</th><th>Stare</th><th>TVA</th><th>e-Factura</th>" +
          "</tr></thead><tbody>" + data.randuri.map(rand).join("") + "</tbody></table>";
      } catch (e) {
        statusEl.textContent = "Eroare: " + e.message;
        rezultateEl.className = "empty";
        rezultateEl.textContent = "Nu am putut finaliza interogarea.";
      } finally {
        btn.disabled = false;
      }
    });
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(pagina);
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    trimiteJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && req.url === "/api/lookup") {
    try {
      const body = JSON.parse(await citesteBody(req) || "{}");
      const cuiuri = Array.isArray(body.cuiuri) ? body.cuiuri : extrageCuiuri(body.cuiuri);
      if (!cuiuri.length) {
        trimiteJson(res, 400, { error: "Introdu cel putin un CUI." });
        return;
      }
      if (cuiuri.length > 100) {
        trimiteJson(res, 400, { error: "Preview-ul accepta maximum 100 CUI-uri per rulare." });
        return;
      }

      const { rezultate, negasite, esuate } = await getIdentificare(cuiuri);
      const randuri = normalizeaza({ identificare: rezultate, bilanturi: new Map() });
      trimiteJson(res, 200, {
        randuri,
        negasite,
        esuate,
        rulatLa: new Date().toISOString(),
      });
    } catch (e) {
      trimiteJson(res, 500, { error: e.message });
    }
    return;
  }

  trimiteJson(res, 404, { error: "Ruta inexistenta." });
});

server.listen(PORT, () => {
  console.log(`[WEB] SRM CUI Pipeline ruleaza la http://localhost:${PORT}`);
});
