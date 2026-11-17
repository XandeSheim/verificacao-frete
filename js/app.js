/* Interface da Verificação de Frete */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const fmt = (n) => n.toLocaleString("pt-BR");
  const pct = (a, b) => (b ? `${((100 * a) / b).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%` : "–");
  const COLORS = { sem: "#E5484D", parcial: "#F5A524", coberto: "#30A46C" };
  const MAX_COBERTOS_NO_MAPA = 40000;
  const MAX_LINHAS_TABELA = 300;

  const state = { freight: [], geojson: null, cepBase: null, config: null, running: false, urls: [], res: null, group: "bairro" };
  const ibge = CoberturaIBGE.createIbge({
    loadMalha: async () => {
      const resp = await fetch("data/malha_municipios.geojson");
      if (!resp.ok) throw new Error("Não foi possível carregar a malha de municípios do site.");
      return resp.json();
    },
  });

  // ------------------------------------------------------------------ tema
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  const THEME_KEY = "theme-v2";
  const themeBox = $("theme"), themeBtn = $("theme-btn"), themeMenu = $("theme-menu");
  const themeOpts = [...themeMenu.querySelectorAll("li")];
  let themeActive = 0;

  function applyTheme(mode) {
    if (mode === "light" || mode === "dark") document.documentElement.dataset.theme = mode;
    else { mode = "system"; delete document.documentElement.dataset.theme; }
    themeOpts.forEach((li, i) => {
      const sel = li.dataset.value === mode;
      li.setAttribute("aria-selected", sel);
      if (sel) { themeActive = i; $("theme-value").textContent = li.textContent; }
    });
    updateTiles();
    return mode;
  }
  function setActive(i) {
    themeActive = (i + themeOpts.length) % themeOpts.length;
    themeOpts.forEach((li, k) => li.classList.toggle("active", k === themeActive));
  }
  function openTheme() {
    themeBox.classList.add("open");
    themeBtn.setAttribute("aria-expanded", "true");
    setActive(themeActive);
    themeMenu.focus({ preventScroll: true });
  }
  function closeTheme(focusBtn = true) {
    if (!themeBox.classList.contains("open")) return;
    themeBox.classList.remove("open");
    themeBtn.setAttribute("aria-expanded", "false");
    themeOpts.forEach((li) => li.classList.remove("active"));
    if (focusBtn) themeBtn.focus({ preventScroll: true });
  }
  function chooseTheme(i) {
    store.set(THEME_KEY, applyTheme(themeOpts[i].dataset.value));
    closeTheme();
  }
  themeBtn.addEventListener("click", () => (themeBox.classList.contains("open") ? closeTheme() : openTheme()));
  themeBtn.addEventListener("keydown", (e) => {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) { e.preventDefault(); openTheme(); }
  });
  themeOpts.forEach((li, i) => {
    li.addEventListener("click", () => chooseTheme(i));
    li.addEventListener("mousemove", () => setActive(i));
  });
  themeMenu.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") setActive(themeActive + 1);
    else if (e.key === "ArrowUp") setActive(themeActive - 1);
    else if (e.key === "Home") setActive(0);
    else if (e.key === "End") setActive(themeOpts.length - 1);
    else if (e.key === "Enter" || e.key === " ") chooseTheme(themeActive);
    else if (e.key === "Escape") closeTheme();
    else { if (e.key === "Tab") closeTheme(false); return; }
    e.preventDefault();
  });
  document.addEventListener("pointerdown", (e) => { if (!themeBox.contains(e.target)) closeTheme(false); });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => updateTiles());

  // ------------------------------------------------------------------ log
  function log(msg, level = "info") {
    const line = document.createElement("span");
    line.className = level;
    line.textContent = `[${new Date().toLocaleTimeString("pt-BR")}] ${msg}\n`;
    $("log").appendChild(line);
    $("log").scrollTop = $("log").scrollHeight;
  }
  function setStatus(text, kind = "") { $("status").textContent = text; $("status").className = kind || "muted"; }
  function setProgress(p) { $("bar").style.width = `${p}%`; }

  // ------------------------------------------------------------------ planilhas
  function addFreight(files) {
    for (const f of files) {
      if (!/\.(xls|xlsx|csv)$/i.test(f.name)) { log(`Ignorado (formato não suportado): ${f.name}`, "warning"); continue; }
      if (state.freight.some((x) => x.name === f.name && x.size === f.size)) continue;
      state.freight.push(f);
    }
    renderFreight();
  }
  function renderFreight() {
    $("freight-list").replaceChildren(...state.freight.map((f, i) => {
      const li = document.createElement("li");
      li.textContent = f.name;
      const rm = document.createElement("button");
      rm.type = "button"; rm.textContent = "✕"; rm.title = "Remover"; rm.setAttribute("aria-label", `Remover ${f.name}`);
      rm.onclick = () => { state.freight.splice(i, 1); renderFreight(); };
      li.appendChild(rm);
      return li;
    }));
    const n = state.freight.length;
    $("freight-clear").hidden = !n;
    $("freight-card").classList.toggle("has-files", n > 0);
    checkReady();
  }
  $("freight-input").addEventListener("change", (e) => { addFreight(e.target.files); e.target.value = ""; });
  $("freight-clear").addEventListener("click", () => { state.freight = []; renderFreight(); });
  const drop = $("drop");
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => addFreight(e.dataTransfer.files));

  // ------------------------------------------------------------------ região
  $("geo-input").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    try {
      const gj = JSON.parse(await f.text());
      const polys = Cobertura.readGeojsonPolygons(gj);
      state.geojson = { name: f.name, data: gj };
      $("geo-name").textContent = `✔ ${f.name}`;
      $("geo-name").className = "ok";
      drawPreview(polys);
    } catch (err) {
      state.geojson = null;
      $("geo-name").textContent = `Arquivo inválido: ${err.message}`;
      $("geo-name").className = "muted";
      $("geo-preview").setAttribute("hidden", "");
    }
    checkReady();
  });

  function drawPreview(polys) {
    const [x0, y0, x1, y1] = Cobertura.bboxOf(polys);
    const w = 100, h = 60, pad = 6;
    const s = Math.min((w - 2 * pad) / (x1 - x0 || 1), (h - 2 * pad) / (y1 - y0 || 1));
    const ox = (w - (x1 - x0) * s) / 2, oy = (h - (y1 - y0) * s) / 2;
    const d = polys.map((rings) => rings.map((r) =>
      "M" + r.map(([x, y]) => `${(ox + (x - x0) * s).toFixed(2)},${(oy + (y1 - y) * s).toFixed(2)}`).join("L") + "Z").join("")).join("");
    const svg = $("geo-preview");
    svg.innerHTML = "";
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("fill-rule", "evenodd");
    svg.appendChild(path);
    svg.removeAttribute("hidden");
  }

  // ------------------------------------------------------------------ opcionais
  function optionalFile(inputId, nameId, clearId, key, emptyText, parse) {
    $(inputId).addEventListener("change", async (e) => {
      const f = e.target.files[0];
      e.target.value = "";
      if (!f) return;
      try {
        state[key] = await parse(f);
        $(nameId).textContent = `✔ ${f.name}`;
        $(nameId).className = "ok";
        $(clearId).hidden = false;
      } catch (err) {
        state[key] = null;
        $(nameId).textContent = `Arquivo inválido: ${err.message}`;
      }
    });
    $(clearId).addEventListener("click", () => {
      state[key] = null;
      $(nameId).textContent = emptyText;
      $(nameId).className = "muted";
      $(clearId).hidden = true;
    });
  }
  optionalFile("cep-input", "cep-name", "cep-clear", "cepBase", "Automática (IBGE, Censo 2022)",
    async (f) => ({ name: f.name, data: await f.arrayBuffer() }));
  optionalFile("cfg-input", "cfg-name", "cfg-clear", "config", "Não usar (colunas VTEX reconhecidas sozinhas)",
    async (f) => JSON.parse(await f.text()));

  $("cache-clear").addEventListener("click", async () => {
    await CoberturaIBGE.clearCache();
    log("CEPs salvos no navegador apagados. A próxima verificação baixa de novo do IBGE.", "info");
  });

  // ------------------------------------------------------------------ rodar
  function checkReady(keepStatus = false) {
    const ok = state.freight.length > 0 && state.geojson && !state.running;
    $("run").disabled = !ok;
    if (state.running || keepStatus) return;
    if (!state.freight.length) setStatus("Escolha as planilhas de frete de referência.");
    else if (!state.geojson) setStatus("Escolha a região (.geojson).");
    else setStatus(`Pronto para verificar (${state.freight.length} planilha(s)).`);
  }

  $("run").addEventListener("click", async () => {
    state.running = true;
    $("run").disabled = true;
    $("report").hidden = true;
    state.urls.forEach(URL.revokeObjectURL);
    state.urls = [];
    setProgress(0);
    log(`Iniciando: ${state.freight.length} planilha(s), região ${state.geojson.name}`);
    try {
      const freightFiles = await Promise.all(state.freight.map(async (f) => ({ name: f.name, data: await f.arrayBuffer() })));
      const res = await Cobertura.run({
        freightFiles,
        geojson: state.geojson.data,
        cepBase: state.cepBase,
        columnConfig: state.config,
        ibge: (polys, lg) => ibge.cepsForPolygon(polys, lg),
        progress: (p, msg) => { setProgress(p); setStatus(msg); },
        log,
      });
      state.res = res;
      showReport(res, freightFiles.map((f) => f.name));
      const t = res.totals;
      setStatus(t.sem ? `Concluído: ${fmt(t.sem)} CEP(s) sem cobertura na região.` : "Concluído: todos os CEPs da região têm cobertura.", "success");
      log("Concluído!", "success");
    } catch (err) {
      console.error(err);
      const msg = /fetch|network/i.test(err.message)
        ? "Erro de conexão com o IBGE. A 1ª vez numa cidade precisa de internet; tente de novo."
        : err.message;
      setStatus(msg, "error");
      log(msg, "error");
      setProgress(0);
    } finally {
      state.running = false;
      checkReady(true);
    }
  });

  // ------------------------------------------------------------------ relatório
  function blobUrl(data, type) {
    const url = URL.createObjectURL(new Blob([data], { type }));
    state.urls.push(url);
    return url;
  }

  function showReport(res, fileNames) {
    const t = res.totals;
    const stem = state.geojson.name.replace(/\.(geo)?json$/i, "").replace(/[^\w.-]+/g, "_");
    $("report-summary").textContent =
      `${state.geojson.name} · ${fmt(res.faixas)} faixas de CEP em ${fileNames.length} planilha(s) · ${res.porCidade.length} cidade(s)`;

    // downloads
    const meta = [
      ["Verificação de Frete", ""],
      ["Gerado em", new Date().toLocaleString("pt-BR")],
      ["Região", state.geojson.name],
      ["Planilhas de referência", fileNames.join(", ")],
      ["Base de CEPs", state.cepBase ? state.cepBase.name : "IBGE – CNEFE, Censo 2022 (1 ponto por CEP)"],
      ["CEPs na região", t.total],
      ["Cobertos", t.coberto],
      ...(res.hasWeight ? [["Cobertura parcial (peso)", t.parcial]] : []),
      ["Sem cobertura", t.sem],
      ["", ""],
      ["Como ler", "Um CEP é 'coberto' quando alguma faixa ZipCodeStart–ZipCodeEnd das planilhas o contém."],
      ...(res.hasWeight ? [["", `'Parcial (peso)': coberto, mas só até um peso menor que o máximo das planilhas (${res.maxW}).`]] : []),
      ["", "'Faixas sem cobertura' junta CEPs seguidos sem nenhum outro CEP conhecido no meio: dá para usar direto como ZipCodeStart/ZipCodeEnd."],
      ["", "CEPs que não existem na base do IBGE (ex.: CEPs novos ou de grandes usuários) não aparecem."],
    ];
    $("dl-xlsx").href = blobUrl(Cobertura.exportXlsx(res, { meta }), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    $("dl-xlsx").download = `ceps_sem_cobertura_${stem}.xlsx`;
    $("dl-geo").href = blobUrl(Cobertura.exportGeojson(res), "application/geo+json");
    $("dl-geo").download = `ceps_sem_cobertura_${stem}.geojson`;
    $("dl-geo").hidden = !t.sem;

    // KPIs
    const kpi = (label, value, sub, cls = "") =>
      `<div class="kpi ${cls}"><span>${label}</span><strong>${value}</strong><small>${sub}</small></div>`;
    const covered = t.coberto + t.parcial;
    $("kpis").innerHTML = [
      kpi("CEPs na região", fmt(t.total), `${res.porCidade.length} cidade(s)`),
      kpi("Com cobertura", pct(covered, t.total), `${fmt(covered)} CEPs`, "ok"),
      ...(t.parcial ? [kpi("Parcial (peso)", fmt(t.parcial), "coberto só em parte das faixas de peso", "warn")] : []),
      kpi("Sem cobertura", fmt(t.sem), `${pct(t.sem, t.total)} dos CEPs`, "bad"),
      t.temEnderecos ? kpi("Endereços sem cobertura", fmt(t.endSem), `${pct(t.endSem, t.end)} dos endereços (IBGE)`, "bad")
        : kpi("Faixas a criar", fmt(res.gaps.length), "faixas contínuas sem cobertura"),
    ].join("");
    $("coverage-bar").innerHTML = ["coberto", "parcial", "sem"]
      .filter((k) => t[k]).map((k) => `<span class="${k}" style="flex:${t[k]}" title="${Cobertura.STATUS_LABEL[k]}: ${fmt(t[k])}"></span>`).join("");

    $("report").hidden = false;
    drawMap(res);
    renderRanking();
    renderTable();
    $("report").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ------------------------------------------------------------------ mapa
  let map = null, tiles = null;
  const layers = {};
  const tileUrl = () => {
    const dark = document.documentElement.dataset.theme === "dark" ||
      (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
    return `https://{s}.basemaps.cartocdn.com/${dark ? "dark_all" : "light_all"}/{z}/{x}/{y}{r}.png`;
  };
  function updateTiles() { if (tiles) tiles.setUrl(tileUrl()); }

  function drawMap(res) {
    if (!map) {
      map = L.map("map", { preferCanvas: true, scrollWheelZoom: true });
      tiles = L.tileLayer(tileUrl(), {
        maxZoom: 19, subdomains: "abcd",
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
      }).addTo(map);
    }
    Object.values(layers).forEach((l) => l && map.removeLayer(l));
    const renderer = L.canvas({ padding: 0.3 });

    layers.region = L.geoJSON(state.geojson.data, {
      style: { color: "var(--accent)", weight: 2, fillOpacity: 0.04, dashArray: "6 4" }, interactive: false,
    }).addTo(map);
    layers.region.eachLayer((l) => l.setStyle({ color: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#0067C0" }));

    const popup = (r) => {
      const esc = (s) => String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
      return `<strong>${Cobertura.cepStr(r.cep)}</strong> · <span style="color:${COLORS[r.status]}">${Cobertura.STATUS_LABEL[r.status]}</span><br>` +
        `${esc(r.rua)}<br>${esc(r.bairro)}${r.cidade ? " – " + esc(r.cidade) : ""}` +
        (r.n ? `<br>${fmt(r.n)} endereço(s)` : "") + (r.status === "parcial" ? `<br>Peso máx. atendido: ${fmt(r.pesoMax)}` : "");
    };
    const group = (status, rows) => L.layerGroup(rows.map((r) => L.circleMarker([r.lat, r.lon], {
      renderer, radius: status === "coberto" ? 3 : 4.5, weight: status === "coberto" ? 0 : 1, color: "#fff",
      fillColor: COLORS[status], fillOpacity: status === "coberto" ? 0.55 : 0.9,
    }).bindPopup(() => popup(r))));

    let cobertos = res.rows.filter((r) => r.status === "coberto");
    const note = $("map-note");
    if (cobertos.length > MAX_COBERTOS_NO_MAPA) {
      const step = cobertos.length / MAX_COBERTOS_NO_MAPA;
      cobertos = Array.from({ length: MAX_COBERTOS_NO_MAPA }, (_, i) => cobertos[Math.floor(i * step)]);
      note.textContent = `Para o mapa ficar leve, mostra ${fmt(MAX_COBERTOS_NO_MAPA)} dos CEPs cobertos (amostra). Os sem cobertura aparecem todos.`;
      note.hidden = false;
    } else note.hidden = true;

    layers.coberto = group("coberto", cobertos).addTo(map);
    layers.parcial = group("parcial", res.rows.filter((r) => r.status === "parcial")).addTo(map);
    layers.sem = group("sem", res.rows.filter((r) => r.status === "sem")).addTo(map);

    const t = res.totals;
    const items = ["sem", ...(t.parcial ? ["parcial"] : []), "coberto"];
    $("map-legend").innerHTML = items.map((k) =>
      `<label><input type="checkbox" data-layer="${k}" checked><i style="background:${COLORS[k]}"></i>${Cobertura.STATUS_LABEL[k]} <b>${fmt(t[k])}</b></label>`).join("");
    $("map-legend").querySelectorAll("input").forEach((cb) => cb.addEventListener("change", () => {
      const l = layers[cb.dataset.layer];
      if (cb.checked) l.addTo(map); else map.removeLayer(l);
      layers.sem && map.hasLayer(layers.sem) && layers.sem.eachLayer((m) => m.bringToFront());
    }));

    setTimeout(() => { map.invalidateSize(); map.fitBounds(layers.region.getBounds(), { padding: [16, 16] }); }, 50);
  }

  // ------------------------------------------------------------------ ranking
  document.querySelectorAll(".seg button").forEach((b) => b.addEventListener("click", () => {
    state.group = b.dataset.group;
    document.querySelectorAll(".seg button").forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-selected", x === b); });
    renderRanking();
  }));

  function renderRanking() {
    const res = state.res;
    const list = (state.group === "cidade" ? res.porCidade : res.porBairro).filter((s) => s.sem > 0).slice(0, 15);
    if (!list.length) {
      $("rank-list").innerHTML = `<li class="empty">Nenhum CEP sem cobertura 🎉</li>`;
      return;
    }
    const max = list[0].sem;
    $("rank-list").replaceChildren(...list.map((s) => {
      const li = document.createElement("li");
      li.tabIndex = 0;
      li.title = "Filtrar a tabela";
      const nome = state.group === "bairro" ? s.nome.split(" – ")[0] : s.nome;
      li.innerHTML = `<div class="rank-top"><span class="rank-name"></span><span class="rank-num"><b>${fmt(s.sem)}</b> de ${fmt(s.total)}</span></div>
        <div class="rank-bar"><span style="width:${(100 * s.sem) / max}%"></span></div>`;
      li.querySelector(".rank-name").textContent = res.porCidade.length === 1 ? nome : s.nome;
      const go = () => { $("filter").value = nome; renderTable(); $("filter").scrollIntoView({ behavior: "smooth", block: "center" }); };
      li.addEventListener("click", go);
      li.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
      return li;
    }));
  }

  // ------------------------------------------------------------------ tabela
  const strip = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  function renderTable() {
    const res = state.res;
    const q = strip($("filter").value.trim());
    const qd = q.replace(/\D/g, "");
    let rows = res.rows.filter((r) => r.status === "sem");
    if (q) {
      rows = rows.filter((r) => (qd && String(r.cep).padStart(8, "0").includes(qd)) ||
        strip(`${r.rua} ${r.bairro} ${r.cidade}`).includes(q));
    }
    rows.sort((a, b) => (b.n || 0) - (a.n || 0) || a.cep - b.cep);
    const shown = rows.slice(0, MAX_LINHAS_TABELA);
    $("sem-body").replaceChildren(...shown.map((r) => {
      const tr = document.createElement("tr");
      [Cobertura.cepStr(r.cep), r.rua, r.bairro, r.cidade, r.n ? fmt(r.n) : "–"].forEach((v, i) => {
        const td = document.createElement("td");
        td.textContent = v || "–";
        if (i === 4) td.className = "num";
        tr.appendChild(td);
      });
      tr.addEventListener("click", () => {
        if (!map) return;
        map.setView([r.lat, r.lon], 16);
        layers.sem.eachLayer((m) => { const ll = m.getLatLng(); if (ll.lat === r.lat && ll.lng === r.lon) m.openPopup(); });
        $("map").scrollIntoView({ behavior: "smooth", block: "center" });
      });
      return tr;
    }));
    if (!rows.length) $("sem-body").innerHTML = `<tr><td colspan="5" class="empty">${q ? "Nada encontrado com esse filtro." : "Nenhum CEP sem cobertura 🎉"}</td></tr>`;
    $("table-note").textContent = rows.length > MAX_LINHAS_TABELA
      ? `Mostrando ${fmt(MAX_LINHAS_TABELA)} de ${fmt(rows.length)} (os com mais endereços primeiro). A lista completa está na planilha.`
      : rows.length ? `${fmt(rows.length)} CEP(s). Clique numa linha para ver no mapa.` : "";
  }
  let filterTimer;
  $("filter").addEventListener("input", () => { clearTimeout(filterTimer); filterTimer = setTimeout(renderTable, 150); });

  applyTheme(store.get(THEME_KEY) || "system");
  renderFreight();
})();
