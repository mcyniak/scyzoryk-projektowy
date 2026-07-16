(function () {
  "use strict";

  const state = {
    token: null,
    sheetName: null,
    allCandidates: [],
    selectedLp: new Set(),
    batchResults: [],
    pendingGroups: [],
    batchSummary: null
  };

  const $ = (id) => document.getElementById(id);

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

  function enablePanel(id) { $(id).classList.remove("disabled"); }
  function disablePanel(id) { $(id).classList.add("disabled"); }

  function setStep(n) {
    document.querySelectorAll(".step-dot").forEach(el => {
      const s = Number(el.dataset.step);
      el.classList.toggle("active", s === n);
      el.classList.toggle("done", s < n);
    });
  }
  setStep(1);

  async function loadPrinters() {
    const select = $("printerSelect");
    try {
      const data = await api("/api/printers");
      const printers = data.printers || [];
      if (!printers.length) {
        select.innerHTML = `<option value="">Drukarka domyślna systemu</option>`;
        return;
      }
      select.innerHTML = printers.map(p =>
        `<option value="${escapeHtml(p.name)}"${p.isDefault ? " selected" : ""}>${escapeHtml(p.displayName || p.name)}${p.isDefault ? " (domyślna)" : ""}</option>`
      ).join("");
    } catch (err) {
      select.innerHTML = `<option value="">Drukarka domyślna systemu</option>`;
    }
  }
  loadPrinters();

  // Etykieta pola sciezki zalezy od tego, czy serwer ma skonfigurowany
  // SCYZORYK_PROJECTS_ROOT (pilot) - wtedy uzytkownik podaje sciezke
  // WZGLEDEM Dysku Google, nie pelna sciezke systemowa jak na Windows.
  (async function initBaseFolderLabel() {
    const label = $("baseFolderLabel");
    const input = $("baseFolderInput");
    if (!label || !input) return;
    try {
      const data = await api("/api/drive-status");
      if (data.configured) {
        label.textContent = "Ścieżka folderu bazowego (względem Dysku Projektów)";
        input.placeholder = "6. Paradyż Żarnów/Kolektory/Projekty/Żarnów";
        if (!data.available) {
          showError("matchError", "Dysk Google jest obecnie niedostępny. Sprawdź połączenie internetowe lub usługę rclone." + (data.reason ? ` (${data.reason})` : ""));
        }
      }
    } catch (_) {
      // Brak polaczenia z wlasnym serwerem - zostaw domyslna etykiete.
    }
  })();

  $("excelInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    showError("excelError", "");
    const fd = new FormData();
    fd.append("file", file);
    try {
      const data = await api("/api/excel/upload", { method: "POST", body: fd });
      state.token = data.token;
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
      const data = await api(`/api/excel/${encodeURIComponent(state.token)}/sheets/${encodeURIComponent(sheetName)}/candidates`);
      state.allCandidates = data.candidates;
      state.selectedLp = new Set();
      state.batchResults = [];
      state.pendingGroups = [];
      state.batchSummary = null;
      updateQueueStatus("Kolejka jest pusta.");
      renderCandidates();
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
        .filter(o => o.fileName && !EXCLUDE_FROM_PRINT.has(o.confidence))
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
        body: JSON.stringify({ sheetName: state.sheetName, baseFolder, candidates: selectedCandidates, allAddresses })
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
  const SETTLED = new Set([...CONFIDENT, "obcy adres - pominięte", "wariant - sprawdź ręcznie"]);

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
    const list = document.querySelector(`.order-list[data-gidx="${gIdx}"]`);
    if (!result || !list) return;
    list.innerHTML = result.order.map((item, idx) => {
      const confident = SETTLED.has(item.confidence);
      const classes = ["order-item"];
      classes.push(confident ? "compact" : "needs-review");
      return `
      <li class="${classes.join(" ")}" draggable="true" data-gidx="${gIdx}" data-idx="${idx}">
        <span class="handle">⠿</span>
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
    const items = document.querySelectorAll(`.order-item[data-gidx="${gIdx}"]`);
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

  const EXCLUDE_FROM_PRINT = new Set(["obcy adres - pominięte", "wariant - sprawdź ręcznie"]);

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
          groups
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
            $("statusText").innerHTML = `<div class="success-panel"><span class="big-check">✅</span>Wysłano do druku. Sprawdź drukarkę.</div>`;
          }
        }
      } catch (_) {
        clearInterval(timer);
        $("printBtn").disabled = false;
      }
    }, 800);
  }
})();
