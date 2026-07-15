(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let currentJob = null;
  let currentWorkbook = null;
  let currentGroups = [];
  let pollTimer = null;

  function api(path, options = {}) {
    const opts = { ...options, headers: { ...(options.headers || {}), "X-Scyzoryk-Request": "1" } };
    return fetch(path, opts).then(async res => {
      let data;
      try { data = await res.json(); } catch { data = { ok: false, message: "Błąd serwera." }; }
      if (!res.ok && data.ok !== true) throw new Error(data.message || `Błąd ${res.status}`);
      return data;
    });
  }

  $("templatesInput").addEventListener("change", () => {
    const files = [...$("templatesInput").files].filter(f => /\.(docx|pdf)$/i.test(f.name));
    $("templatesHint").textContent = files.length ? `Wybrano ${files.length} plik(ów) DOCX/PDF` : "Nic nie wybrano";
  });

  $("uploadBtn").addEventListener("click", async () => {
    const templateFiles = [...$("templatesInput").files].filter(f => /\.(docx|pdf)$/i.test(f.name));
    const excel = $("excelInput").files[0];
    if (!templateFiles.length || !excel) { $("uploadStatus").textContent = "Wybierz folder wzorów i plik Excel."; return; }

    const fd = new FormData();
    const relPaths = [];
    for (const f of templateFiles) { fd.append("folderTemplates", f); relPaths.push(f.webkitRelativePath || f.name); }
    fd.append("templatePaths", JSON.stringify(relPaths));
    fd.append("excel", excel);

    $("uploadStatus").textContent = "Wczytuję...";
    try {
      const data = await api("/api/folder-upload", { method: "POST", body: fd });
      currentJob = data.jobId;
      currentWorkbook = data.workbook;
      currentGroups = data.templateGroups || [];
      $("uploadStatus").textContent = `Wczytano. Znaleziono ${currentGroups.length} typów dokumentów, ${data.workbook.totalRows} rekordów w arkuszu "${data.workbook.sheetName}".`;
      renderGroups(currentGroups);
      renderSheetSelect(data.workbook.sheetNames, data.workbook.sheetName);
      renderColumns(data.workbook.columns, data.guessedColumns);
      updateVariantVisibility();
      $("configPanel").classList.remove("hidden");
      $("resultPanel").classList.add("hidden");
    } catch (err) {
      $("uploadStatus").textContent = "Błąd: " + err.message;
    }
  });

  function renderGroups(groups) {
    const recognized = groups.filter(g => g.recognized);
    const unrecognized = groups.filter(g => !g.recognized);
    $("recognizedList").innerHTML = recognized.map(g => groupHtml(g, true)).join("") || '<div class="hint">Brak rozpoznanych typów.</div>';
    $("unrecognizedList").innerHTML = unrecognized.map(g => groupHtml(g, false)).join("") || '<div class="hint">Brak.</div>';
    document.querySelectorAll(".group-check").forEach(ch => ch.addEventListener("change", updateVariantVisibility));
  }

  function groupHtml(g, checked) {
    const variantInfo = g.hasVariants ? `${g.variantsCount} warianty` : "bez wariantów";
    return `<label class="group-item${g.recognized ? "" : " unrecognized"}">
      <input type="checkbox" class="group-check" value="${esc(g.name)}" data-variants="${g.hasVariants ? 1 : 0}" ${checked ? "checked" : ""}>
      <span>${esc(g.name)}</span>
      <small>${variantInfo}</small>
    </label>`;
  }

  function selectedGroupsNeedVariant() {
    return [...document.querySelectorAll(".group-check")].some(ch => ch.checked && ch.dataset.variants === "1");
  }
  function selectedGroupsNeedGmina() {
    return [...document.querySelectorAll(".group-check")].some(ch => ch.checked && ch.value === "Symulacja solarna");
  }
  function updateVariantVisibility() {
    $("variantColumnBox").classList.toggle("hidden", !selectedGroupsNeedVariant());
    $("gminaColumnBox").classList.toggle("hidden", !selectedGroupsNeedGmina());
  }

  function renderSheetSelect(sheetNames, current) {
    $("sheetSelect").innerHTML = (sheetNames || []).map(n => `<option ${n === current ? "selected" : ""}>${esc(n)}</option>`).join("");
  }
  $("sheetSelect").addEventListener("change", async () => {
    if (!currentJob) return;
    const sheet = $("sheetSelect").value;
    try {
      const data = await api(`/api/folder-sheet/${currentJob}/${encodeURIComponent(sheet)}`);
      currentWorkbook = { ...currentWorkbook, ...data.workbook, sheetName: sheet };
      renderColumns(data.workbook.columns, data.guessedColumns);
    } catch (err) {
      $("uploadStatus").textContent = "Błąd zmiany arkusza: " + err.message;
    }
  });

  function renderColumns(columns, guessed) {
    const cols = columns || [];
    const opts = (selected) => `<option value="">— wybierz —</option>` + cols.map(c => `<option ${c === selected ? "selected" : ""}>${esc(c)}</option>`).join("");
    $("numerColumn").innerHTML = opts(guessed && guessed.numer);
    $("adresColumn").innerHTML = opts(guessed && guessed.adres);
    $("gminaColumn").innerHTML = opts(guessed && guessed.gmina);
    $("variantColumn").innerHTML = opts(guessed && guessed.uid);
  }

  $("generateBtn").addEventListener("click", async () => {
    if (!currentJob) return;
    const selectedGroups = [...document.querySelectorAll(".group-check")].filter(ch => ch.checked).map(ch => ch.value);
    if (!selectedGroups.length) { $("genStatus").textContent = "Zaznacz przynajmniej jeden typ dokumentu."; return; }
    if (selectedGroupsNeedVariant() && !$("variantColumn").value) { $("genStatus").textContent = "Wybierz kolumnę wariantu (moc/model) — jest wymagana."; return; }
    if (!$("adresColumn").value) { $("genStatus").textContent = "Wybierz kolumnę adresu."; return; }

    let selectedRows = [];
    if ($("rowsMode").value === "first1" && currentWorkbook && currentWorkbook.rows && currentWorkbook.rows.length) {
      selectedRows = [Number(currentWorkbook.rows[0]._record)];
    }

    $("generateBtn").disabled = true;
    $("genStatus").textContent = "Wysyłam do kolejki...";
    $("progressBar").style.width = "0%";
    try {
      await api(`/api/folder-generate/${currentJob}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sheetName: $("sheetSelect").value,
          selectedGroups,
          selectedRows,
          numerColumn: $("numerColumn").value,
          adresColumn: $("adresColumn").value,
          gminaColumn: $("gminaColumn").value,
          variantColumn: $("variantColumn").value
        })
      });
      pollStatus();
    } catch (err) {
      $("genStatus").textContent = "Błąd: " + err.message;
      $("generateBtn").disabled = false;
    }
  });

  function pollStatus() {
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      try {
        const data = await api(`/api/folder-job/${currentJob}`);
        $("genStatus").textContent = data.progress?.message || "";
        $("progressBar").style.width = (data.progress?.percent || 0) + "%";
        if (data.status === "done" || data.status === "error") {
          clearInterval(pollTimer);
          $("generateBtn").disabled = false;
          renderResult(data);
        }
      } catch (err) {
        clearInterval(pollTimer);
        $("generateBtn").disabled = false;
        $("genStatus").textContent = "Błąd sprawdzania statusu: " + err.message;
      }
    }, 1000);
  }

  function renderResult(data) {
    $("resultPanel").classList.remove("hidden");
    const r = data.result || { created: [], errors: [] };
    $("resultSummary").textContent = r.message || "";
    $("downloadZipBtn").href = `/api/folder-download/${currentJob}/zip`;
    $("downloadZipBtn").classList.toggle("hidden", !(r.created || []).length);
    const items = [];
    for (const c of (r.created || [])) items.push(`<div class="result-item"><span>${esc(c.folder)}</span><span>${esc(c.file)}</span></div>`);
    for (const e of (r.errors || [])) items.push(`<div class="result-item error-item"><span>${esc(e.file)}</span><span>${esc(e.message)}</span></div>`);
    $("resultList").innerHTML = items.join("") || '<div class="hint">Brak wyników.</div>';
  }
})();
