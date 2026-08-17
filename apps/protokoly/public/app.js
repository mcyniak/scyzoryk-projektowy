const mainPanelHost = location.hostname === "scyzoryk.localhost" ? "scyzoryk.localhost" : "127.0.0.1";
const mainPanelUrl = `http://${mainPanelHost}:3000`;
document.querySelectorAll("[data-main-link]").forEach(link => { link.href = mainPanelUrl; link.removeAttribute("target"); });

const baseFolderInput = document.getElementById("baseFolderInput");
const browseFolderBtn = document.getElementById("browseFolderBtn");
const folderBrowseModal = document.getElementById("folderBrowseModal");
const folderBrowseClose = document.getElementById("folderBrowseClose");
const folderBrowseCurrentPath = document.getElementById("folderBrowseCurrentPath");
const folderBrowseList = document.getElementById("folderBrowseList");
const folderBrowseSelect = document.getElementById("folderBrowseSelect");
const scanBtn = document.getElementById("scanBtn");
const scanError = document.getElementById("scanError");
const scanProgress = document.getElementById("scanProgress");
const emptyPanel = document.getElementById("emptyPanel");
const resultsPanel = document.getElementById("resultsPanel");
const resultsSummary = document.getElementById("resultsSummary");
const resultsTable = document.getElementById("resultsTable");
const saveAllBtn = document.getElementById("saveAllBtn");
const overwriteAllCheckbox = document.getElementById("overwriteAllCheckbox");
const previewPanel = document.getElementById("previewPanel");
const previewAdres = document.getElementById("previewAdres");
const previewSaveBtn = document.getElementById("previewSaveBtn");
const previewStatus = document.getElementById("previewStatus");
const pdfPreview = document.getElementById("pdfPreview");
const photoThumbs = document.getElementById("photoThumbs");
const zoomOutBtn = document.getElementById("zoomOutBtn");
const zoomFitBtn = document.getElementById("zoomFitBtn");
const zoomInBtn = document.getElementById("zoomInBtn");
const zoomLabel = document.getElementById("zoomLabel");

// rotations: { [folderName]: { [indeks_zdjecia]: stopnie(0/90/180/270) } } -
// reczne poprawki obrotu z podgladu, trwaja do nowego skanu (nie do
// przelaczenia miedzy adresami).
let state = { baseFolder: "", results: [], previewFolderName: null, rotations: {} };
let previewZoom = "page-width";
const zoomLevels = [50, 75, 90, 100, 125, 150, 175, 200, 250, 300];

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
  if (!state.results.length) {
    resultsPanel.style.display = "none";
    emptyPanel.style.display = "";
    return;
  }
  emptyPanel.style.display = "none";
  resultsPanel.style.display = "";

  const withPhotos = state.results.filter(r => r.photoCount > 0 && !r.error);
  resultsSummary.textContent = `(${withPhotos.length} z ${state.results.length} ma zdjęcia protokołu)`;

  resultsTable.innerHTML = `
    <div class="table-wrap">
    <table class="table zebra">
      <thead><tr><th>Adres</th><th>Zdjęć</th><th>Status</th><th class="col-actions"></th></tr></thead>
      <tbody>
        ${state.results.map(r => {
          if (r.error) {
            return `<tr><td>${escapeHtml(r.adres)}</td><td>-</td><td><span class="badge badge-danger"><svg class="icon"><use href="/shared/icons.svg#i-alert-circle"/></svg>błąd: ${escapeHtml(r.error)}</span></td><td></td></tr>`;
          }
          if (!r.photoCount) {
            return `<tr><td>${escapeHtml(r.adres)}</td><td>0</td><td><span class="badge badge-neutral">brak zdjęć</span></td><td></td></tr>`;
          }
          const savedBadge = r.savedPath ? `<span class="badge badge-success"><svg class="icon"><use href="/shared/icons.svg#i-check-circle"/></svg>zapisano</span>` : "";
          const skippedBadge = (r.skippedPhotos && r.skippedPhotos.length)
            ? ` <span class="badge badge-warning" title="${escapeHtml(r.skippedPhotos.join(", "))}"><svg class="icon"><use href="/shared/icons.svg#i-alert-triangle"/></svg>pominięto ${r.skippedPhotos.length} nieczytelnych</span>`
            : "";
          return `
            <tr data-folder="${escapeHtml(r.folderName)}">
              <td>${escapeHtml(r.adres)}</td>
              <td>${r.photoCount}</td>
              <td>${savedBadge}${skippedBadge}</td>
              <td class="col-actions">
                <button class="btn btn-ghost btn-sm" data-action="preview" data-folder="${escapeHtml(r.folderName)}" type="button">
                  <svg class="icon"><use href="/shared/icons.svg#i-eye"/></svg>
                  Podgląd
                </button>
                <button class="btn btn-secondary btn-sm" data-action="save" data-folder="${escapeHtml(r.folderName)}" type="button">
                  <svg class="icon"><use href="/shared/icons.svg#i-download"/></svg>
                  Zapisz
                </button>
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

// Przegladarka folderow w stronie zamiast recznego wpisywania sciezki -
// ten sam mechanizm co apps/drukarka-projekty (patrz lib/folderBrowse.js).
let currentBrowsePath = null;

function closeFolderBrowser() {
  folderBrowseModal.classList.remove("open");
}

async function openFolderBrowser(startPath) {
  folderBrowseModal.classList.add("open");
  await loadFolderBrowse(startPath);
}

async function loadFolderBrowse(targetPath) {
  folderBrowseList.innerHTML = '<div class="folder-row">Wczytuję...</div>';
  try {
    const url = targetPath ? `/api/browse-folder?path=${encodeURIComponent(targetPath)}` : "/api/browse-folder";
    const res = await fetch(url);
    const json = await res.json().catch(() => null);
    if (!json || !json.ok) {
      folderBrowseList.innerHTML = `<div class="folder-row">${escapeHtml((json && json.error) || "Nie udało się wczytać folderów.")}</div>`;
      return;
    }
    currentBrowsePath = json.path;
    folderBrowseCurrentPath.textContent = json.path || "Wybierz dysk";

    const rows = [];
    if (json.path !== null) {
      const isDriveRoot = json.parent === null;
      const upTarget = isDriveRoot ? "" : json.parent;
      rows.push(`<div class="folder-row clickable up-nav" data-path="${escapeHtml(upTarget)}">${isDriveRoot ? "⬆ Lista dysków" : "⬆ .."}</div>`);
    }
    for (const entry of json.entries) {
      rows.push(`<div class="folder-row clickable" data-path="${escapeHtml(entry.path)}">📁 ${escapeHtml(entry.name)}</div>`);
    }
    folderBrowseList.innerHTML = rows.join("") || '<div class="folder-row">Brak podfolderów.</div>';
  } catch (error) {
    folderBrowseList.innerHTML = `<div class="folder-row">${escapeHtml(String(error.message || error))}</div>`;
  }
}

browseFolderBtn.addEventListener("click", () => {
  const startPath = baseFolderInput.value.trim();
  openFolderBrowser(startPath || null);
});
folderBrowseClose.addEventListener("click", closeFolderBrowser);
folderBrowseModal.addEventListener("click", (event) => {
  if (event.target.id === "folderBrowseModal") closeFolderBrowser();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && folderBrowseModal.classList.contains("open")) closeFolderBrowser();
});
folderBrowseList.addEventListener("click", (event) => {
  const row = event.target.closest("[data-path]");
  if (!row) return;
  loadFolderBrowse(row.dataset.path);
});
folderBrowseSelect.addEventListener("click", () => {
  if (!currentBrowsePath) return;
  baseFolderInput.value = currentBrowsePath;
  closeFolderBrowser();
  baseFolderInput.dispatchEvent(new Event("change"));
});

scanBtn.addEventListener("click", async () => {
  const baseFolder = baseFolderInput.value.trim();
  if (!baseFolder) { scanError.textContent = "Podaj ścieżkę folderu bazowego."; return; }
  scanError.textContent = "";
  scanBtn.disabled = true;
  scanBtn.textContent = "Skanuję...";
  scanProgress.style.display = "";
  previewPanel.style.display = "none";
  try {
    const data = await api("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseFolder })
    });
    state.baseFolder = baseFolder;
    state.rotations = {};
    // existingPath (sprawdzone na dysku przez /api/scan) traktujemy tak samo
    // jak savedPath z tej sesji - bez tego ponowny skan tego samego folderu
    // bazowego pokazywal wszystko jako "do zapisania" na nowo, mimo ze plik
    // juz naprawde tam byl.
    state.results = data.results.map(r => ({ ...r, savedPath: r.savedPath || r.existingPath || null }));
    renderResults();
  } catch (err) {
    scanError.textContent = err.message;
  } finally {
    scanBtn.disabled = false;
    scanBtn.innerHTML = '<svg class="icon"><use href="/shared/icons.svg#i-search"/></svg>Skanuj';
    scanProgress.style.display = "none";
  }
});

function rotationsForFolder(folderName) {
  if (!state.rotations[folderName]) state.rotations[folderName] = {};
  return state.rotations[folderName];
}

function buildPreviewUrl(folderName) {
  const rotations = rotationsForFolder(folderName);
  let url = `/api/preview?baseFolder=${encodeURIComponent(state.baseFolder)}&folderName=${encodeURIComponent(folderName)}`;
  if (Object.keys(rotations).length) url += `&rotations=${encodeURIComponent(JSON.stringify(rotations))}`;
  const zoomValue = previewZoom === "page-width" ? "page-width" : String(previewZoom);
  return `${url}#zoom=${encodeURIComponent(zoomValue)}&toolbar=0`;
}

function updateZoomLabel() {
  zoomLabel.textContent = previewZoom === "page-width" ? "Dopasuj" : `${previewZoom}%`;
}

function refreshPdfPreview(folderName) {
  updateZoomLabel();
  pdfPreview.src = buildPreviewUrl(folderName);
}

function setNumericZoom(nextZoom) {
  previewZoom = Math.max(50, Math.min(300, nextZoom));
  if (state.previewFolderName) refreshPdfPreview(state.previewFolderName);
}

zoomFitBtn.addEventListener("click", () => { previewZoom = "page-width"; if (state.previewFolderName) refreshPdfPreview(state.previewFolderName); });
zoomOutBtn.addEventListener("click", () => {
  if (previewZoom === "page-width") { setNumericZoom(100); return; }
  const currentIndex = zoomLevels.findIndex(x => x >= previewZoom);
  setNumericZoom(zoomLevels[currentIndex <= 0 ? 0 : currentIndex - 1]);
});
zoomInBtn.addEventListener("click", () => {
  if (previewZoom === "page-width") { setNumericZoom(125); return; }
  const currentIndex = zoomLevels.findIndex(x => x > previewZoom);
  setNumericZoom(currentIndex === -1 ? zoomLevels[zoomLevels.length - 1] : zoomLevels[currentIndex]);
});

async function renderPhotoThumbs(folderName) {
  photoThumbs.innerHTML = "";
  let data;
  try {
    data = await api(`/api/photos?baseFolder=${encodeURIComponent(state.baseFolder)}&folderName=${encodeURIComponent(folderName)}`);
  } catch (err) {
    return;
  }
  const rotations = rotationsForFolder(folderName);
  photoThumbs.innerHTML = data.photos.map(p => {
    const rotate = rotations[p.index] || 0;
    return `
      <div class="photo-thumb" data-index="${p.index}">
        <img src="/api/photo-thumb?baseFolder=${encodeURIComponent(state.baseFolder)}&folderName=${encodeURIComponent(folderName)}&index=${p.index}&rotate=${rotate}" alt="Zdjęcie ${p.index + 1}" />
        <div class="photo-thumb-body">
          <span class="photo-thumb-label">Zdjęcie ${p.index + 1}</span>
          <button class="btn btn-ghost btn-sm" data-action="rotate" data-index="${p.index}" type="button">
            <svg class="icon"><use href="/shared/icons.svg#i-refresh"/></svg>
            Obróć
          </button>
        </div>
      </div>`;
  }).join("");

  photoThumbs.querySelectorAll('[data-action="rotate"]').forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = btn.dataset.index;
      const current = rotations[idx] || 0;
      rotations[idx] = (current + 90) % 360;
      const img = photoThumbs.querySelector(`.photo-thumb[data-index="${idx}"] img`);
      if (img) img.src = `/api/photo-thumb?baseFolder=${encodeURIComponent(state.baseFolder)}&folderName=${encodeURIComponent(folderName)}&index=${idx}&rotate=${rotations[idx]}&t=${Date.now()}`;
      refreshPdfPreview(folderName);
    });
  });

  // Audyt na zywo 2026-08-14: pojedyncze zdjecie potrafi byc nieczytelne dla
  // dekodera (strukturalnie poprawny JPEG, ktorego pure-JS dekoder Jimpa mimo
  // to nie otwiera) - PDF sobie z tym radzi (pomija taka strone, patrz
  // buildProtocolPdf), ale miniatura bez tego wygladala jak zwykla martwa
  // ikonka przegladarki, bez wyjasnienia. Podmieniamy ja na czytelny opis.
  photoThumbs.querySelectorAll(".photo-thumb img").forEach(img => {
    img.addEventListener("error", () => {
      const wrap = img.closest(".photo-thumb");
      if (wrap) wrap.classList.add("photo-thumb-broken");
    }, { once: true });
  });
}

function openPreview(folderName) {
  state.previewFolderName = folderName;
  previewZoom = "page-width";
  const entry = state.results.find(r => r.folderName === folderName);
  previewAdres.textContent = entry ? entry.adres : folderName;
  previewStatus.textContent = "";
  refreshPdfPreview(folderName);
  renderPhotoThumbs(folderName);
  previewPanel.style.display = "";
  previewPanel.scrollIntoView({ behavior: "smooth", block: "start" });
}

previewSaveBtn.addEventListener("click", async () => {
  if (!state.previewFolderName) return;
  await saveOne(state.previewFolderName, previewSaveBtn, previewStatus);
});

async function saveOne(folderName, triggerBtn, statusEl) {
  const originalHtml = triggerBtn ? triggerBtn.innerHTML : "";
  if (triggerBtn) { triggerBtn.disabled = true; triggerBtn.textContent = "Zapisuję..."; }
  try {
    const rotations = state.rotations[folderName] || {};
    const data = await api("/api/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseFolder: state.baseFolder, folderName, rotations })
    });
    const entry = state.results.find(r => r.folderName === folderName);
    if (entry) { entry.savedPath = data.savedPath; entry.skippedPhotos = data.skippedPhotos || []; }
    const skipped = data.skippedPhotos || [];
    if (statusEl) {
      statusEl.textContent = skipped.length
        ? `Zapisano: ${data.savedPath} (pominięto ${skipped.length} nieczytelnych zdjęć: ${skipped.join(", ")})`
        : `Zapisano: ${data.savedPath}`;
    }
    renderResults();
  } catch (err) {
    if (statusEl) statusEl.textContent = `Błąd: ${err.message}`;
    else alert(`Nie udało się zapisać: ${err.message}`);
  } finally {
    if (triggerBtn) { triggerBtn.disabled = false; triggerBtn.innerHTML = originalHtml; }
  }
}

saveAllBtn.addEventListener("click", async () => {
  const overwriteAll = overwriteAllCheckbox.checked;
  const targets = state.results.filter(r => r.photoCount > 0 && !r.error && (overwriteAll || !r.savedPath));
  if (!targets.length) { alert("Nie ma nic do zapisania (wszystko już zapisane albo brak zdjęć)."); return; }
  const confirmMsg = overwriteAll
    ? `Zapisać (i nadpisać już istniejące) ${targets.length} PDF-ów do odpowiednich folderów adresów?`
    : `Zapisać ${targets.length} PDF-ów do odpowiednich folderów adresów?`;
  if (!confirm(confirmMsg)) return;
  saveAllBtn.disabled = true;
  let done = 0;
  for (const r of targets) {
    saveAllBtn.textContent = `Zapisuję... (${done + 1}/${targets.length})`;
    try {
      const rotations = state.rotations[r.folderName] || {};
      const data = await api("/api/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseFolder: state.baseFolder, folderName: r.folderName, rotations })
      });
      r.savedPath = data.savedPath;
      r.skippedPhotos = data.skippedPhotos || [];
    } catch (err) {
      r.error = `zapis nieudany: ${err.message}`;
    }
    done++;
    renderResults();
  }
  saveAllBtn.disabled = false;
  saveAllBtn.innerHTML = '<svg class="icon"><use href="/shared/icons.svg#i-download"/></svg>Zapisz wszystkie';
});
