/*
 * Cobertura CEP – processador (roda no navegador e no Node)
 * =========================================================
 * 1. Lê o GeoJSON da região -> polígonos
 * 2. Busca os CEPs da região no IBGE (ibge.js) ou numa base própria
 * 3. Lê as planilhas de frete de referência (todas as abas) -> faixas [início, fim]
 * 4. Classifica cada CEP dentro do polígono:
 *      coberto  – alguma faixa da planilha contém o CEP
 *      parcial  – coberto, mas só por faixas de peso menores que o peso máximo das planilhas
 *      sem      – nenhuma faixa contém o CEP
 * 5. Agrupa os CEPs sem cobertura em faixas "seguras" (sem nenhum outro CEP
 *    conhecido no meio) e exporta tudo em .xlsx
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Cobertura = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const lib = (name, nodeName) =>
    root[name] || (typeof require === "function" ? require(nodeName) : null);
  const norm = (name) => String(name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const fmt = (n) => n.toLocaleString("pt-BR");
  const tick = () => new Promise((r) => setTimeout(r, 0));

  // ===========================================================================
  // COLUNAS (mesmos nomes aceitos pelo Frete Regional)
  // ===========================================================================
  const COLUMN_ALIASES = {
    cep_inicio: ["cepinicio", "cepinicial", "zipcodestart", "zipstart", "cepde"],
    cep_fim: ["cepfim", "cepfinal", "zipcodeend", "zipend", "cepate"],
    peso_fim: ["weightend", "pesofim", "pesofinal", "pesoate", "pesomaximo"],
  };
  const CONFIG_KEYS = { cep_inicio: "cep_inicio", cep_fim: "cep_fim", peso_fim: "peso_fim" };

  function loadColumnConfig(cfg) {
    const aliases = {};
    for (const [k, v] of Object.entries(COLUMN_ALIASES)) aliases[k] = [...v];
    for (const [key, colName] of Object.entries(cfg || {})) {
      const logical = CONFIG_KEYS[key.toLowerCase()];
      if (logical) aliases[logical].unshift(norm(colName));
    }
    return aliases;
  }

  function resolveColumns(headers, aliases) {
    const byNorm = new Map();
    headers.forEach((h, i) => { if (!byNorm.has(norm(h))) byNorm.set(norm(h), i); });
    const out = {};
    for (const [logical, names] of Object.entries(aliases)) {
      const hit = names.find((a) => byNorm.has(a));
      out[logical] = hit === undefined ? -1 : byNorm.get(hit);
    }
    return out;
  }

  // ===========================================================================
  // GEOJSON
  // ===========================================================================
  function readGeojsonPolygons(gj) {
    let geoms;
    if (gj && gj.type === "FeatureCollection") geoms = (gj.features || []).map((f) => f && f.geometry);
    else if (gj && gj.type === "Feature") geoms = [gj.geometry];
    else geoms = [gj];
    const polys = [];
    for (const g of geoms) {
      if (!g) continue;
      if (g.type === "Polygon") polys.push(g.coordinates);
      else if (g.type === "MultiPolygon") polys.push(...g.coordinates);
    }
    if (!polys.length) throw new Error("O GeoJSON não contém nenhum polígono (Polygon/MultiPolygon).");
    return polys;
  }

  function pointInRing(ring, x, y) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function pointInPolygons(polys, x, y) {
    for (const rings of polys) {
      if (pointInRing(rings[0], x, y) && !rings.slice(1).some((h) => pointInRing(h, x, y))) return true;
    }
    return false;
  }
  function bboxOf(polys) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const rings of polys) for (const [x, y] of rings[0]) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return [x0, y0, x1, y1];
  }

  // ===========================================================================
  // LEITURA (planilhas e base própria)
  // ===========================================================================
  function cepToInt(v) {
    if (v === null || v === undefined || v === "") return -1;
    if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : -1;
    let s = String(v).trim();
    if (/^\d+\.0+$/.test(s)) s = s.split(".")[0];
    const digits = s.replace(/\D/g, "");
    return digits ? parseInt(digits, 10) : -1;
  }
  const toNum = (v) => (typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/\./g, (m, i, s) => (s.includes(",") ? "" : m)).replace(",", ".")));
  const cepStr = (n) => { const s = String(n).padStart(8, "0"); return `${s.slice(0, 5)}-${s.slice(5)}`; };

  function parseCsv(text) {
    text = text.replace(/^﻿/, "");
    const first = text.slice(0, text.indexOf("\n") + 1 || text.length);
    const sep = [",", ";", "\t", "|"].reduce((a, b) => (first.split(b).length > first.split(a).length ? b : a));
    const rows = [];
    let row = [], field = "", quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
        else field += ch;
      } else if (ch === '"' && field === "") quoted = true;
      else if (ch === sep) { row.push(field); field = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(field); rows.push(row); row = []; field = "";
      } else field += ch;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    return rows.map((r) => r.map((v) => (v === "" ? null : v)));
  }

  function decodeText(bytes) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { return new TextDecoder("windows-1252").decode(bytes); }
  }
  const isBlank = (v) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

  function readSheets(name, data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const ext = name.toLowerCase().split(".").pop();
    if (ext === "csv" || ext === "txt") return { csv: parseCsv(decodeText(bytes)) };
    if (ext !== "xls" && ext !== "xlsx") throw new Error(`Formato não suportado: ${name} (use .xls, .xlsx ou .csv)`);
    const XLSX = lib("XLSX", "xlsx");
    let wb;
    try { wb = XLSX.read(bytes, { type: "array", cellDates: false }); }
    catch (e) { throw new Error(`Não foi possível ler '${name}': ${e.message}`); }
    const out = {};
    for (const sn of wb.SheetNames) {
      out[sn] = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: null, blankrows: false });
    }
    return out;
  }

  /** Planilha de frete -> faixas [{a, b, w}] (w = peso final da linha, ou null se não houver coluna). */
  function readRanges(name, data, aliases, log = () => {}) {
    const sheets = readSheets(name, data);
    const ranges = [];
    let used = 0, invalid = 0, hasWeight = false;
    for (const [sn, matrix] of Object.entries(sheets)) {
      const body = matrix.filter((r) => r && r.some((v) => !isBlank(v)));
      if (body.length < 2) continue;
      const head = body[0].map((h) => (h === null ? "" : String(h).trim()));
      const cols = resolveColumns(head, aliases);
      if (cols.cep_inicio < 0 || cols.cep_fim < 0) {
        log(`  ${name} / aba '${sn}' ignorada (sem colunas de CEP)`, "info");
        continue;
      }
      used++;
      if (cols.peso_fim >= 0) hasWeight = true;
      for (const r of body.slice(1)) {
        const a = cepToInt(r[cols.cep_inicio]), b = cepToInt(r[cols.cep_fim]);
        if (a < 0 || b < 0) { invalid++; continue; }
        const w = cols.peso_fim >= 0 ? toNum(r[cols.peso_fim]) : null;
        ranges.push({ a: Math.min(a, b), b: Math.max(a, b), w: Number.isFinite(w) ? w : null });
      }
    }
    if (!used) {
      throw new Error(`'${name}': nenhuma aba tem colunas de CEP inicial/final ` +
        "(ex.: ZipCodeStart/ZipCodeEnd ou cep_inicio/cep_fim). Se os nomes forem diferentes, use um config.json.");
    }
    if (invalid) log(`  ${name}: ${fmt(invalid)} linha(s) com CEP inválido ignorada(s)`, "warning");
    return { ranges, hasWeight };
  }

  function normalizeCepBase(headers, rows) {
    const byNorm = new Map(headers.map((h, i) => [norm(h), i]));
    const pick = (...names) => { const n = names.find((x) => byNorm.has(x)); return n === undefined ? -1 : byNorm.get(n); };
    const c = {
      cep: pick("cep", "zipcode", "postcode"), lat: pick("latitude", "lat"), lon: pick("longitude", "lon", "lng"),
      bairro: pick("bairro", "localidade", "neighborhood"), cidade: pick("cidade", "municipio", "city"),
      rua: pick("logradouro", "rua", "endereco", "street"),
    };
    if (c.cep < 0 || c.lat < 0 || c.lon < 0) {
      throw new Error("A base de CEPs precisa das colunas: cep, latitude, longitude.\nEncontradas: " + headers.join(", "));
    }
    const get = (r, k) => (c[k] >= 0 && r[c[k]] != null ? String(r[c[k]]).trim() : "");
    const out = [];
    for (const r of rows) {
      const cep = cepToInt(r[c.cep]), lat = toNum(r[c.lat]), lon = toNum(r[c.lon]);
      if (cep > 0 && Number.isFinite(lat) && Number.isFinite(lon) && lat !== 0 && lon !== 0) {
        out.push({ cep, lat, lon, n: null, rua: get(r, "rua"), bairro: get(r, "bairro"), cidade: get(r, "cidade") });
      }
    }
    return out;
  }

  // ===========================================================================
  // COBERTURA
  // ===========================================================================
  /**
   * Para cada CEP (ordenado), descobre se alguma faixa o contém e o maior peso
   * final entre as faixas que o contêm. Varredura com heap de máximo: O((n+m) log m).
   */
  function classify(cepsSorted, ranges) {
    const rs = ranges.slice().sort((x, y) => x.a - y.a);
    const heap = []; // max-heap por w (null conta como +Infinity)
    const key = (r) => (r.w === null ? Infinity : r.w);
    const push = (r) => {
      heap.push(r);
      let i = heap.length - 1;
      while (i > 0) { const p = (i - 1) >> 1; if (key(heap[p]) >= key(heap[i])) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < heap.length && key(heap[l]) > key(heap[m])) m = l;
          if (r < heap.length && key(heap[r]) > key(heap[m])) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
        }
      }
      return top;
    };
    // Faixas encerradas que não estão no topo ficam no heap; isso só importa se
    // virarem topo, e aí são descartadas. Para "coberto" basta checar o topo
    // depois da limpeza: se o de maior peso terminou, removemos e olhamos o próximo.
    const out = new Array(cepsSorted.length);
    let j = 0;
    for (let i = 0; i < cepsSorted.length; i++) {
      const c = cepsSorted[i];
      while (j < rs.length && rs[j].a <= c) push(rs[j++]);
      while (heap.length && heap[0].b < c) pop();
      out[i] = heap.length ? { covered: true, w: heap[0].w } : { covered: false, w: null };
    }
    return out;
  }

  /**
   * opts = {
   *   freightFiles: [{name, data}], geojson, cepBase: {name, data} | null,
   *   ibge: async (polys, log) => [...], columnConfig, progress, log
   * }
   */
  async function run(opts) {
    const progress = opts.progress || (() => {});
    const log = opts.log || (() => {});
    const aliases = loadColumnConfig(opts.columnConfig);

    progress(5, "Lendo a região (GeoJSON)...");
    const polys = readGeojsonPolygons(opts.geojson);

    // 1) Base de CEPs
    let base;
    if (opts.cepBase) {
      progress(10, `Carregando base de CEPs: ${opts.cepBase.name}...`);
      const matrix = parseCsv(decodeText(new Uint8Array(opts.cepBase.data)));
      base = normalizeCepBase(matrix[0].map(String), matrix.slice(1));
    } else {
      progress(10, "Buscando os CEPs da região no IBGE (Censo 2022)...");
      base = await opts.ibge(polys, log);
    }
    log(`Base de CEPs: ${fmt(base.length)} CEPs com coordenadas`);

    // 2) CEPs dentro do polígono (únicos)
    progress(45, "Cruzando os CEPs com a região...");
    await tick();
    const [x0, y0, x1, y1] = bboxOf(polys);
    const byCep = new Map();
    const allCeps = new Set();
    for (const p of base) {
      allCeps.add(p.cep);
      if (byCep.has(p.cep)) continue;
      if (p.lon < x0 || p.lon > x1 || p.lat < y0 || p.lat > y1) continue;
      if (pointInPolygons(polys, p.lon, p.lat)) byCep.set(p.cep, p);
    }
    const region = [...byCep.values()].sort((a, b) => a.cep - b.cep);
    if (!region.length) {
      throw new Error("Nenhum CEP da base caiu dentro da região.\nConfira se o GeoJSON está no lugar certo (geojson.io).");
    }
    log(`CEPs dentro da região: ${fmt(region.length)}`, "success");

    // 3) Faixas das planilhas
    const ranges = [];
    let hasWeight = false;
    const n = opts.freightFiles.length;
    for (let i = 0; i < n; i++) {
      const { name, data } = opts.freightFiles[i];
      progress(50 + Math.floor((30 * i) / n), `Planilha ${i + 1}/${n}: ${name}`);
      await tick();
      const r = readRanges(name, data, aliases, log);
      ranges.push(...r.ranges);
      hasWeight = hasWeight || r.hasWeight;
      log(`  ${name}: ${fmt(r.ranges.length)} faixas de CEP`, "success");
    }
    if (!ranges.length) throw new Error("As planilhas não têm nenhuma faixa de CEP válida.");

    // 4) Classificação
    progress(85, "Calculando a cobertura...");
    await tick();
    const weights = ranges.map((r) => r.w).filter((w) => w !== null);
    const maxW = hasWeight && weights.length ? Math.max(...weights) : null;
    const cls = classify(region.map((p) => p.cep), ranges);
    const rows = region.map((p, i) => {
      const c = cls[i];
      let status = "sem";
      if (c.covered) status = maxW !== null && c.w !== null && c.w < maxW ? "parcial" : "coberto";
      return { ...p, status, pesoMax: c.covered ? c.w : null };
    });

    // 5) Faixas seguras de CEPs sem cobertura: quebra se houver no meio qualquer
    //    CEP conhecido (da base toda) que não seja "sem cobertura dentro da região"
    const sem = new Set(rows.filter((r) => r.status === "sem").map((r) => r.cep));
    const known = Int32Array.from(allCeps).sort();
    const gaps = [];
    let cur = null;
    for (const c of known) {
      if (sem.has(c)) {
        if (cur) { cur.b = c; cur.qtd++; } else cur = { a: c, b: c, qtd: 1 };
      } else if (cur) { gaps.push(cur); cur = null; }
    }
    if (cur) gaps.push(cur);
    const bySem = new Map(rows.filter((r) => r.status === "sem").map((r) => [r.cep, r]));
    for (const g of gaps) {
      const first = bySem.get(g.a), last = bySem.get(g.b);
      g.cidade = first.cidade; g.bairro = first.bairro === last.bairro ? first.bairro : `${first.bairro} → ${last.bairro}`;
    }

    // 6) Resumos
    const summary = (keyFn) => {
      const m = new Map();
      for (const r of rows) {
        const k = keyFn(r) || "(sem nome)";
        let s = m.get(k);
        if (!s) m.set(k, (s = { nome: k, total: 0, coberto: 0, parcial: 0, sem: 0, endSem: 0 }));
        s.total++; s[r.status]++;
        if (r.status === "sem") s.endSem += r.n || 0;
      }
      return [...m.values()].sort((a, b) => b.sem - a.sem || b.total - a.total);
    };
    const totals = { total: rows.length, coberto: 0, parcial: 0, sem: 0, end: 0, endSem: 0 };
    for (const r of rows) { totals[r.status]++; totals.end += r.n || 0; if (r.status === "sem") totals.endSem += r.n || 0; }
    totals.temEnderecos = rows.some((r) => r.n);

    progress(100, "Concluído!");
    return {
      polys, rows, gaps, totals, maxW, hasWeight: maxW !== null, faixas: ranges.length,
      porCidade: summary((r) => r.cidade), porBairro: summary((r) => (r.cidade ? `${r.bairro || "(sem bairro)"} – ${r.cidade}` : r.bairro)),
    };
  }

  // ===========================================================================
  // EXPORTAÇÃO
  // ===========================================================================
  const STATUS_LABEL = { coberto: "Coberto", parcial: "Cobertura parcial (peso)", sem: "Sem cobertura" };

  function exportXlsx(res, opts = {}) {
    const XLSX = lib("XLSX", "xlsx");
    const wb = XLSX.utils.book_new();
    const sheet = (name, header, data, widths) => {
      const ws = XLSX.utils.aoa_to_sheet([header, ...data]);
      ws["!cols"] = widths.map((wch) => ({ wch }));
      ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: data.length, c: header.length - 1 } }) };
      XLSX.utils.book_append_sheet(wb, ws, name);
    };
    const cepRow = (r) => [cepStr(r.cep), r.cidade || "", r.bairro || "", r.rua || "", r.n ?? "", +r.lat.toFixed(6), +r.lon.toFixed(6)];
    const cepHead = ["CEP", "Cidade", "Localidade/Bairro", "Logradouro", "Endereços (IBGE)", "Latitude", "Longitude"];
    const cepW = [11, 24, 28, 40, 16, 11, 11];

    sheet("CEPs sem cobertura", cepHead, res.rows.filter((r) => r.status === "sem").map(cepRow), cepW);
    sheet("Faixas sem cobertura",
      ["ZipCodeStart", "ZipCodeEnd", "Qtd. CEPs", "Cidade", "Localidade/Bairro"],
      res.gaps.map((g) => [cepStr(g.a), cepStr(g.b), g.qtd, g.cidade || "", g.bairro || ""]), [13, 13, 10, 24, 40]);
    if (res.hasWeight) {
      sheet("Cobertura parcial (peso)", [...cepHead, "Peso máx. atendido"],
        res.rows.filter((r) => r.status === "parcial").map((r) => [...cepRow(r), r.pesoMax]), [...cepW, 18]);
    }
    const sumHead = ["Nome", "CEPs na região", "Cobertos", ...(res.hasWeight ? ["Parcial (peso)"] : []), "Sem cobertura", "% cobertura", "Endereços sem cobertura"];
    const sumRow = (s) => [s.nome, s.total, s.coberto, ...(res.hasWeight ? [s.parcial] : []), s.sem,
      +((100 * (s.coberto + s.parcial)) / s.total).toFixed(1), s.endSem];
    sheet("Resumo por cidade", sumHead, res.porCidade.map(sumRow), [30, 14, 10, ...(res.hasWeight ? [14] : []), 14, 12, 22]);
    sheet("Resumo por bairro", sumHead, res.porBairro.map(sumRow), [44, 14, 10, ...(res.hasWeight ? [14] : []), 14, 12, 22]);
    sheet("Todos os CEPs da região", [...cepHead, "Status"],
      res.rows.map((r) => [...cepRow(r), STATUS_LABEL[r.status]]), [...cepW, 22]);
    if (opts.meta) {
      const ws = XLSX.utils.aoa_to_sheet(opts.meta);
      ws["!cols"] = [{ wch: 28 }, { wch: 60 }];
      XLSX.utils.book_append_sheet(wb, ws, "Sobre");
    }
    return new Uint8Array(XLSX.write(wb, { bookType: "xlsx", type: "array", compression: true }));
  }

  /** GeoJSON (pontos) dos CEPs sem cobertura – dá para abrir no geojson.io. */
  function exportGeojson(res) {
    return JSON.stringify({
      type: "FeatureCollection",
      features: res.rows.filter((r) => r.status === "sem").map((r) => ({
        type: "Feature",
        properties: { cep: cepStr(r.cep), cidade: r.cidade || "", bairro: r.bairro || "", logradouro: r.rua || "", enderecos: r.n ?? null },
        geometry: { type: "Point", coordinates: [+r.lon.toFixed(6), +r.lat.toFixed(6)] },
      })),
    });
  }

  return {
    run, classify, readGeojsonPolygons, bboxOf, readRanges, loadColumnConfig, exportXlsx, exportGeojson,
    cepStr, cepToInt, STATUS_LABEL,
  };
});
