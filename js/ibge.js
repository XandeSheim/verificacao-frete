/*
 * Base de CEPs automática (IBGE – CNEFE, Censo 2022)
 * ==================================================
 * Mesma base do Frete Regional, com mais informação por CEP para o relatório:
 * município, localidade/bairro, logradouro e quantidade de endereços.
 *
 * 1. A malha de municípios vem junto com o site (data/malha_municipios.geojson)
 * 2. Descobre quais municípios o polígono toca
 * 3. Baixa só o CNEFE desses municípios (lendo o zip em streaming) e reduz a
 *    1 ponto por CEP (mediana dos endereços)
 * 4. Guarda o resultado no navegador (IndexedDB próprio, separado do Frete Regional)
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CoberturaIBGE = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const CNEFE_URL = "https://ftp.ibge.gov.br/Cadastro_Nacional_de_Enderecos_para_Fins_Estatisticos/" +
    "Censo_Demografico_2022/Arquivos_CNEFE/CSV/Municipio/";

  const MARGEM_GRAUS = 0.03;  // ~3 km de folga para municípios na borda do polígono
  const NIVEL_GEO_MAX = 4;    // NV_GEO_COORD 1-4 = endereço/face de quadra; 5-6 = localidade/setor
  const MAX_MUNICIPIOS = 80;
  const DB_NAME = "cobertura-cep";
  const CACHE_VERSION = 1;

  const lib = (name, nodeName) =>
    root[name] || (typeof require === "function" ? require(nodeName) : null);
  const fmt = (n) => n.toLocaleString("pt-BR");
  const titleCase = (s) => s.toLowerCase().replace(/(^|[\s'(/-])\S/g, (c) => c.toUpperCase())
    .replace(/\b(D[aeo]s?|E)\b/g, (w) => w.toLowerCase());

  // ------------------------------------------------------------- geometria
  function polysOf(geometry) {
    return geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  }

  function bbox(polys) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const rings of polys) for (const [x, y] of rings[0]) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return [x0, y0, x1, y1];
  }

  function pointSegDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  function segDist(a, b, c, d) {
    const cross = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
    const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
    if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))) return 0;
    return Math.min(
      pointSegDist(a[0], a[1], c[0], c[1], d[0], d[1]), pointSegDist(b[0], b[1], c[0], c[1], d[0], d[1]),
      pointSegDist(c[0], c[1], a[0], a[1], b[0], b[1]), pointSegDist(d[0], d[1], a[0], a[1], b[0], b[1])
    );
  }

  function pointInRing(ring, x, y) {
    let r = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) r = !r;
    }
    return r;
  }
  const inside = (polys, x, y) =>
    polys.some((rings) => pointInRing(rings[0], x, y) && !rings.slice(1).some((h) => pointInRing(h, x, y)));

  function nearPolygon(muni, region, margem) {
    if (region.some((rings) => inside(muni, rings[0][0][0], rings[0][0][1]))) return true;
    if (muni.some((rings) => inside(region, rings[0][0][0], rings[0][0][1]))) return true;
    for (const mr of muni) for (const ring of mr) for (let i = 1; i < ring.length; i++) {
      const a = ring[i - 1], b = ring[i];
      for (const sr of region) for (const sring of sr) for (let j = 1; j < sring.length; j++) {
        if (segDist(a, b, sring[j - 1], sring[j]) <= margem) return true;
      }
    }
    return false;
  }

  // ------------------------------------------------------------- cache (IndexedDB)
  const cache = {
    db: null,
    async open() {
      if (this.db !== null) return this.db;
      this.db = await new Promise((resolve) => {
        try {
          const req = root.indexedDB.open(DB_NAME, 1);
          req.onupgradeneeded = () => req.result.createObjectStore("ceps");
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(false);
        } catch { resolve(false); }
      });
      return this.db;
    },
    async get(code) {
      const db = await this.open();
      if (!db) return null;
      return new Promise((resolve) => {
        try {
          const req = db.transaction("ceps").objectStore("ceps").get(code);
          req.onsuccess = () => resolve(req.result && req.result.v === CACHE_VERSION ? req.result : null);
          req.onerror = () => resolve(null);
        } catch { resolve(null); }
      });
    },
    async set(code, value) {
      const db = await this.open();
      if (!db) return;
      try { db.transaction("ceps", "readwrite").objectStore("ceps").put({ ...value, v: CACHE_VERSION }, code); } catch {}
    },
    async clear() {
      const db = await this.open();
      if (!db) return;
      await new Promise((resolve) => {
        try { const tx = db.transaction("ceps", "readwrite"); tx.objectStore("ceps").clear(); tx.oncomplete = resolve; tx.onerror = resolve; }
        catch { resolve(); }
      });
    },
  };

  /** O CNEFE pode vir em UTF-8 ou Windows-1252: decide pelo começo do arquivo. */
  function pickDecoder(bytes) {
    let end = bytes.length;
    const nl = bytes.lastIndexOf(10);
    if (nl > 0) end = nl;
    try { new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)); return new TextDecoder("utf-8"); }
    catch { return new TextDecoder("windows-1252"); }
  }

  // ------------------------------------------------------------- IBGE
  function createIbge({ loadMalha }) {
    let malha = null;
    const listings = {};

    async function municipiosNoPoligono(polys) {
      if (!malha) {
        const gj = await loadMalha();
        malha = gj.features.map((f) => {
          const p = polysOf(f.geometry);
          return { code: f.properties.codarea, polys: p, bbox: bbox(p) };
        });
      }
      const [x0, y0, x1, y1] = bbox(polys);
      const m = MARGEM_GRAUS;
      return malha
        .filter(({ bbox: b }) => b[0] <= x1 + m && b[2] >= x0 - m && b[1] <= y1 + m && b[3] >= y0 - m)
        .filter((mu) => nearPolygon(mu.polys, polys, m))
        .map((mu) => mu.code)
        .sort();
    }

    async function getText(url) {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`IBGE respondeu ${resp.status} em ${url}`);
      return new TextDecoder("windows-1252").decode(await resp.arrayBuffer());
    }

    async function arquivoMunicipio(code) {
      const uf = code.slice(0, 2);
      if (!listings[uf]) {
        if (!listings.root) {
          const html = await getText(CNEFE_URL);
          listings.root = {};
          for (const [, m] of html.matchAll(/href="(\d{2}_[A-Z]{2}\/)"/g)) listings.root[m.slice(0, 2)] = m;
        }
        const pasta = listings.root[uf];
        if (!pasta) throw new Error(`UF ${uf} não encontrada no servidor do IBGE.`);
        const html = await getText(CNEFE_URL + pasta);
        listings[uf] = {};
        for (const [, m] of html.matchAll(/href="(\d{7}_[^"]+\.zip)"/g)) listings[uf][m.slice(0, 7)] = CNEFE_URL + pasta + m;
      }
      const url = listings[uf][code];
      if (!url) throw new Error(`Município ${code} não encontrado no CNEFE do IBGE.`);
      return url;
    }

    async function baixarMunicipio(code, i, n, log) {
      const fflate = lib("fflate", "fflate");
      const url = await arquivoMunicipio(code);
      const uf = decodeURIComponent(url.split("/").slice(-2, -1)[0]).slice(3, 5);
      const nome = titleCase(decodeURIComponent(url.split("/").pop()).slice(8, -4).replace(/_/g, " "));
      log(`  [${i}/${n}] Baixando endereços de ${nome}/${uf} (IBGE)...`, "info");

      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`IBGE respondeu ${resp.status} ao baixar ${nome}.`);
      const total = Number(resp.headers.get("content-length")) || 0;

      // CEP -> { p: tem endereço preciso, lat: [], lon: [], n: endereços, rua, loc }
      const agg = new Map();
      let col = null, rest = "", csvFound = false, zipErr = null, dec = null;
      const unq = (s) => (s || "").replace(/^"|"$/g, "").trim();

      const handleLine = (line) => {
        if (!line) return;
        const f = line.split(";");
        if (!col) {
          const h = f.map((x) => unq(x).toUpperCase());
          const ix = (c) => h.indexOf(c);
          col = {
            cep: ix("CEP"), lat: ix("LATITUDE"), lon: ix("LONGITUDE"), nv: ix("NV_GEO_COORD"),
            loc: ix("DSC_LOCALIDADE"), tipo: ix("NOM_TIPO_SEGLOGR"), tit: ix("NOM_TITULO_SEGLOGR"), rua: ix("NOM_SEGLOGR"),
          };
          if (col.cep < 0 || col.lat < 0 || col.lon < 0) throw new Error(`Arquivo do IBGE de ${nome} em formato inesperado.`);
          return;
        }
        const cep = (f[col.cep] || "").replace(/\D/g, "");
        if (!cep) return;
        let e = agg.get(cep);
        if (!e) agg.set(cep, (e = { p: false, lat: [], lon: [], n: 0, rua: "", loc: "" }));
        e.n++;
        if (!e.rua && col.rua >= 0) e.rua = [col.tipo, col.tit, col.rua].map((k) => (k >= 0 ? unq(f[k]) : "")).filter(Boolean).join(" ");
        if (!e.loc && col.loc >= 0) e.loc = unq(f[col.loc]);
        const lat = parseFloat(unq(f[col.lat]).replace(",", ".")), lon = parseFloat(unq(f[col.lon]).replace(",", "."));
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
        const precise = col.nv < 0 || Number(unq(f[col.nv])) <= NIVEL_GEO_MAX;
        if (precise && !e.p) { e.p = true; e.lat = []; e.lon = []; }
        else if (!precise && e.p) return;
        e.lat.push(lat); e.lon.push(lon);
      };
      const handleText = (text, final) => {
        const lines = (rest + text).split("\n");
        rest = final ? "" : lines.pop();
        for (const l of lines) handleLine(l.replace(/\r$/, ""));
      };

      const unzip = new fflate.Unzip();
      unzip.register(fflate.UnzipInflate);
      unzip.onfile = (file) => {
        if (csvFound || !/\.csv$/i.test(file.name)) return;
        csvFound = true;
        file.ondata = (err, chunk, final) => {
          if (err) { zipErr = err; return; }
          try {
            if (!dec) dec = pickDecoder(chunk);
            handleText(dec.decode(chunk, { stream: !final }), final);
          } catch (e) { zipErr = e; }
        };
        file.start();
      };

      const reader = resp.body.getReader();
      let done = 0, nextReport = 0.25;
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) { unzip.push(new Uint8Array(0), true); break; }
        unzip.push(value, false);
        if (zipErr) { reader.cancel(); throw zipErr; }
        done += value.length;
        if (total > 20e6 && done / total >= nextReport) {
          log(`    ${nome}: ${Math.round((100 * done) / total)}% de ${Math.round(total / 1e6)} MB`, "info");
          nextReport += 0.25;
        }
      }
      if (zipErr) throw zipErr;
      if (!csvFound) throw new Error(`O zip do IBGE de ${nome} não tem CSV.`);

      const median = (arr) => {
        const s = Float64Array.from(arr).sort(), m = s.length >> 1;
        return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
      };
      const rows = [...agg].filter(([, e]) => e.lat.length);
      const size = rows.length;
      const out = {
        nome: `${nome}/${uf}`, ceps: new Int32Array(size), lat: new Float64Array(size), lon: new Float64Array(size),
        n: new Int32Array(size), rua: new Array(size), loc: new Array(size),
      };
      rows.forEach(([cep, e], k) => {
        out.ceps[k] = parseInt(cep, 10); out.lat[k] = median(e.lat); out.lon[k] = median(e.lon);
        out.n[k] = e.n; out.rua[k] = titleCase(e.rua); out.loc[k] = titleCase(e.loc);
      });
      log(`         ${nome}: ${fmt(size)} CEPs`, "success");
      return out;
    }

    /** [{cep, lat, lon, n, rua, bairro, cidade}] de todos os municípios que o polígono toca. */
    async function cepsForPolygon(polys, log = () => {}) {
      const codes = await municipiosNoPoligono(polys);
      if (!codes.length) {
        throw new Error("O polígono não toca nenhum município do Brasil. " +
          "Confira se o GeoJSON está correto (longitude, latitude).");
      }
      if (codes.length > MAX_MUNICIPIOS) {
        throw new Error(`O polígono toca ${codes.length} municípios (limite: ${MAX_MUNICIPIOS}). Divida a região em partes menores.`);
      }
      const cached = {};
      for (const c of codes) cached[c] = await cache.get(c);
      const faltando = codes.filter((c) => !cached[c]).length;
      log(`Municípios na região: ${codes.length} (${codes.length - faltando} já salvos no navegador, ${faltando} para baixar do IBGE)`, "info");

      const out = [];
      for (let i = 0; i < codes.length; i++) {
        let d = cached[codes[i]];
        if (!d) {
          d = await baixarMunicipio(codes[i], i + 1, codes.length, log);
          await cache.set(codes[i], d);
        }
        for (let k = 0; k < d.ceps.length; k++) {
          out.push({ cep: d.ceps[k], lat: d.lat[k], lon: d.lon[k], n: d.n[k], rua: d.rua[k], bairro: d.loc[k], cidade: d.nome });
        }
      }
      return out;
    }

    return { cepsForPolygon, municipiosNoPoligono };
  }

  return { createIbge, clearCache: () => cache.clear() };
});
