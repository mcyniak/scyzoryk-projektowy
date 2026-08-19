const mainPanelHost = location.hostname === "scyzoryk.localhost" ? "scyzoryk.localhost" : "127.0.0.1";
const mainPanelUrl = `http://${mainPanelHost}:3000`;
document.querySelectorAll("[data-main-link]").forEach(link => { link.href = mainPanelUrl; link.removeAttribute("target"); });
const folderPathInput = document.getElementById("folderPathInput");
const openFolderBtn = document.getElementById("openFolderBtn");
const openError = document.getElementById("openError");
const openPanel = document.getElementById("openPanel");
const emptyPanel = document.getElementById("emptyPanel");
const workPanel = document.getElementById("workPanel");
const doneBanner = document.getElementById("doneBanner");
const progressLabel = document.getElementById("progressLabel");
const currentNameLabel = document.getElementById("currentNameLabel");
const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");
const fileList = document.getElementById("fileList");
const pdfPreview = document.getElementById("pdfPreview");
const previewFallback = document.getElementById("previewFallback");
const zoomOutBtn = document.getElementById("zoomOutBtn");
const zoomFitBtn = document.getElementById("zoomFitBtn");
const zoomInBtn = document.getElementById("zoomInBtn");
const zoomLabel = document.getElementById("zoomLabel");
const newNameInput = document.getElementById("newNameInput");
const extLabel = document.getElementById("extLabel");
const confirmRenameBtn = document.getElementById("confirmRenameBtn");
const renameError = document.getElementById("renameError");

let state = { folderPath: null, total: 0, currentIndex: 0, files: [], previewToken: null };
let previewZoom = "page-width";
let currentPdfUrl = "";
const zoomLevels = [50, 75, 90, 100, 125, 150, 175, 200, 250, 300];
// Numery indeksow, dla ktorych zdazylismy juz wystrzelic prefetch w tej
// sesji - zeby nie wysylac tego samego zadania w kolko przy kazdym
// przejsciu miedzy sasiednimi plikami.
const prefetchedIndexes = new Set();

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function previewUrlFor(index) {
  return `/api/preview/${index}?t=${encodeURIComponent(state.previewToken || "")}`;
}

function buildPreviewUrl(url) {
  if (!url) return "";
  const cleanUrl = String(url).split("#")[0];
  const zoomValue = previewZoom === "page-width" ? "page-width" : String(previewZoom);
  return `${cleanUrl}#zoom=${encodeURIComponent(zoomValue)}&toolbar=0`;
}

// Podglad nastepnego (i poprzedniego) pliku jest pobierany w tle, zanim
// uzytkownik kliknie "dalej" - serwer oznacza te odpowiedzi jako
// cache'owalne (Cache-Control: private, immutable - patrz server.js), wiec
// nastepne przejscie zwykle trafia od razu w cache przegladarki zamiast
// czekac na kolejny odczyt duzego zeskanowanego PDF-a z dysku.
function prefetchNeighborPreviews() {
  const candidates = [state.currentIndex + 1, state.currentIndex - 1];
  for (const idx of candidates) {
    if (idx < 0 || idx >= state.total || prefetchedIndexes.has(idx)) continue;
    prefetchedIndexes.add(idx);
    fetch(previewUrlFor(idx), { headers: { "X-Scyzoryk-Request": "1" } }).catch(() => {});
  }
}

function updateZoomLabel() {
  zoomLabel.textContent = previewZoom === "page-width" ? "" : `${previewZoom}%`;
}

function refreshPreviewZoom() {
  updateZoomLabel();
  if (currentPdfUrl && pdfPreview.style.display !== "none") pdfPreview.src = buildPreviewUrl(currentPdfUrl);
}

function showPdfPreview(url) {
  currentPdfUrl = url;
  pdfPreview.src = buildPreviewUrl(url);
  pdfPreview.style.display = "block";
  previewFallback.style.display = "none";
}

function hidePdfPreview(message) {
  currentPdfUrl = "";
  pdfPreview.style.display = "none";
  pdfPreview.src = "";
  previewFallback.style.display = "flex";
  previewFallback.textContent = message || "Brak pliku do podglądu";
}

function setNumericZoom(nextZoom) {
  previewZoom = Math.max(50, Math.min(300, nextZoom));
  refreshPreviewZoom();
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

function currentEntry() {
  return state.files[state.currentIndex] || null;
}

function renderFileList() {
  fileList.innerHTML = state.files.map((f) => {
    const isCurrent = f.index === state.currentIndex;
    const statusClass = f.renamed ? "is-renamed" : "is-pending";
    const statusText = f.renamed ? "zmieniono" : "czeka";
    return `
      <li class="file-item${isCurrent ? " is-current" : ""}" data-index="${f.index}" style="cursor:pointer;">
        <svg class="icon file-icon"><use href="/shared/icons.svg#i-file-pdf"/></svg>
        <div class="file-meta">
          <span class="file-name">${escapeHtml(f.currentName)}</span>
          <span class="file-sub">${f.renamed ? `pierwotnie: ${escapeHtml(f.originalName)}` : "nazwa ze skanera"}</span>
        </div>
        <span class="file-status ${statusClass}">${statusText}</span>
      </li>`;
  }).join("");

  fileList.querySelectorAll(".file-item").forEach(li => {
    li.addEventListener("click", () => goto(Number(li.dataset.index)));
  });
}

function baseNameWithoutExt(name) {
  const idx = name.lastIndexOf(".");
  return idx > 0 ? name.slice(0, idx) : name;
}

function updateWorkPanel() {
  const entry = currentEntry();
  progressLabel.textContent = `${state.currentIndex + 1} / ${state.total}`;
  prevBtn.disabled = state.currentIndex <= 0;
  nextBtn.disabled = state.currentIndex >= state.total - 1;
  renameError.textContent = "";

  if (!entry) {
    currentNameLabel.textContent = "";
    hidePdfPreview();
    newNameInput.value = "";
    extLabel.textContent = "";
    return;
  }

  currentNameLabel.textContent = `Obecna nazwa: ${entry.currentName}`;
  extLabel.textContent = entry.currentName.slice(entry.currentName.lastIndexOf("."));
  newNameInput.value = entry.renamed ? baseNameWithoutExt(entry.currentName) : "";
  showPdfPreview(previewUrlFor(state.currentIndex));
  prefetchNeighborPreviews();
  newNameInput.focus();
  newNameInput.select();

  const allRenamed = state.files.length > 0 && state.files.every(f => f.renamed);
  doneBanner.style.display = allRenamed ? "block" : "none";

  renderFileList();
}

function applyState(data) {
  const folderChanged = data.folderPath !== state.folderPath;
  state = { folderPath: data.folderPath, total: data.total, currentIndex: data.currentIndex, files: data.files, previewToken: data.previewToken };
  // Nowy folder -> nowy token w URL-ach podgladu (patrz server.js), wiec
  // stare zapamietane numery prefetchu i tak by nigdy wiecej nie trafily -
  // czyscimy od razu, zeby zbior nie rosl bez konca w dlugiej sesji pracy.
  if (folderChanged) prefetchedIndexes.clear();
  if (state.total === 0) {
    openPanel.style.display = "none";
    emptyPanel.style.display = "block";
    workPanel.style.display = "none";
    doneBanner.style.display = "none";
    return;
  }
  openPanel.style.display = "none";
  emptyPanel.style.display = "none";
  workPanel.style.display = "block";
  updateWorkPanel();
}

async function openFolder() {
  const folderPath = folderPathInput.value.trim();
  openError.textContent = "";
  if (!folderPath) { openError.textContent = "Podaj ścieżkę folderu."; return; }
  openFolderBtn.disabled = true;
  openFolderBtn.textContent = "Otwieram...";
  try {
    const data = await api("/api/open-folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folderPath })
    });
    applyState(data);
  } catch (err) {
    openError.textContent = err.message;
  } finally {
    openFolderBtn.disabled = false;
    openFolderBtn.textContent = "Otwórz folder";
  }
}

async function goto(index) {
  try {
    const data = await api("/api/goto", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ index })
    });
    applyState(data);
  } catch (err) {
    renameError.textContent = err.message;
  }
}

async function next() {
  try { applyState(await api("/api/next", { method: "POST", headers: { "Content-Type": "application/json" } })); }
  catch (err) { renameError.textContent = err.message; }
}

async function prev() {
  try { applyState(await api("/api/prev", { method: "POST", headers: { "Content-Type": "application/json" } })); }
  catch (err) { renameError.textContent = err.message; }
}

async function confirmRename() {
  renameError.textContent = "";
  confirmRenameBtn.disabled = true;
  try {
    const data = await api("/api/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newName: newNameInput.value })
    });
    applyState(data);
  } catch (err) {
    renameError.textContent = err.message;
  } finally {
    confirmRenameBtn.disabled = false;
  }
}

openFolderBtn.addEventListener("click", openFolder);
folderPathInput.addEventListener("keydown", (e) => { if (e.key === "Enter") openFolder(); });
prevBtn.addEventListener("click", prev);
nextBtn.addEventListener("click", next);
confirmRenameBtn.addEventListener("click", confirmRename);
newNameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") confirmRename(); });

zoomFitBtn.addEventListener("click", () => { previewZoom = "page-width"; refreshPreviewZoom(); });
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

updateZoomLabel();

// Sesja jest przechowywana po stronie serwera (cookie), ale sciezka folderu
// CELOWO nie jest zapamietywana miedzy wizytami (ustalone w planie) - przy
// pierwszym zaladowaniu strony zawsze pokazujemy pusty formularz otwarcia
// folderu, nawet jesli serwer mialby jeszcze aktywna sesje z poprzedniej wizyty.
