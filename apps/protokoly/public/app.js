const mainPanelHost = location.hostname === "scyzoryk.localhost" ? "scyzoryk.localhost" : "127.0.0.1";
const mainPanelUrl = `http://${mainPanelHost}:3000`;
document.querySelectorAll("[data-main-link]").forEach(link => { link.href = mainPanelUrl; link.removeAttribute("target"); });

const baseFolderInput = document.getElementById("baseFolderInput");
const scanBtn = document.getElementById("scanBtn");
const scanError = document.getElementById("scanError");
const resultsPanel = document.getElementById("resultsPanel");
const resultsSummary = document.getElementById("resultsSummary");
const resultsTable = document.getElementById("resultsTable");
const saveAllBtn = document.getElementById("saveAllBtn");
const previewPanel = document.getElementById("previewPanel");
const previewAdres = document.getElementById("previewAdres");
const previewSaveBtn = document.getElementById("previewSaveBtn");
const previewStatus = document.getElementById("previewStatus");
const pdfPreview = document.getElementById("pdfPreview");

let state = { baseFolder: "", results: [], previewFolderName: null };

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function api(path, options = {}) {
  const opts = { ...options, headers: { ...(options.headers || {}), "X-Scyzoryk-Request": "1" } };
  const res = await fetch(path, opts);
  let data;
  try { data = await res.json(); } catch { data = { ok: false, message: "Błędna odpowiedź serwera." }; }
  if (!res.ok && data.ok !== true) {
    const err = new Error(data.message || `Błąd ${res.status}`);
    err.data = data;
    throw err;
  }
  return data;
}

function renderResults() {
  const withPhotos = state.results.filter(r => r.photoCount > 0 && !r.error);
  resultsSummary.textContent = `(${withPhotos.length} z ${state.results.length} ma zdjęcia protokołu)`;

  resultsTable.innerHTML = `
    <div class="table-wrap">
    <table class="table zebra">
      <thead><tr><th>Adres</th><th>Zdjęć</th><th>Status</th><th class="col-actions"></th></tr></thead>
      <tbody>
        ${state.results.map(r => {
          if (r.error) {
            return `<tr><td>${escapeHtml(r.adres)}</td><td>-</td><td><span class="badge unknown">błąd: ${escapeHtml(r.error)}</span></td><td></td></tr>`;
          }
          if (!r.photoCount) {
            return `<tr><td>${escapeHtml(r.adres)}</td><td>0</td><td><span class="badge unknown">brak zdjęć</span></td><td></td></tr>`;
          }
          const savedBadge = r.savedPath ? `<span class="badge ok">zapisano</span>` : "";
          return `
            <tr data-folder="${escapeHtml(r.folderName)}">
              <td>${escapeHtml(r.adres)}</td>
              <td>${r.photoCount}</td>
              <td>${savedBadge}</td>
              <td class="col-actions">
                <button class="btn btn-ghost btn-sm" data-action="preview" data-folder="${escapeHtml(r.folderName)}" type="button">Podgląd</button>
                <button class="btn btn-secondary btn-sm" data-action="save" data-folder="${escapeHtml(r.folderName)}" type="button">Zapisz</button>
              </td>
            </tr>`;
        }).join("")}
      </tbody>
    </table>
    </div>
  `;

  resultsTable.querySelectorAll('[data-action="preview"]').forEach(btn => {
    btn.addEventListener("click", () => openPreview(btn.dataset.folder));
  });
  resultsTable.querySelectorAll('[data-action="save"]').forEach(btn => {
    btn.addEventListener("click", () => saveOne(btn.dataset.folder, btn));
  });
}

scanBtn.addEventListener("click", async () => {
  const baseFolder = baseFolderInput.value.trim();
  if (!baseFolder) { scanError.textContent = "Podaj ścieżkę folderu bazowego."; return; }
  scanError.textContent = "";
  scanBtn.disabled = true;
  scanBtn.textContent = "Skanuję...";
  try {
    const data = await api("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseFolder })
    });
    state.baseFolder = baseFolder;
    // existingPath (sprawdzone na dysku przez /api/scan) traktujemy tak samo
    // jak savedPath z tej sesji - bez tego ponowny skan tego samego folderu
    // bazowego pokazywal wszystko jako "do zapisania" na nowo, mimo ze plik
    // juz naprawde tam byl.
    state.results = data.results.map(r => ({ ...r, savedPath: r.savedPath || r.existingPath || null }));
    resultsPanel.style.display = "";
    renderResults();
  } catch (err) {
    scanError.textContent = err.message;
  } finally {
    scanBtn.disabled = false;
    scanBtn.textContent = "Skanuj";
  }
});

function openPreview(folderName) {
  state.previewFolderName = folderName;
  const entry = state.results.find(r => r.folderName === folderName);
  previewAdres.textContent = entry ? entry.adres : folderName;
  previewStatus.textContent = "";
  const url = `/api/preview?baseFolder=${encodeURIComponent(state.baseFolder)}&folderName=${encodeURIComponent(folderName)}`;
  pdfPreview.src = url;
  previewPanel.style.display = "";
  previewPanel.scrollIntoView({ behavior: "smooth", block: "start" });
}

previewSaveBtn.addEventListener("click", async () => {
  if (!state.previewFolderName) return;
  await saveOne(state.previewFolderName, previewSaveBtn, previewStatus);
});

async function saveOne(folderName, triggerBtn, statusEl) {
  const originalText = triggerBtn ? triggerBtn.textContent : "";
  if (triggerBtn) { triggerBtn.disabled = true; triggerBtn.textContent = "Zapisuję..."; }
  try {
    const data = await api("/api/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseFolder: state.baseFolder, folderName })
    });
    const entry = state.results.find(r => r.folderName === folderName);
    if (entry) entry.savedPath = data.savedPath;
    if (statusEl) statusEl.textContent = `Zapisano: ${data.savedPath}`;
    renderResults();
  } catch (err) {
    if (statusEl) statusEl.textContent = `Błąd: ${err.message}`;
    else alert(`Nie udało się zapisać: ${err.message}`);
  } finally {
    if (triggerBtn) { triggerBtn.disabled = false; triggerBtn.textContent = originalText; }
  }
}

saveAllBtn.addEventListener("click", async () => {
  const targets = state.results.filter(r => r.photoCount > 0 && !r.error && !r.savedPath);
  if (!targets.length) { alert("Nie ma nic do zapisania (wszystko już zapisane albo brak zdjęć)."); return; }
  if (!confirm(`Zapisać ${targets.length} PDF-ów do odpowiednich folderów adresów?`)) return;
  saveAllBtn.disabled = true;
  let done = 0;
  for (const r of targets) {
    saveAllBtn.textContent = `Zapisuję... (${done + 1}/${targets.length})`;
    try {
      const data = await api("/api/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseFolder: state.baseFolder, folderName: r.folderName })
      });
      r.savedPath = data.savedPath;
    } catch (err) {
      r.error = `zapis nieudany: ${err.message}`;
    }
    done++;
    renderResults();
  }
  saveAllBtn.disabled = false;
  saveAllBtn.textContent = "Zapisz wszystkie (z zdjęciami)";
});
