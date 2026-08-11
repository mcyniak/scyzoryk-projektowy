(function () {
  "use strict";

  const state = {
    token: null,
    fileKey: null,
    sheetName: null,
    allCandidates: [],
    selectedLp: new Set(),
    batchResults: [],
    pendingGroups: [],
    batchSummary: null,
    wmGroups: []
  };

  const $ = (id) => document.getElementById(id);

  // Ta apka (w odroznieniu od reszty) miala dotad zahardkodowany
  // "http://scyzoryk.localhost:3000" wprost w atrybutach href - dzialalo, ale
  // niespojnie z reszta modulow, ktore nadpisuja href w runtime (patrz
  // inline-1.js kazdej innej apki). Ten sam mechanizm tutaj, zeby link do
  // Pomocy (nowy) i Panelu glownego trzymaly sie jednego wzorca.
  const mainPanelUrl = "http://scyzoryk.localhost:3000";
  document.querySelectorAll("[data-main-link]").forEach((link) => { link.href = mainPanelUrl; link.removeAttribute("target"); });
  document.querySelectorAll("[data-help-link]").forEach((link) => { link.href = `${mainPanelUrl}/instrukcja.html#${link.dataset.helpLink}`; });

  function api(path, options = {}) {
    const opts = { ...options, headers: { ...(options.headers || {}), "X-Scyzoryk-Request": "1" } };
    return fetch(path, opts).then(async (res) => {
      let data;
      try { data = await res.json(); } catch { data = { ok: false, message: "Błędna odpowiedź serwera." }; }
      if (!res.ok && data.ok !== true) {
        const err = new Error(data.message || `Błąd ${res.status}`);
        err.data = data;
        throw err;
      }
      return data;
    });
  }

  function showError(containerId, message, extra) {
    const el = $(containerId);
    if (!message) { el.innerHTML = ""; return; }
    let extraHtml = "";
    if (extra && extra.length) {
      extraHtml = `<div class="help-note">Znalezione foldery w tej lokalizacji:<br>${extra.map(f => `<code>${escapeHtml(f)}</code>`).join(" ")}</div>`;
    }
    el.innerHTML = `<div class="error-box">${escapeHtml(message)}${extraHtml}</div>`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // Przegladarka folderow w stronie zamiast recznego wpisywania sciezki -
  // natywne okno Windows nie dziala niezawodnie na tej maszynie, patrz
  // lib/folderBrowse.js. Uzywa zwyklego fetch (nie api()), bo /api/browse-folder
  // zwraca blad jako {error}, a api() oczekuje {message}.
  let browseTargetInput = null;
  let currentBrowsePath = null;

  function closeFolderBrowser() {
    $("folderBrowseModal").classList.remove("open");
  }

  async function openFolderBrowser(startPath) {
    $("folderBrowseModal").classList.add("open");
    await loadFolderBrowse(startPath);
  }

  async function loadFolderBrowse(targetPath) {
    const listEl = $("folderBrowseList");
    const currentEl = $("folderBrowseCurrentPath");
    listEl.innerHTML = '<div class="folder-row">Wczytuję...</div>';
    try {
      const url = targetPath ? `/api/browse-folder?path=${encodeURIComponent(targetPath)}` : "/api/browse-folder";
      const res = await fetch(url);
      const json = await res.json().catch(() => null);
      if (!json || !json.ok) {
        listEl.innerHTML = `<div class="folder-row">${escapeHtml((json && json.error) || "Nie udało się wczytać folderów.")}</div>`;
        return;
      }
      currentBrowsePath = json.path;
      currentEl.textContent = json.path || "Wybierz dysk";

      const rows = [];
      if (json.path !== null) {
        const isDriveRoot = json.parent === null;
        const upTarget = isDriveRoot ? "" : json.parent;
        rows.push(`<div class="folder-row clickable up-nav" data-path="${escapeHtml(upTarget)}">${isDriveRoot ? "⬆ Lista dysków" : "⬆ .."}</div>`);
      }
      for (const entry of json.entries) {
        rows.push(`<div class="folder-row clickable" data-path="${escapeHtml(entry.path)}">📁 ${escapeHtml(entry.name)}</div>`);
      }
      listEl.innerHTML = rows.join("") || '<div class="folder-row">Brak podfolderów.</div>';
    } catch (error) {
      listEl.innerHTML = `<div class="folder-row">${escapeHtml(String(error.message || error))}</div>`;
    }
  }

  $("browseFolderBtn").addEventListener("click", () => {
    browseTargetInput = $("baseFolderInput");
    const startPath = browseTargetInput.value.trim();
    openFolderBrowser(startPath || null);
  });
  // Tryb WM ma wlasne, osobne pole sciezki (wmFolderInput) - ten sam modal i
  // logika przegladania, tylko inny input docelowy. Wczesniej ten przycisk
  // istnial TYLKO dla trybu Projekty (baseFolderInput) - pole WM zostalo
  // pominiete przy pierwszym wdrozeniu przegladarki folderow.
  $("browseWmFolderBtn").addEventListener("click", () => {
    browseTargetInput = $("wmFolderInput");
    const startPath = browseTargetInput.value.trim();
    openFolderBrowser(startPath || null);
  });
  $("folderBrowseClose").addEventListener("click", closeFolderBrowser);
  $("folderBrowseModal").addEventListener("click", (event) => {
    if (event.target.id === "folderBrowseModal") closeFolderBrowser();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && $("folderBrowseModal").classList.contains("open")) closeFolderBrowser();
  });
  $("folderBrowseList").addEventListener("click", (event) => {
    const row = event.target.closest("[data-path]");
    if (!row) return;
    loadFolderBrowse(row.dataset.path);
  });
  $("folderBrowseSelect").addEventListener("click", () => {
    if (!currentBrowsePath || !browseTargetInput) return;
    browseTargetInput.value = currentBrowsePath;
    closeFolderBrowser();
    browseTargetInput.dispatchEvent(new Event("change"));
  });

  function enablePanel(id) { $(id).classList.remove("disabled"); }
  function disablePanel(id) { $(id).classList.add("disabled"); }

  async function setMode(mode) {
    // Audyt rozdz. 11, P0/P1: kolejka po stronie serwera (session.queue) i
    // panel "Drukuj" sa WSPOLNE dla obu trybow - dawniej przelaczenie trybu
    // tylko chowalo/pokazywalo UI, wiec kolejka przygotowana w POPRZEDNIM
    // trybie zostawala aktywna i mozna ja bylo wydrukowac z panelu, ktory
    // wygladal jak nowy tryb. Nie czyscimy state.batchResults/wmGroups (to
    // one dostarczaja obietnicy "pamieta oba tryby" z ekranu wyboru - DOM
    // drugiego trybu i tak nie jest niszczony przy przelaczeniu, patrz
    // renderAddressGroups nizej) - czyscimy WYLACZNIE wspolna, drukowalna
    // kolejke po stronie serwera, i to tylko po jawnym potwierdzeniu, zeby
    // przypadkowe kliknieccie drugiego trybu nie zgubilo cichaczem
    // przygotowanej pracy.
    if (state.mode && state.mode !== mode) {
      const hasActiveQueue = !$("panelPrint").classList.contains("disabled");
      if (hasActiveQueue) {
        const proceed = window.confirm(
          "Kolejka druku jest wspólna dla obu trybów. Przełączenie trybu wyczyści aktualnie przygotowaną kolejkę (wyniki dopasowania/skanu w tym trybie zostaną zachowane, ale kolejkę do druku trzeba będzie zbudować ponownie). Kontynuować?"
        );
        if (!proceed) return;
        try { await api("/api/queue/clear", { method: "POST" }); } catch {}
        updateQueueStatus("Kolejka jest pusta.");
        disablePanel("panelPrint");
      }
    }
    state.mode = mode;
    $("flowProjekty").style.display = mode === "projekty" ? "" : "none";
    $("flowWm").style.display = mode === "wm" ? "" : "none";
    $("modeProjektyBtn").classList.toggle("ghost", mode !== "projekty");
    $("modeWmBtn").classList.toggle("ghost", mode !== "wm");
    // Krok "Drukuj" jest wspolny dla obu trybow, ale nie ma sensu go w ogole
    // pokazywac, dopoki uzytkownik nie wybral, co drukuje.
    $("panelPrint").style.display = mode ? "" : "none";
    $("printStepNum").textContent = mode === "wm" ? "3" : "5";
  }
  $("modeProjektyBtn").addEventListener("click", () => setMode("projekty"));
  $("modeWmBtn").addEventListener("click", () => setMode("wm"));

  function setStep(n, scopeId = "stepper") {
    document.querySelectorAll(`#${scopeId} .step-dot`).forEach(el => {
      const s = Number(el.dataset.step);
      el.classList.toggle("active", s === n);
      el.classList.toggle("done", s < n);
    });
  }
  setStep(1);
  setStep(1, "stepperWm");

  // Ten sam sentinel co server.js (SAVE_AS_PDF_SENTINEL) - nigdy nie trafia
  // do prawdziwej listy drukarek (dopisywany tu, po stronie klienta), wiec
  // dostepny jest nawet gdy listPrinters() nie znajdzie zadnej fizycznej
  // drukarki.
  const SAVE_AS_PDF_OPTION = `<option value="__SAVE_AS_PDF__">💾 Zapisz jako PDF (bez drukowania)</option>`;

  async function loadPrinters() {
    const select = $("printerSelect");
    try {
      const data = await api("/api/printers");
      const printers = data.printers || [];
      const printerOptions = printers.map(p =>
        `<option value="${escapeHtml(p.name)}"${p.isDefault ? " selected" : ""}>${escapeHtml(p.name)}${p.isDefault ? " (domyślna)" : ""}</option>`
      ).join("");
      select.innerHTML = (printerOptions || `<option value="">Drukarka domyślna systemu</option>`) + SAVE_AS_PDF_OPTION;
    } catch (err) {
      select.innerHTML = `<option value="">Drukarka domyślna systemu</option>` + SAVE_AS_PDF_OPTION;
    }
    updatePrintOptionsVisibility();
  }
  loadPrinters();

  // Kopie/strony/tryb kopiowania nie maja znaczenia przy zapisie do PDF (nie
  // ma fizycznej drukarki ani duplexu) - ukrywamy je, zeby nie sugerowac, ze
  // cokolwiek robia w tym trybie. Checkbox "dokumentacja powykonawcza" zostaje
  // widoczny/aktywny - stemplowanie dziala identycznie w obu trybach.
  function updatePrintOptionsVisibility() {
    const isSaveAsPdf = $("printerSelect").value === "__SAVE_AS_PDF__";
    $("printOnlyOptionsRow").style.display = isSaveAsPdf ? "none" : "";
    $("printBtn").textContent = isSaveAsPdf ? "Zapisz jako PDF" : "Drukuj";
  }
  $("printerSelect").addEventListener("change", updatePrintOptionsVisibility);

  $("excelInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    showError("excelError", "");
    const fd = new FormData();
    fd.append("file", file);
    try {
      const data = await api("/api/excel/upload", { method: "POST", body: fd });
      state.token = data.token;
      // fileKey (hash tresci pliku) identyfikuje KONKRETNA wgrana inwestycje,
      // niezaleznie od nazwy zakladki - patrz komentarz przy lastFolderKey w
      // server.js (audyt P0-6a: dwie rozne inwestycje z zakladka o tej samej
      // nazwie nie moga juz dzielic podpowiedzi ostatniego folderu).
      state.fileKey = data.fileKey || null;
      const select = $("sheetSelect");
      select.innerHTML = `<option value="">— wybierz zakładkę —</option>` +
        data.sheets.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");
      select.disabled = false;
    } catch (err) {
      showError("excelError", err.message);
    }
  });

  $("sheetSelect").addEventListener("change", async (e) => {
    const sheetName = e.target.value;
    if (!sheetName) { disablePanel("panelCandidates"); return; }
    state.sheetName = sheetName;
    showError("excelError", "");
    try {
      const fileKeyQuery = state.fileKey ? `?fileKey=${encodeURIComponent(state.fileKey)}` : "";
      const data = await api(`/api/excel/${encodeURIComponent(state.token)}/sheets/${encodeURIComponent(sheetName)}/candidates${fileKeyQuery}`);
      state.allCandidates = data.candidates;
      state.selectedLp = new Set();
      state.batchResults = [];
      state.pendingGroups = [];
      state.batchSummary = null;
      updateQueueStatus("Kolejka jest pusta.");
      renderCandidates();
      renderSkippedRowsWarning(data.skippedRows);
      if (data.lastFolder) $("baseFolderInput").value = data.lastFolder;
      enablePanel("panelCandidates");
      setStep(2);
      disablePanel("panelFolder");
      disablePanel("panelOrder");
      disablePanel("panelPrint");
    } catch (err) {
      showError("excelError", err.message);
    }
  });

  function updateSelectedCount() {
    const n = state.selectedLp.size;
    $("selectedCountLabel").textContent = n === 0 ? "0 zaznaczonych" : `${n} zaznaczonych`;
    $("candidatesNextBtn").disabled = n === 0;
  }

  function buildPendingGroups() {
    const groups = [];
    for (const r of state.batchResults.filter(r => r.ok)) {
      const items = r.order
        .filter(o => {
          if (typeof o.includeInPrint !== "boolean") o.includeInPrint = !EXCLUDE_FROM_PRINT.has(o.confidence);
          return o.fileName && o.includeInPrint === true;
        })
        .map(o => ({ fullPath: o.fullPath, label: `${r.lpGmina} - ${r.adres} › ${o.label}` }));
      if (items.length) groups.push({ label: `${r.lpGmina} - ${r.adres}`, items });
    }
    state.pendingGroups = groups;
    return groups;
  }

  function updateQueueStatus(message) {
    const el = $("queueStatusText");
    if (el) el.textContent = message || "Kolejka jest pusta.";
  }

  // Wiersz z adresem, ale bez numeru LP gmina (albo odwrotnie) jest odrzucany
  // po stronie serwera, bo nie da sie go dopasowac do folderu klienta -
  // wczesniej znikal z listy bez sladu (patrz excelInvestment.js#listCandidates).
  function renderSkippedRowsWarning(skippedRows) {
    const el = $("candidatesSkippedWarning");
    const missingLpGmina = skippedRows?.missingLpGmina || 0;
    const missingAdres = skippedRows?.missingAdres || 0;
    if (!missingLpGmina && !missingAdres) { el.hidden = true; el.textContent = ""; return; }
    const parts = [];
    if (missingLpGmina) parts.push(`${missingLpGmina} ${missingLpGmina === 1 ? "wiersz z adresem ma" : "wierszy z adresem ma"} puste LP gminy`);
    if (missingAdres) parts.push(`${missingAdres} ${missingAdres === 1 ? "wiersz z LP gminy ma" : "wierszy z LP gminy ma"} pusty adres`);
    el.textContent = `⚠️ Pominięto na liście: ${parts.join(", ")} - uzupełnij w Excelu i wgraj plik ponownie, jeśli te adresy też mają zostać wydrukowane.`;
    el.hidden = false;
  }

  function renderCandidates() {
    const list = $("candidateList");
    const candidates = state.allCandidates;
    if (!candidates.length) {
      list.innerHTML = `<li class="help-note">Brak adresów bez odbioru i bez rezygnacji w tej zakładce.</li>`;
      $("selectAllCandidates").disabled = true;
      updateSelectedCount();
      return;
    }
    list.innerHTML = candidates.map((c, idx) => `
      <li class="candidate-item" data-idx="${idx}">
        <div class="candidate-lp">${escapeHtml(c.lpGmina)}</div>
        <div class="candidate-info">
          <strong>${escapeHtml(c.adres || "")}</strong>
          <span>${escapeHtml(c.imie || "")}${c.uid ? " · UID: " + escapeHtml(c.uid) : ""}</span>
        </div>
        <input type="checkbox" class="cand-checkbox" data-idx="${idx}" style="width:22px; height:22px; accent-color:#cf171f;" />
      </li>
    `).join("");

    function toggle(idx, li, checked) {
      const c = candidates[idx];
      if (checked) state.selectedLp.add(c.lpGmina); else state.selectedLp.delete(c.lpGmina);
      li.classList.toggle("selected", checked);
      updateSelectedCount();
    }

    list.querySelectorAll(".candidate-item").forEach(li => {
      const idx = Number(li.dataset.idx);
      const checkbox = li.querySelector(".cand-checkbox");
      li.addEventListener("click", (e) => {
        if (e.target === checkbox) return;
        checkbox.checked = !checkbox.checked;
        toggle(idx, li, checkbox.checked);
      });
      checkbox.addEventListener("click", (e) => e.stopPropagation());
      checkbox.addEventListener("change", () => toggle(idx, li, checkbox.checked));
    });

    updateSelectedCount();
  }

  $("selectAllCandidates").addEventListener("change", (e) => {
    const checked = e.target.checked;
    state.selectedLp = new Set(checked ? state.allCandidates.map(c => c.lpGmina) : []);
    document.querySelectorAll("#candidateList .candidate-item").forEach(li => {
      const cb = li.querySelector(".cand-checkbox");
      cb.checked = checked;
      li.classList.toggle("selected", checked);
    });
    updateSelectedCount();
  });

  $("candidatesNextBtn").addEventListener("click", () => {
    enablePanel("panelFolder");
    disablePanel("panelOrder");
    disablePanel("panelPrint");
    showError("matchError", "");
    setStep(3);
  });

  $("matchBtn").addEventListener("click", async () => {
    if (!state.selectedLp.size) return;
    const baseFolder = $("baseFolderInput").value.trim();
    if (!baseFolder) { showError("matchError", "Podaj ścieżkę folderu bazowego."); return; }
    showError("matchError", "");
    $("matchBtn").disabled = true;
    $("matchBtn").textContent = "Szukam...";
    try {
      const selectedCandidates = state.allCandidates.filter(c => state.selectedLp.has(c.lpGmina));
      const allAddresses = state.allCandidates.map(c => c.adres).filter(Boolean);
      const data = await api("/api/match-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sheetName: state.sheetName, fileKey: state.fileKey, baseFolder, candidates: selectedCandidates, allAddresses })
      });
      state.batchResults = data.results;
      state.batchSummary = data.summary;
      buildPendingGroups();
      renderBatch(data.summary);
      enablePanel("panelOrder");
      disablePanel("panelPrint");
      setStep(4);
    } catch (err) {
      showError("matchError", err.message);
    } finally {
      $("matchBtn").disabled = false;
      $("matchBtn").textContent = "Znajdź projekty";
    }
  });

  const CONFIDENT = new Set(["pewne", "słowo kluczowe"]);
  // Audyt rozdz. 11, P0/P1: "wariant - sprawdź ręcznie" NIE moze byc w SETTLED -
  // ten status jednoczesnie oznacza pozycje wylaczona z druku (patrz
  // EXCLUDE_FROM_PRINT nizej) i wymagajaca decyzji uzytkownika, ktory wariant
  // (OT/ST) jest wlasciwy. Jesli SETTLED go zawiera, banner podsumowania i
  // liczniki "do sprawdzenia" cicho pomijaja te pozycje - uzytkownik moze
  // zobaczyc "Wszystko dopasowane" mimo ze dokument zostal po cichu
  // wylaczony z kolejki druku bez jego jawnej decyzji.
  const SETTLED = new Set([...CONFIDENT, "obcy adres - pominięte"]);

  function confidenceBadge(confidence) {
    if (CONFIDENT.has(confidence)) return `<span class="badge ok">${escapeHtml(confidence)}</span>`;
    if (confidence === "brak") return `<span class="badge unknown">brak pliku</span>`;
    if (confidence === "niedopasowane") return `<span class="badge unknown">plik bez etykiety</span>`;
    if (confidence === "obcy adres - pominięte") return `<span class="badge unknown">⛔ pominięty (inny adres)</span>`;
    if (confidence === "wariant - sprawdź ręcznie") return `<span class="badge unknown">⛔ wariant OT/ST</span>`;
    return `<span class="badge guess">${escapeHtml(confidence)}</span>`;
  }

  function buildBatchSummary() {
    const results = state.batchResults || [];
    const okResults = results.filter(r => r.ok);
    return {
      totalRequested: results.length,
      foldersFound: okResults.length,
      foldersMissing: results.filter(r => !r.ok).length,
      filesUnresolved: okResults.reduce((sum, r) => sum + (r.order || []).filter(o => !SETTLED.has(o.confidence)).length, 0)
    };
  }

  function renderBatch(summary) {
    const s = summary || buildBatchSummary();
    state.batchSummary = s;
    const banner = $("batchSummary");
    const parts = [];
    parts.push(`<div class="summary-stat ${s.foldersFound === s.totalRequested ? "ok" : "warn"}">📁 ${s.foldersFound}/${s.totalRequested} folderów znalezionych</div>`);
    if (s.foldersMissing > 0) parts.push(`<div class="summary-stat bad">⚠️ ${s.foldersMissing} adresów bez folderu</div>`);
    if (s.filesUnresolved > 0) parts.push(`<div class="summary-stat warn">⚠️ ${s.filesUnresolved} plików bez pewnego dopasowania</div>`);
    if (s.foldersMissing === 0 && s.filesUnresolved === 0) parts.push(`<div class="summary-stat ok">✅ Wszystko dopasowane</div>`);
    banner.innerHTML = `<div class="summary-banner">${parts.join("")}</div>`;

    const missing = state.batchResults.filter(r => !r.ok);
    const missingBox = $("missingFoldersBox");
    if (missing.length) {
      missingBox.innerHTML = `<div class="error-box"><strong>Nie znaleziono folderu dla ${missing.length} adres(ów) - pominięte, dodaj ręcznie:</strong><br>` +
        missing.map(r => `${escapeHtml(r.lpGmina)} - ${escapeHtml(r.adres)} (${escapeHtml(r.imie || "")}): ${escapeHtml(r.message)}`).join("<br>") +
        `</div>`;
    } else {
      missingBox.innerHTML = "";
    }

    renderAddressGroups();
  }

  function groupNeedsReview(r) {
    return r.order.some(o => !SETTLED.has(o.confidence));
  }

  function renderAddressGroups() {
    const container = $("addressGroups");
    const okResults = state.batchResults.filter(r => r.ok);
    container.innerHTML = okResults.map((r, gIdx) => {
      const needsReview = groupNeedsReview(r);
      const reviewCount = r.order.filter(o => !SETTLED.has(o.confidence)).length;
      const statusHtml = needsReview
        ? `<span class="badge guess">⚠ ${reviewCount} do sprawdzenia</span>`
        : `<span class="badge ok">✓ komplet</span>`;
      const collapsedClass = " collapsed";
      return `
      <div class="address-group${collapsedClass}" data-gidx="${gIdx}">
        <div class="address-group-header" data-toggle="${gIdx}">
          <div class="lp-tag">${escapeHtml(r.lpGmina)}</div>
          <div>
            <strong>${escapeHtml(r.adres)}</strong><br>
            <span>${escapeHtml(r.imie || "")}</span>
          </div>
          <div class="group-status">${statusHtml}</div>
          <span class="chevron">▾</span>
        </div>
        <ul class="order-list" data-gidx="${gIdx}"></ul>
      </div>
    `;
    }).join("");

    container.querySelectorAll(".address-group-header").forEach(header => {
      header.addEventListener("click", () => {
        header.closest(".address-group").classList.toggle("collapsed");
      });
    });

    okResults.forEach((r, gIdx) => renderOrderList(gIdx));
  }

  function removeOrderItem(gIdx, idx) {
    const okResults = state.batchResults.filter(r => r.ok);
    const result = okResults[gIdx];
    if (!result) return;
    result.order.splice(idx, 1);
    if (!result.order.length) {
      state.batchResults = state.batchResults.filter(r => r !== result);
    }
    renderBatch(buildBatchSummary());
    buildPendingGroups();
    updateQueueStatus(state.pendingGroups.length ? `Kolejka gotowa: ${state.pendingGroups.reduce((sum, g) => sum + g.items.length, 0)} pozycji.` : "Kolejka jest pusta.");
  }

  function renderOrderList(gIdx) {
    const okResults = state.batchResults.filter(r => r.ok);
    const result = okResults[gIdx];
    const list = document.querySelector(`#addressGroups .order-list[data-gidx="${gIdx}"]`);
    if (!result || !list) return;
    list.innerHTML = result.order.map((item, idx) => {
      if (typeof item.includeInPrint !== "boolean") item.includeInPrint = !EXCLUDE_FROM_PRINT.has(item.confidence);
      const confident = SETTLED.has(item.confidence);
      const classes = ["order-item"];
      classes.push(confident ? "compact" : "needs-review");
      return `
      <li class="${classes.join(" ")}" draggable="true" data-gidx="${gIdx}" data-idx="${idx}">
        <span class="handle">⠿</span>
        <input type="checkbox" class="order-print-checkbox" data-gidx="${gIdx}" data-idx="${idx}" ${item.includeInPrint ? "checked" : ""} title="Dodaj do kolejki druku" />
        <div class="info">
          <strong>${escapeHtml(item.label)}</strong>
          <span>${item.fileName ? escapeHtml(item.fileName) : "brak pliku - dodaj ręcznie z Eksploratora"}</span>
        </div>
        ${confidenceBadge(item.confidence)}
        ${item.fileName ? `<button class="preview-btn" data-gidx="${gIdx}" data-idx="${idx}" title="Podgląd" type="button">👁</button>` : `<span></span>`}
        <button class="preview-btn" data-action="remove" data-gidx="${gIdx}" data-idx="${idx}" title="Usuń z proponowanej kolejności" type="button">✕</button>
      </li>
    `;
    }).join("");
    attachDragHandlers(gIdx);
    list.querySelectorAll(".order-print-checkbox").forEach(checkbox => {
      checkbox.addEventListener("change", () => {
        const item = state.batchResults.filter(r => r.ok)[Number(checkbox.dataset.gidx)]?.order?.[Number(checkbox.dataset.idx)];
        if (item) item.includeInPrint = checkbox.checked;
        buildPendingGroups();
      });
    });
    list.querySelectorAll(".preview-btn").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const gi = Number(btn.dataset.gidx), ii = Number(btn.dataset.idx);
        if (btn.dataset.action === "remove") {
          removeOrderItem(gi, ii);
          return;
        }
        openLocalPreview(state.batchResults.filter(r => r.ok)[gi].order[ii]);
      });
    });
  }

  let dragSrc = null;
  function attachDragHandlers(gIdx) {
    // Skopowane do #addressGroups - bez tego, odkad tryb WM uzywa tych samych
    // klas .order-item/.order-list i data-gidx we wlasnym #wmGroupsContainer,
    // ten (globalny) selektor mogl przypadkiem zlapac elementy z drugiego,
    // ukrytego trybu, jesli uzytkownik uzyl obu trybow w tej samej sesji
    // strony (przelaczanie trybow nie czysci DOM-u tego drugiego).
    const items = document.querySelectorAll(`#addressGroups .order-item[data-gidx="${gIdx}"]`);
    items.forEach(item => {
      item.addEventListener("dragstart", () => {
        dragSrc = { gIdx: Number(item.dataset.gidx), idx: Number(item.dataset.idx) };
        item.classList.add("dragging");
      });
      item.addEventListener("dragend", () => item.classList.remove("dragging"));
      item.addEventListener("dragover", (e) => {
        e.preventDefault();
        items.forEach(x => x.classList.remove("drop-before"));
        item.classList.add("drop-before");
      });
      item.addEventListener("drop", (e) => {
        e.preventDefault();
        const targetGIdx = Number(item.dataset.gidx);
        const targetIdx = Number(item.dataset.idx);
        if (!dragSrc || dragSrc.gIdx !== targetGIdx || dragSrc.idx === targetIdx) return;
        const result = state.batchResults.filter(r => r.ok)[targetGIdx];
        const moved = result.order.splice(dragSrc.idx, 1)[0];
        result.order.splice(targetIdx, 0, moved);
        renderOrderList(targetGIdx);
      });
    });
  }

  function openLocalPreview(item) {
    if (!item.fileName) return;
    if (!item.fileName.toLowerCase().endsWith(".pdf")) {
      alert("Podgląd w przeglądarce działa tylko dla PDF. Ten plik (" + item.fileName + ") otwórz z Eksploratora.");
      return;
    }
    $("previewModalTitle").textContent = item.fileName;
    $("previewModalFrame").src = "/api/preview-by-path?path=" + encodeURIComponent(item.fullPath);
    $("previewModal").classList.add("open");
  }
  $("previewModalClose").addEventListener("click", () => {
    $("previewModal").classList.remove("open");
    $("previewModalFrame").src = "";
  });

  const EXCLUDE_FROM_PRINT = new Set([
    "obcy adres - pominięte",
    "wariant - sprawdź ręcznie",
    "dopasowanie po kolejności - sprawdź",
    "niedopasowane"
  ]);

  $("confirmOrderBtn").addEventListener("click", async () => {
    const btn = $("confirmOrderBtn");
    const groups = buildPendingGroups();

    if (!groups.length) {
      showError("orderError", "Nie znaleziono plików do wysłania. Sprawdź kolejność i dodaj brakujące pliki ręcznie.");
      return;
    }

    showError("orderError", "");
    btn.disabled = true;
    btn.textContent = "Przetwarzam...";

    try {
      const data = await api("/api/queue/set-merged", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groups })
      });
      if (!data?.ok) {
        showError("orderError", data?.message || "Nie udało się utworzyć kolejki.");
        return;
      }
      updateQueueStatus(`Kolejka gotowa: ${data.queue?.length || 0} pozycji.`);
      enablePanel("panelPrint");
      setStep(5);
      window.scrollTo({ top: document.querySelector("#panelPrint").offsetTop, behavior: "smooth" });
      showError("orderError", "Kolejka została utworzona. Możesz teraz kliknąć DRUKUJ.");
    } catch (err) {
      showError("orderError", err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Zatwierdź i dodaj wszystko do kolejki →";
    }
  });

  // Grupuje plaska liste wynikow skanu WM po kategorii (Pompa ciepla, Zasobnik
  // c.w.u. itd.). Trzymane w state.wmGroups (nie przeliczane przy kazdym
  // renderze), zeby przeciaganie moglo trwale zmieniac kolejnosc w grupie.
  function groupWmItems(items) {
    const groups = [];
    const byCategory = new Map();
    items.forEach((item) => {
      const key = item.categoryPath || item.category || "";
      if (!byCategory.has(key)) {
        const group = { category: item.category || "", categoryPath: item.categoryPath || "", items: [] };
        byCategory.set(key, group);
        groups.push(group);
      }
      byCategory.get(key).items.push({ ...item });
    });
    return groups;
  }

  // WM ma inne teksty pewnosci niz tryb adresowy ("pewne (dopasowane z listy
  // Zalacznikow)" itp.), wiec dopasowanie po prefiksie zamiast Set.has.
  function wmConfidenceBadge(confidence) {
    const c = String(confidence || "");
    if (c.startsWith("pewne")) return `<span class="badge ok">${escapeHtml(c)}</span>`;
    if (c.startsWith("brak")) return `<span class="badge unknown">${escapeHtml(c)}</span>`;
    return `<span class="badge guess">${escapeHtml(c)}</span>`;
  }

  function wmGroupNeedsReview(group) {
    return group.items.some(it => (it.confidence || "").startsWith("brak"));
  }

  function renderWmResults(data) {
    const items = data.items || [];
    const box = $("wmResults");
    setStep(2, "stepperWm");
    if (!items.length) {
      state.wmGroups = [];
      box.innerHTML = `<div class="help-note">Nie znaleziono żadnych dokumentów WM w tym folderze.</div>`;
      return;
    }
    state.wmGroups = groupWmItems(items);
    box.innerHTML = `
      <div class="summary-banner">
        <div class="summary-stat ${data.missingCount ? "warn" : "ok"}">📁 ${data.categoriesFound} kategori(i), ${items.length} pozycji${data.missingCount ? `, ${data.missingCount} braków` : ""}</div>
      </div>
      <div id="wmGroupsContainer"></div>
      <div style="margin-top:16px;">
        <button id="wmAddToQueueBtn" type="button">Dodaj zaznaczone do kolejki druku →</button>
      </div>
    `;
    renderWmGroups();
    $("wmAddToQueueBtn").addEventListener("click", addWmToQueue);
  }

  // Ta sama karta z naglowkiem (numer/nazwa/status/chevron) co grupy adresow
  // w trybie Projekty - tylko lista w srodku to teraz .order-list (przeciagalne
  // pozycje), zamiast prostej listy z checkboxami.
  function renderWmGroups() {
    const container = $("wmGroupsContainer");
    container.innerHTML = state.wmGroups.map((group, gIdx) => {
      const numMatch = /^(\d+)/.exec(String(group.categoryPath).split("/")[0] || "");
      const tag = numMatch ? numMatch[1] : String(gIdx + 1);
      const reviewCount = group.items.filter(it => (it.confidence || "").startsWith("brak")).length;
      const statusHtml = reviewCount
        ? `<span class="badge guess">⚠ ${reviewCount} do sprawdzenia</span>`
        : `<span class="badge ok">✓ komplet</span>`;
      return `
        <div class="address-group collapsed" data-gidx="${gIdx}">
          <div class="address-group-header" data-toggle="${gIdx}">
            <div class="lp-tag">${escapeHtml(tag)}</div>
            <div><strong>${escapeHtml(group.category)}</strong></div>
            <div class="group-status">${statusHtml}</div>
            <span class="chevron">▾</span>
          </div>
          <ul class="order-list" data-gidx="${gIdx}"></ul>
        </div>`;
    }).join("");

    container.querySelectorAll(".address-group-header").forEach(header => {
      header.addEventListener("click", () => header.closest(".address-group").classList.toggle("collapsed"));
    });

    state.wmGroups.forEach((group, gIdx) => renderWmItemList(gIdx));
  }

  function renderWmItemList(gIdx) {
    const group = state.wmGroups[gIdx];
    const list = document.querySelector(`#wmGroupsContainer .order-list[data-gidx="${gIdx}"]`);
    if (!group || !list) return;
    const prefix = `${group.category}: `;
    list.innerHTML = group.items.map((item, idx) => {
      const missing = !item.fullPath;
      const confident = String(item.confidence || "").startsWith("pewne");
      const classes = ["order-item"];
      classes.push(confident ? "compact" : "needs-review");
      const shortLabel = item.label.startsWith(prefix) ? item.label.slice(prefix.length) : item.label;
      return `
        <li class="${classes.join(" ")}" draggable="true" data-gidx="${gIdx}" data-idx="${idx}">
          <span class="handle">⠿</span>
          <div class="info">
            <strong>${escapeHtml(shortLabel)}</strong>
            <span>${missing ? "brak pliku - dodaj ręcznie" : ""}</span>
          </div>
          ${wmConfidenceBadge(item.confidence)}
          <input type="checkbox" class="wm-item-checkbox" data-gidx="${gIdx}" data-idx="${idx}" ${missing ? "disabled" : "checked"} />
        </li>`;
    }).join("");
    attachWmDragHandlers(gIdx);
  }

  let wmDragSrc = null;
  function attachWmDragHandlers(gIdx) {
    const items = document.querySelectorAll(`#wmGroupsContainer .order-item[data-gidx="${gIdx}"]`);
    items.forEach(item => {
      item.addEventListener("dragstart", () => {
        wmDragSrc = { gIdx: Number(item.dataset.gidx), idx: Number(item.dataset.idx) };
        item.classList.add("dragging");
      });
      item.addEventListener("dragend", () => item.classList.remove("dragging"));
      item.addEventListener("dragover", (e) => {
        e.preventDefault();
        items.forEach(x => x.classList.remove("drop-before"));
        item.classList.add("drop-before");
      });
      item.addEventListener("drop", (e) => {
        e.preventDefault();
        const targetGIdx = Number(item.dataset.gidx);
        const targetIdx = Number(item.dataset.idx);
        if (!wmDragSrc || wmDragSrc.gIdx !== targetGIdx || wmDragSrc.idx === targetIdx) return;
        const group = state.wmGroups[targetGIdx];
        const moved = group.items.splice(wmDragSrc.idx, 1)[0];
        group.items.splice(targetIdx, 0, moved);
        renderWmItemList(targetGIdx);
      });
    });
  }

  $("wmScanBtn").addEventListener("click", async () => {
    const folderPath = $("wmFolderInput").value.trim();
    if (!folderPath) { showError("wmError", "Podaj ścieżkę folderu WM."); return; }
    showError("wmError", "");
    const btn = $("wmScanBtn");
    btn.disabled = true;
    btn.textContent = "Skanuję...";
    try {
      const powykonawczy = $("wmDokPodCheckbox").checked;
      const data = await api("/api/wm/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderPath, powykonawczy })
      });
      renderWmResults(data);
    } catch (err) {
      showError("wmError", err.message);
      $("wmResults").innerHTML = "";
    } finally {
      btn.disabled = false;
      btn.textContent = "Skanuj folder WM";
    }
  });

  async function addWmToQueue() {
    const btn = $("wmAddToQueueBtn");
    // Grupuj po kategorii (podfolderze) i wyslij przez set-merged, zeby serwer
    // polaczyl PDF-y tej samej kategorii w jeden plik - drukarka wysyla wtedy
    // jedno zadanie druku zamiast wielu osobnych, tak jak przy laczeniu
    // adresow w trybie Projekty (buildQueueFromGroups juz to potrafi).
    // Kolejnosc pozycji w kazdej grupie to aktualna kolejnosc po ewentualnym
    // przeciagnieciu (state.wmGroups[gIdx].items), nie oryginalna z API.
    const groups = state.wmGroups.map((group, gIdx) => {
      const items = group.items
        .map((item, idx) => ({ item, idx }))
        .filter(({ item, idx }) => item.fullPath && document.querySelector(`.wm-item-checkbox[data-gidx="${gIdx}"][data-idx="${idx}"]`)?.checked)
        .map(({ item }) => ({ fullPath: item.fullPath, label: item.label }));
      return { label: group.category, items };
    }).filter(g => g.items.length);

    if (!groups.length) { showError("wmError", "Zaznacz przynajmniej jedną pozycję z plikiem."); return; }

    btn.disabled = true;
    btn.textContent = "Dodaję...";
    try {
      const data = await api("/api/queue/set-merged", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groups })
      });
      updateQueueStatus(`Kolejka gotowa: ${data.queue?.length || 0} pozycji.`);
      enablePanel("panelPrint");
      setStep(3, "stepperWm");
      window.scrollTo({ top: document.querySelector("#panelPrint").offsetTop, behavior: "smooth" });
      showError("wmError", "");
    } catch (err) {
      showError("wmError", err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Dodaj zaznaczone do kolejki druku →";
    }
  }

  $("clearBtn").addEventListener("click", () => window.location.reload());

  $("printBtn").addEventListener("click", async () => {
    $("printBtn").disabled = true;
    try {
      const groups = buildPendingGroups();
      await api("/api/print", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          copies: Number($("copiesInput").value || 1),
          sideMode: $("sideModeInput").value,
          printerName: $("printerSelect").value || "",
          copyMode: "file",
          delaySeconds: 1,
          groups,
          stampPowykonawcza: $("stampPowykonawczaCheckbox").checked
        })
      });
      pollStatus();
    } catch (err) {
      $("statusText").textContent = "❌ " + err.message;
      $("printBtn").disabled = false;
    }
  });

  function pollStatus() {
    const timer = setInterval(async () => {
      try {
        const s = await api("/api/status");
        $("statusText").textContent = s.message || "";
        $("progressBar").style.width = (s.percent || 0) + "%";
        if (!s.printing) {
          clearInterval(timer);
          $("printBtn").disabled = false;
          if (s.done && !s.error) {
            if (s.savedFolder) {
              $("statusText").innerHTML = `<div class="success-panel"><span class="big-check">✅</span>Zapisano pliki PDF. Otwieram folder...</div>`;
              api("/api/open-saved-pdf-folder", { method: "POST" }).catch(() => {});
            } else {
              $("statusText").innerHTML = `<div class="success-panel"><span class="big-check">✅</span>Wysłano do druku. Sprawdź drukarkę.</div>`;
            }
          }
        }
      } catch (_) {
        clearInterval(timer);
        $("printBtn").disabled = false;
      }
    }, 800);
  }
})();
