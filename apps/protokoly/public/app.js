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
const overwriteAllCheckbox = document.getElementById("overwriteAllCheckbox");
const previewPanel = document.getElementById("previewPanel");
const previewAdres = document.getElementById("previewAdres");
const previewSaveBtn = document.getElementById("previewSaveBtn");
const previewStatus = document.getElementById("previewStatus");
const pdfPreview = document.getElementById("pdfPreview");
const photoThumbs = document.getElementById("photoThumbs");

// rotations: { [folderName]: { [indeks_zdjecia]: stopnie(0/90/180/270) } } -
// reczne poprawki obrotu z podgladu, trwaja do nowego skanu (nie do
// przelaczenia miedzy adresami).
let state = { baseFolder: "", results: [], previewFolderName: null, rotations: {} };

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
          const skippedBadge = (r.skippedPhotos && r.skippedPhotos.length)
            ? ` <span class="badge unknown" title="${escapeHtml(r.skippedPhotos.join(", "))}">pominięto ${r.skippedPhotos.length} nieczytelnych</span>`
            : "";
          return `
            <tr data-folder="${escapeHtml(r.folderName)}">
              <td>${escapeHtml(r.adres)}</td>
              <td>${r.photoCount}</td>
              <td>${savedBadge}${skippedBadge}</td>
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
    state.rotations = {};
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

function rotationsForFolder(folderName) {
  if (!state.rotations[folderName]) state.rotations[folderName] = {};
  return state.rotations[folderName];
}

function buildPreviewUrl(folderName) {
  const rotations = rotationsForFolder(folderName);
  let url = `/api/preview?baseFolder=${encodeURIComponent(state.baseFolder)}&folderName=${encodeURIComponent(folderName)}`;
  if (Object.keys(rotations).length) url += `&rotations=${encodeURIComponent(JSON.stringify(rotations))}`;
  return url;
}

function refreshPdfPreview(folderName) {
  pdfPreview.src = buildPreviewUrl(folderName);
}

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
        <span class="photo-thumb-label">Zdjęcie ${p.index + 1}</span>
        <button class="btn btn-ghost btn-sm" data-action="rotate" data-index="${p.index}" type="button">Obróć</button>
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
  const originalText = triggerBtn ? triggerBtn.textContent : "";
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
    if (triggerBtn) { triggerBtn.disabled = false; triggerBtn.textContent = originalText; }
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
  saveAllBtn.textContent = "Zapisz wszystkie (z zdjęciami)";
});
