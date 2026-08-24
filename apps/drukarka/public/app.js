const fileInput = document.getElementById("fileInput");
const addBtn = document.getElementById("addBtn");
const clearBtn = document.getElementById("clearBtn");
const printBtn = document.getElementById("printBtn");
const delayInput = document.getElementById("delayInput");
const copiesInput = document.getElementById("copiesInput");
const sideModeInput = document.getElementById("sideModeInput");
const printerSelectInput = document.getElementById("printerSelectInput");
const copyModeInput = document.getElementById("copyModeInput");
const mergeFilesInput = document.getElementById("mergeFilesInput");
const jobSummary = document.getElementById("jobSummary");
const fileList = document.getElementById("fileList");
const dropZone = document.getElementById("dropZone");
const statusText = document.getElementById("statusText");
const progressBar = document.getElementById("progressBar");
const statusBox = document.querySelector(".status-box");
const pdfPreview = document.getElementById("pdfPreview");
const previewFallback = document.getElementById("previewFallback");
const zoomOutBtn = document.getElementById("zoomOutBtn");
const zoomFitBtn = document.getElementById("zoomFitBtn");
const zoomInBtn = document.getElementById("zoomInBtn");
const zoomLabel = document.getElementById("zoomLabel");

let queue = [];
let draggedId = null;
let statusTimer = null;
let currentPdfUrl = "";
let previewZoom = "page-width";
let autoScrollFrame = null;
let autoScrollClientY = 0;
const zoomLevels = [50, 75, 90, 100, 125, 150, 175, 200, 250, 300];

function fileExt(name) {
  return "." + String(name).split(".").pop().toLowerCase();
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function buildPreviewUrl(url) {
  if (!url) return "";
  const cleanUrl = String(url).split("#")[0];
  const zoomValue = previewZoom === "page-width" ? "page-width" : String(previewZoom);
  // "toolbar=0" wylacza WLASNY pasek narzedzi przegladarki (Chrome/Edge PDF
  // viewer) w ramce podgladu - bez tego byly widoczne DWA rzedy kontrolek
  // powiekszenia (nasz wlasny + natywny), a natywny mial tez wlasne przyciski
  // "Drukuj"/"Pobierz", ktore omijaly kolejke/druk tej aplikacji.
  return `${cleanUrl}#zoom=${encodeURIComponent(zoomValue)}&toolbar=0`;
}

function updateZoomLabel() {
  // W trybie "Dopasuj" etykieta pokazywala ten sam tekst co przycisk
  // zoomFitBtn tuz obok - dwa razy "Dopasuj" wygladalo na pomylke, nie
  // celowy design. Etykieta ma sens tylko dla konkretnego procentu, ktorego
  // zaden przycisk juz nie pokazuje.
  zoomLabel.textContent = previewZoom === "page-width" ? "" : `${previewZoom}%`;
}

function refreshPreviewZoom() {
  updateZoomLabel();
  if (currentPdfUrl && pdfPreview.style.display !== "none") {
    pdfPreview.src = buildPreviewUrl(currentPdfUrl);
  }
}

function showPdfPreview(url) {
  currentPdfUrl = url;
  pdfPreview.src = buildPreviewUrl(url);
  pdfPreview.style.display = "block";
  previewFallback.style.display = "none";
}

function hidePdfPreview(message = "Wybierz PDF z listy") {
  currentPdfUrl = "";
  pdfPreview.style.display = "none";
  pdfPreview.src = "";
  previewFallback.style.display = "flex";
  previewFallback.textContent = message;
}

function setNumericZoom(nextZoom) {
  previewZoom = Math.max(50, Math.min(300, nextZoom));
  refreshPreviewZoom();
}

function getPrintOptions() {
  const copies = clampNumber(copiesInput.value, 1, 20, 1);
  const delaySeconds = clampNumber(delayInput.value, 1, 300, 1);
  const sideMode = sideModeInput.value === "one-sided" ? "one-sided" : "two-sided";
  const copyMode = copyModeInput.value === "set" ? "set" : "file";
  const printerName = printerSelectInput ? printerSelectInput.value : "";
  const mergeFiles = mergeFilesInput ? mergeFilesInput.checked : true;

  copiesInput.value = copies;
  delayInput.value = delaySeconds;

  return { copies, delaySeconds, sideMode, copyMode, printerName, mergeFiles };
}

// Odzwierciedla dokladnie ta sama regule co server.js#buildMergedPrintItems:
// sasiadujace w kolejce pliki PDF licza sie jako JEDNO zadanie druku, ale
// tylko gdy uzytkownik nie wylaczyl laczenia i to nie zmienia znaczenia
// "kopia przy kazdym pliku" (patrz mergeChangesCopySemantics w server.js) -
// inaczej liczba pokazana tutaj myliloby, ile realnie zadan pojdzie do drukarki.
function countPrintUnits(copies, copyMode, mergeFiles) {
  if (!mergeFiles) return queue.length;
  if (copies > 1 && copyMode === "file") return queue.length;
  let units = 0;
  let i = 0;
  while (i < queue.length) {
    if (queue[i].ext === ".pdf") {
      let runLength = 0;
      while (i < queue.length && queue[i].ext === ".pdf") { runLength += 1; i += 1; }
      units += 1;
    } else {
      units += 1;
      i += 1;
    }
  }
  return units;
}

function updateJobSummary() {
  const options = getPrintOptions();
  const sides = options.sideMode === "two-sided" ? "dwustronnie" : "jednostronnie";
  const copiesText = options.copies === 1 ? "1 kopia" : `${options.copies} kopie`;
  const modeText = options.copyMode === "set"
    ? "najpierw komplet, potem kolejna kopia kompletu"
    : "kopia przy każdym pliku";
  const jobCount = countPrintUnits(options.copies, options.copyMode, options.mergeFiles) * options.copies;

  jobSummary.textContent = `${copiesText} · ${sides} · ${modeText} · wydruków do wysłania: ${jobCount}`;
}

function setPrintingUi(isPrinting) {
  addBtn.disabled = isPrinting;
  clearBtn.disabled = isPrinting;
  printBtn.disabled = isPrinting;
  dropZone.classList.toggle("disabled", isPrinting);
  fileList.classList.toggle("locked", isPrinting);
  dropZone.setAttribute("aria-disabled", isPrinting ? "true" : "false");
}


function getAutoScrollSpeed(clientY, rect, threshold = 86, maxSpeed = 22) {
  if (clientY < rect.top + threshold) {
    return -Math.ceil(((rect.top + threshold - clientY) / threshold) * maxSpeed);
  }

  if (clientY > rect.bottom - threshold) {
    return Math.ceil(((clientY - (rect.bottom - threshold)) / threshold) * maxSpeed);
  }

  return 0;
}

function autoScrollLoop() {
  if (!draggedId) {
    autoScrollFrame = null;
    return;
  }

  const listRect = fileList.getBoundingClientRect();
  const listSpeed = getAutoScrollSpeed(autoScrollClientY, listRect);

  if (listSpeed !== 0) {
    fileList.scrollTop += listSpeed;
  } else {
    const viewportRect = { top: 0, bottom: window.innerHeight };
    const windowSpeed = getAutoScrollSpeed(autoScrollClientY, viewportRect, 92, 18);
    if (windowSpeed !== 0) window.scrollBy(0, windowSpeed);
  }

  autoScrollFrame = requestAnimationFrame(autoScrollLoop);
}

function updateAutoScroll(clientY) {
  autoScrollClientY = clientY;
  if (!autoScrollFrame) autoScrollFrame = requestAnimationFrame(autoScrollLoop);
}

function stopAutoScroll() {
  if (autoScrollFrame) cancelAnimationFrame(autoScrollFrame);
  autoScrollFrame = null;
}

async function moveQueueItem(from, to) {
  if (addBtn.disabled) {
    statusText.textContent = "Trwa drukowanie. Poczekaj aż zakończy się wysyłanie plików do kolejki.";
    return;
  }

  if (from < 0 || to < 0 || from >= queue.length || to >= queue.length || from === to) return;

  const [moved] = queue.splice(from, 1);
  queue.splice(to, 0, moved);
  render();
  await saveOrder();
}

function render() {
  fileList.innerHTML = "";
  dropZone.classList.toggle("has-files", queue.length > 0);

  queue.forEach((file, index) => {
    const li = document.createElement("li");
    li.className = "file-item";
    li.draggable = !addBtn.disabled;
    li.dataset.id = file.id;

    const handle = document.createElement("div");
    handle.className = "handle";
    handle.textContent = "☰";

    const name = document.createElement("div");
    name.className = "file-name";
    name.textContent = `${index + 1}. ${file.originalName}`;

    const moveActions = document.createElement("div");
    moveActions.className = "move-actions";

    const upBtn = document.createElement("button");
    upBtn.className = "move-btn";
    upBtn.type = "button";
    upBtn.textContent = "↑";
    upBtn.title = "Przenieś wyżej";
    upBtn.disabled = index === 0 || addBtn.disabled;

    const downBtn = document.createElement("button");
    downBtn.className = "move-btn";
    downBtn.type = "button";
    downBtn.textContent = "↓";
    downBtn.title = "Przenieś niżej";
    downBtn.disabled = index === queue.length - 1 || addBtn.disabled;

    upBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await moveQueueItem(index, index - 1);
    });

    downBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await moveQueueItem(index, index + 1);
    });

    moveActions.appendChild(upBtn);
    moveActions.appendChild(downBtn);

    const remove = document.createElement("button");
    remove.className = "remove";
    remove.textContent = "✕";
    remove.disabled = addBtn.disabled;

    remove.addEventListener("click", async (e) => {
      e.stopPropagation();

      const res = await fetch(`/api/file/${encodeURIComponent(file.id)}`, {
        method: "DELETE",
        headers: { "X-Scyzoryk-Request": "1" }
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        statusText.textContent = data.message || "Nie można usunąć pliku";
        return;
      }

      await loadQueue();
    });

    li.addEventListener("click", () => {
      document
        .querySelectorAll(".file-item")
        .forEach(x => x.classList.remove("is-selected"));

      li.classList.add("is-selected");

      if (file.ext === ".pdf") {
        showPdfPreview(file.url);
      } else {
        hidePdfPreview(file.originalName);
      }
    });

    li.addEventListener("dragstart", (e) => {
      if (addBtn.disabled) {
        e.preventDefault();
        statusText.textContent = "Trwa drukowanie. Poczekaj aż zakończy się wysyłanie plików do kolejki.";
        return;
      }

      draggedId = file.id;
      li.classList.add("dragging");
      updateAutoScroll(e.clientY || 0);
    });

    li.addEventListener("dragend", async () => {
      draggedId = null;
      stopAutoScroll();

      document.querySelectorAll(".file-item").forEach(x => {
        x.classList.remove("dragging");
        x.classList.remove("drop-before");
      });

      await saveOrder();
    });

    li.addEventListener("dragover", (e) => {
      e.preventDefault();
      updateAutoScroll(e.clientY);

      document
        .querySelectorAll(".file-item")
        .forEach(x => x.classList.remove("drop-before"));

      if (draggedId && draggedId !== file.id) {
        li.classList.add("drop-before");
      }
    });

    li.addEventListener("drop", (e) => {
      e.preventDefault();

      if (addBtn.disabled || !draggedId || draggedId === file.id) return;

      const from = queue.findIndex(x => x.id === draggedId);
      const to = queue.findIndex(x => x.id === file.id);

      if (from < 0 || to < 0) return;

      const [moved] = queue.splice(from, 1);
      queue.splice(to, 0, moved);

      render();
    });

    li.appendChild(handle);
    li.appendChild(name);
    li.appendChild(moveActions);
    li.appendChild(remove);
    fileList.appendChild(li);
  });

  updateJobSummary();
}

async function uploadFiles(files) {
  if (!files || !files.length) return;

  const currentStatus = await fetch("/api/status").then(r => r.json()).catch(() => ({}));
  if (currentStatus.printing) {
    statusText.textContent = "Trwa drukowanie. Poczekaj aż zakończy się wysyłanie plików do kolejki.";
    return;
  }

  const form = new FormData();

  for (const file of files) {
    const e = fileExt(file.name);

    if ([".pdf", ".doc", ".docx"].includes(e)) {
      form.append("files", file);
    }
  }

  if (!form.has("files")) return;

  statusText.textContent = "Wgrywanie plików...";

  const res = await fetch("/api/upload", {
    method: "POST",
    headers: { "X-Scyzoryk-Request": "1" },
    body: form
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    statusText.textContent = data.message || "Nie udało się dodać plików";
    return;
  }

  queue = data.queue || [];
  statusText.textContent = `Dodano plików: ${(data.added || []).length}`;

  render();
}

async function loadQueue() {
  const res = await fetch("/api/queue");
  const data = await res.json();

  queue = data.queue || [];
  render();
}

async function saveOrder() {
  await fetch("/api/reorder", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Scyzoryk-Request": "1"
    },
    body: JSON.stringify({
      order: queue.map(x => x.id)
    })
  });
}

async function pollStatus() {
  const res = await fetch("/api/status");
  const s = await res.json();

  statusText.textContent = s.warning ? `${s.message || "Gotowy"} (${s.warning})` : (s.message || "Gotowy");
  progressBar.style.width = `${s.percent || 0}%`;
  statusBox.classList.toggle("is-printing", !!s.printing);
  setPrintingUi(!!s.printing);

  if (!s.printing && s.done) {
    clearInterval(statusTimer);
    statusTimer = null;

    if (s.savedFolder) {
      statusText.textContent = "✅ Zapisano pliki PDF. Otwieram folder...";
      fetch("/api/open-saved-pdf-folder", { method: "POST", headers: { "X-Scyzoryk-Request": "1" } }).catch(() => {});
    }

    await loadQueue();
    hidePdfPreview();
    setPrintingUi(false);
  }

  if (!s.printing && s.error) {
    clearInterval(statusTimer);
    statusTimer = null;
    setPrintingUi(false);
  }
}

addBtn.addEventListener("click", () => {
  fileInput.click();
});

fileInput.addEventListener("change", async () => {
  await uploadFiles(fileInput.files);
  fileInput.value = "";
});

clearBtn.addEventListener("click", async () => {
  if (queue.length && !confirm(`Wyczyścić kolejkę (${queue.length} plików)?`)) return;
  const res = await fetch("/api/clear", {
    method: "POST",
    headers: { "X-Scyzoryk-Request": "1" }
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    statusText.textContent = data.message || "Nie można wyczyścić";
    return;
  }

  queue = [];
  fileInput.value = "";
  render();

  hidePdfPreview();
  progressBar.style.width = "0%";
  statusBox.classList.remove("is-printing");
  statusText.textContent = "Wyczyszczono";
  setPrintingUi(false);
});

printBtn.addEventListener("click", async () => {
  if (!queue.length) return;
  await saveOrder();

  const options = getPrintOptions();
  const confirmText = isSaveAsPdfMode()
    ? `Zapisać ${queue.length} plików jako PDF (bez drukowania)?`
    : `Wysłać do druku ${queue.length} plików, ${options.copies} kopii?`;
  if (!confirm(confirmText)) return;

  const res = await fetch("/api/print", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Scyzoryk-Request": "1"
    },
    body: JSON.stringify({
      order: queue.map(x => x.id),
      delaySeconds: options.delaySeconds,
      copies: options.copies,
      sideMode: options.sideMode,
      copyMode: options.copyMode,
      printerName: options.printerName,
      mergeFiles: options.mergeFiles
    })
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    statusText.textContent = data.message || "Błąd drukowania";
    setPrintingUi(false);
    return;
  }

  statusBox.classList.add("is-printing");
  setPrintingUi(true);

  if (statusTimer) {
    clearInterval(statusTimer);
  }

  statusTimer = setInterval(pollStatus, 800);
  pollStatus();
});

fileList.addEventListener("dragover", e => {
  if (!draggedId) return;
  e.preventDefault();
  updateAutoScroll(e.clientY);
});

fileList.addEventListener("dragleave", e => {
  if (!fileList.contains(e.relatedTarget)) stopAutoScroll();
});

dropZone.addEventListener("dragover", e => {
  e.preventDefault();
  dropZone.classList.add("drag-over");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("drag-over");
});

dropZone.addEventListener("drop", async e => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");

  if (addBtn.disabled) {
    statusText.textContent = "Trwa drukowanie. Poczekaj aż zakończy się wysyłanie plików do kolejki.";
    return;
  }

  await uploadFiles(e.dataTransfer.files);
});

[copiesInput, delayInput, sideModeInput, copyModeInput, mergeFilesInput].forEach(input => {
  input.addEventListener("input", updateJobSummary);
  input.addEventListener("change", updateJobSummary);
});

zoomFitBtn.addEventListener("click", () => {
  previewZoom = "page-width";
  refreshPreviewZoom();
});

zoomOutBtn.addEventListener("click", () => {
  if (previewZoom === "page-width") {
    setNumericZoom(100);
    return;
  }

  const currentIndex = zoomLevels.findIndex(x => x >= previewZoom);
  const nextIndex = currentIndex <= 0 ? 0 : currentIndex - 1;
  setNumericZoom(zoomLevels[nextIndex]);
});

zoomInBtn.addEventListener("click", () => {
  if (previewZoom === "page-width") {
    setNumericZoom(125);
    return;
  }

  const currentIndex = zoomLevels.findIndex(x => x > previewZoom);
  const nextZoom = currentIndex === -1 ? zoomLevels[zoomLevels.length - 1] : zoomLevels[currentIndex];
  setNumericZoom(nextZoom);
});

updateZoomLabel();
sideModeInput.value = sideModeInput.value || "two-sided";
if (!sideModeInput.value || sideModeInput.value === "one-sided") sideModeInput.value = "two-sided";
updateJobSummary();

loadQueue();

// Ten sam sentinel co server.js (SAVE_AS_PDF_SENTINEL) - nigdy nie trafia do
// prawdziwej listy drukarek, wiec dopisywany tu, po stronie klienta, zawsze
// (nawet gdy listPrinters() nie znajdzie zadnej fizycznej drukarki).
const SAVE_AS_PDF_OPTION = `<option value="__SAVE_AS_PDF__">💾 Zapisz jako PDF (bez drukowania)</option>`;

async function loadPrinters() {
  try {
    const res = await fetch("/api/printers", { headers: { "X-Scyzoryk-Request": "1" } });
    const data = await res.json();
    const printers = data.printers || [];
    if (printerSelectInput && printers.length) {
      printerSelectInput.innerHTML = printers.map(p => `<option value="${escapeHtml(p.name)}"${p.isDefault ? " selected" : ""}>${escapeHtml(p.name)}${p.isDefault ? " (domyślna)" : ""}</option>`).join("") + SAVE_AS_PDF_OPTION;
    } else if (printerSelectInput) {
      printerSelectInput.innerHTML += SAVE_AS_PDF_OPTION;
    }
  } catch (e) {
    if (printerSelectInput) printerSelectInput.innerHTML += SAVE_AS_PDF_OPTION;
  }
  updatePrintModeUi();
}
loadPrinters();

// Kopie/strony/tryb kopiowania nie maja znaczenia przy zapisie do PDF (nie ma
// fizycznej drukarki ani duplexu) - ukrywamy je, zeby nie sugerowac, ze
// cokolwiek robia w tym trybie. "Łącz sąsiadujące PDF-y" zostaje aktywne -
// dziala identycznie w obu trybach (patrz buildSaveAsPdfOutputs w server.js).
function isSaveAsPdfMode() {
  return !!printerSelectInput && printerSelectInput.value === "__SAVE_AS_PDF__";
}
function updatePrintModeUi() {
  const saveMode = isSaveAsPdfMode();
  [delayInput, copiesInput, sideModeInput, copyModeInput].forEach(input => {
    const field = input && input.closest(".option-field");
    if (field) field.hidden = saveMode;
  });
  printBtn.textContent = saveMode ? "Zapisz jako PDF" : "Drukuj";
  updateJobSummary();
}
if (printerSelectInput) printerSelectInput.addEventListener("change", updatePrintModeUi);
