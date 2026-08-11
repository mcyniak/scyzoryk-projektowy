(() => {
  const mainPanelUrl = 'http://scyzoryk.localhost:3000';
  document.querySelectorAll('[data-main-link]').forEach((link) => { link.href = mainPanelUrl; link.removeAttribute('target'); });
  document.querySelectorAll('[data-help-link]').forEach((link) => { link.href = `${mainPanelUrl}/instrukcja.html#${link.dataset.helpLink}`; });

  const form = document.getElementById('form');
  const dropZone = document.getElementById('dropZone');
  const filesInput = document.getElementById('files');
  const fileListEl = document.getElementById('fileList');
  const submitBtn = document.getElementById('submitBtn');
  const clearBtn = document.getElementById('clearBtn');
  const statusBox = document.getElementById('status');
  const statusText = document.getElementById('statusText');
  const progressBar = document.getElementById('progressBar');
  const errorBox = document.getElementById('errorBox');
  const reviewPanel = document.getElementById('reviewPanel');
  const reviewFilesEl = document.getElementById('reviewFiles');
  const confirmBtn = document.getElementById('confirmBtn');
  const cancelReviewBtn = document.getElementById('cancelReviewBtn');
  const fieldsPanel = document.getElementById('fieldsPanel');
  const fieldsIntro = document.getElementById('fieldsIntro');
  const fieldsQueueEl = document.getElementById('fieldsQueue');
  const fieldProgress = document.getElementById('fieldProgress');
  const fieldPreviewImg = document.getElementById('fieldPreviewImg');
  const fieldPreviewMissing = document.getElementById('fieldPreviewMissing');
  const fieldPreviewMissingBox = document.getElementById('fieldPreviewMissingBox');
  const fieldMarkBtn = document.getElementById('fieldMarkBtn');
  const fieldRemarkBtn = document.getElementById('fieldRemarkBtn');
  const fieldBackBtn = document.getElementById('fieldBackBtn');
  const fieldMarkBox = document.getElementById('fieldMarkBox');
  const markWrap = document.getElementById('markWrap');
  const markPageImg = document.getElementById('markPageImg');
  const markOverlay = document.getElementById('markOverlay');
  const markPrevPageBtn = document.getElementById('markPrevPageBtn');
  const markNextPageBtn = document.getElementById('markNextPageBtn');
  const markCancelBtn = document.getElementById('markCancelBtn');
  const markError = document.getElementById('markError');
  const fieldDocName = document.getElementById('fieldDocName');
  const fieldLabel = document.getElementById('fieldLabel');
  const fieldForm = document.getElementById('fieldForm');
  const fieldValueInput = document.getElementById('fieldValueInput');
  const fieldSkipBtn = document.getElementById('fieldSkipBtn');
  const excelStep = document.getElementById('excelStep');
  const excelPathInput = document.getElementById('excelPathInput');
  const familySelect = document.getElementById('familySelect');
  const familyChosenNote = document.getElementById('familyChosenNote');
  const templateSelect = document.getElementById('templateSelect');
  const finalizeBtn = document.getElementById('finalizeBtn');
  const saveTemplateBtn = document.getElementById('saveTemplateBtn');
  const saveTemplateNote = document.getElementById('saveTemplateNote');
  const resultsPanel = document.getElementById('resultsPanel');
  const resultList = document.getElementById('resultList');
  const excelResultNote = document.getElementById('excelResultNote');

  const ocrLockedPanel = document.getElementById('ocrLockedPanel');
  const ocrLockedTitle = document.getElementById('ocrLockedTitle');
  const ocrHeroSection = document.getElementById('ocrHeroSection');
  const ocrUploadPanel = document.getElementById('ocrUploadPanel');
  const ocrChangeKeyBtn = document.getElementById('ocrChangeKeyBtn');
  const ocrUnlockForm = document.getElementById('ocrUnlockForm');
  const ocrKeyFileInput = document.getElementById('ocrKeyFileInput');
  const ocrLocationInput = document.getElementById('ocrLocationInput');
  const ocrProcessorIdInput = document.getElementById('ocrProcessorIdInput');
  const ocrUnlockBtn = document.getElementById('ocrUnlockBtn');
  const ocrUnlockCancelBtn = document.getElementById('ocrUnlockCancelBtn');
  const ocrUnlockStatus = document.getElementById('ocrUnlockStatus');

  const EXCEL_PATH_STORAGE_KEY = 'ocr-audytow-excel-path';
  const FAMILY_STORAGE_KEY = 'ocr-audytow-family';
  excelPathInput.value = localStorage.getItem(EXCEL_PATH_STORAGE_KEY) || '';
  familySelect.value = localStorage.getItem(FAMILY_STORAGE_KEY) || '';

  const FAMILY_LABELS = { pc: 'Pompy ciepła', solary: 'Solary', kotly: 'Kotły' };
  let selectedFamily = familySelect.value;
  let selectedFiles = [];
  // Stan sesji analizy (miedzy /api/ocr/analyze a /api/ocr/finalize) - patrz
  // pamiec/CLAUDE.md: podzial na adresy NIGDY nie jest w pelni automatyczny,
  // uzytkownik zawsze przeglada i moze poprawic proponowane bloki tutaj.
  let analysisId = null;
  let analysisFiles = []; // [{ fileId, originalName, status, pageCount, avgConfidence, warnings, thumbnails, dividers:Set, labels:Map }]
  // Stan kroku 3 (uzupelnianie brakujacych/niepewnych pol - patrz
  // src/fieldExtraction.js) - fieldsFiles to odpowiedz z /api/ocr/extract-fields,
  // reviewQueue to plaska kolejka WSZYSTKICH pol z needsReview=true ze
  // wszystkich plikow/blokow naraz, zebranych w jedna sesje "wpisz -> Enter ->
  // nastepny brak" niezaleznie od tego z ktorego pliku pochodza.
  let fieldsFiles = [];
  let reviewQueue = [];
  let queuePos = 0;

  function renderFileList() {
    if (!selectedFiles.length) {
      fileListEl.hidden = true;
      fileListEl.innerHTML = '';
      return;
    }
    fileListEl.hidden = false;
    fileListEl.innerHTML = selectedFiles.map((file, i) => `
      <div class="file-row">
        <div class="grow"><div class="name">${escapeHtml(file.name)}</div></div>
        <button type="button" class="file-remove" data-index="${i}">Usuń</button>
      </div>
    `).join('');
    fileListEl.querySelectorAll('.file-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedFiles.splice(Number(btn.dataset.index), 1);
        renderFileList();
      });
    });
  }

  function addFiles(fileListLike) {
    for (const file of fileListLike) {
      if (!/\.pdf$/i.test(file.name)) continue;
      if (selectedFiles.some(f => f.name === file.name && f.size === file.size)) continue;
      selectedFiles.push(file);
    }
    renderFileList();
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function apiJson(url, options = {}) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) {
      const error = new Error(data?.message || `Błąd żądania (${response.status}).`);
      error.status = response.status;
      error.code = data?.code;
      error.data = data;
      throw error;
    }
    return data;
  }

  filesInput.addEventListener('change', () => { addFiles(filesInput.files); filesInput.value = ''; });

  ['dragenter', 'dragover'].forEach(evt => {
    dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
  });
  ['dragleave', 'drop'].forEach(evt => {
    dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.remove('dragover'); });
  });
  dropZone.addEventListener('drop', (e) => {
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  });

  function resetAll() {
    selectedFiles = [];
    analysisId = null;
    analysisFiles = [];
    fieldsFiles = [];
    reviewQueue = [];
    queuePos = 0;
    renderFileList();
    resultList.innerHTML = '';
    resultsPanel.hidden = true;
    reviewFilesEl.innerHTML = '';
    reviewPanel.hidden = true;
    fieldsPanel.hidden = true;
    fieldsQueueEl.hidden = false;
    excelStep.hidden = true;
    errorBox.innerHTML = '';
    statusBox.hidden = true;
  }

  clearBtn.addEventListener('click', resetAll);
  cancelReviewBtn.addEventListener('click', resetAll);

  function setStatus(text, percent) {
    statusBox.hidden = false;
    statusText.textContent = text;
    progressBar.style.width = `${percent}%`;
  }

  function statusBadge(status, avgConfidence) {
    if (status === 'skipped-already-has-text') return '<span class="badge skip">Pominięto - już ma tekst</span>';
    if (status === 'no-ocr-possible') return '<span class="badge unknown">Nie udało się rozpoznać</span>';
    if (avgConfidence !== null && avgConfidence !== undefined && avgConfidence < 70) return '<span class="badge warn">Niska pewność rozpoznania</span>';
    return '<span class="badge ok">Gotowe</span>';
  }

  // --- Krok 1: wysyłka do analizy ---------------------------------------

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!selectedFiles.length) {
      setStatus('Dodaj przynajmniej jeden plik PDF.', 0);
      return;
    }

    const formData = new FormData();
    for (const file of selectedFiles) formData.append('files', file, file.name);

    submitBtn.disabled = true;
    errorBox.innerHTML = '';
    resultList.innerHTML = '';
    resultsPanel.hidden = true;
    reviewPanel.hidden = true;
    setStatus('Wysyłanie plików...', 5);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/ocr/analyze');
    xhr.setRequestHeader('X-Scyzoryk-Request', '1');

    xhr.upload.addEventListener('progress', (e) => {
      if (!e.lengthComputable) return;
      const percent = Math.round((e.loaded / e.total) * 40);
      setStatus('Wysyłanie plików...', percent);
    });
    xhr.upload.addEventListener('load', () => {
      setStatus('Rozpoznawanie tekstu... To może potrwać kilka minut, zależnie od liczby stron.', 55);
    });

    xhr.onload = () => {
      submitBtn.disabled = false;
      let data;
      try { data = JSON.parse(xhr.responseText); } catch { data = null; }
      if (xhr.status >= 200 && xhr.status < 300 && data?.ok) {
        setStatus('Gotowe.', 100);
        statusBox.hidden = true;
        handleAnalyzeResponse(data);
      } else {
        statusBox.hidden = true;
        errorBox.innerHTML = `<div class="error-box">${escapeHtml(data?.message || 'Nie udało się przeanalizować plików.')}</div>`;
      }
    };
    xhr.onerror = () => {
      submitBtn.disabled = false;
      statusBox.hidden = true;
      errorBox.innerHTML = '<div class="error-box">Błąd połączenia z serwerem.</div>';
    };
    xhr.send(formData);
  });

  function handleAnalyzeResponse(data) {
    analysisId = data.analysisId;
    analysisFiles = [];
    const failed = [];

    for (const item of data.results) {
      if (!item.ok) { failed.push(item); continue; }
      const labels = new Map();
      const dividers = new Set();
      (item.blocks || []).forEach((b, i) => {
        if (b.startPage > 0) dividers.add(b.startPage);
        if ((item.blocks.length || 1) > 1) labels.set(b.startPage, `Adres ${i + 1}`);
      });
      analysisFiles.push({
        fileId: item.fileId,
        originalName: item.originalName,
        status: item.status,
        pageCount: item.pageCount,
        avgConfidence: item.avgConfidence,
        warnings: item.warnings || [],
        thumbnails: item.thumbnails || [],
        dividers,
        labels
      });
    }

    if (failed.length) {
      errorBox.innerHTML = failed.map(f => `<div class="error-box">${escapeHtml(f.originalName)}: ${escapeHtml(f.error)}</div>`).join('');
    }

    if (analysisFiles.length) {
      reviewPanel.hidden = false;
      renderReview();
      loadTemplateOptions();
    }
  }

  // Lista zapisanych wzorow gmin do RECZNEGO wyboru (2026-07-24 - wczesniej
  // dopasowanie po naglowku dzialo w 100% automatycznie/po cichu, bez zadnego
  // sposobu zeby zobaczyc co jest zapisane albo wymusic inny wzor niz automat
  // by wybral). Wczytywane na swiezo za kazdym razem (male repozytorium, koszt
  // pomijalny) - zeby wzor zapisany chwile wczesniej byl od razu widoczny.
  async function loadTemplateOptions() {
    templateSelect.innerHTML = '<option value="">— rozpoznaj automatycznie —</option>';
    try {
      const data = await apiJson('/api/ocr/templates');
      for (const tpl of data.templates || []) {
        const opt = document.createElement('option');
        opt.value = tpl.id;
        opt.textContent = tpl.label;
        templateSelect.appendChild(opt);
      }
    } catch (_) { /* brak wzorow - zostaje sama opcja automatyczna */ }
  }

  // --- Krok 2: przegląd/edycja podziału ----------------------------------

  function computeBlocks(f) {
    const starts = [0, ...[...f.dividers].sort((a, b) => a - b)];
    return starts.map((start, i) => ({
      startPage: start,
      endPage: i + 1 < starts.length ? starts[i + 1] - 1 : f.pageCount - 1
    }));
  }

  function renderReview() {
    reviewFilesEl.innerHTML = analysisFiles.map(renderReviewFile).join('');
  }

  function renderReviewFile(f) {
    const blocks = computeBlocks(f);
    const thumbByPage = new Map(f.thumbnails.map(t => [t.pageIndex, t]));
    const hasThumbs = f.thumbnails.some(t => t.available);

    let strip = '';
    if (hasThumbs && f.pageCount > 0) {
      const cells = [];
      for (let i = 0; i < f.pageCount; i++) {
        if (i > 0) {
          const active = f.dividers.has(i);
          cells.push(`<button type="button" class="split-btn ${active ? 'active' : ''}" data-file="${f.fileId}" data-page="${i}" title="${active ? 'Usuń podział przed tą stroną' : 'Podziel przed tą stroną'}">${active ? '✂' : '+'}</button>`);
        }
        const thumb = thumbByPage.get(i);
        cells.push(`<div class="thumb-cell">${thumb?.available ? `<img src="${thumb.url}" alt="Strona ${i + 1}" loading="lazy">` : '<div class="thumb-placeholder">brak podglądu</div>'}<span class="page-no">${i + 1}</span></div>`);
      }
      strip = `<div class="page-strip">${cells.join('')}</div>`;
    }

    const blockRows = blocks.map((b, i) => {
      const range = b.endPage > b.startPage ? `str. ${b.startPage + 1}–${b.endPage + 1}` : `str. ${b.startPage + 1}`;
      if (blocks.length === 1) {
        return `<div class="block-row"><span class="block-range">${range}</span><span class="block-single-note">jeden plik = jeden adres</span></div>`;
      }
      const label = f.labels.get(b.startPage) ?? `Adres ${i + 1}`;
      return `<div class="block-row">
        <span class="block-range">${range}</span>
        <input type="text" class="block-label" data-file="${f.fileId}" data-start="${b.startPage}" placeholder="Adres ${i + 1}" value="${escapeHtml(label)}">
      </div>`;
    }).join('');

    const meta = [];
    if (f.pageCount) meta.push(`${f.pageCount} stron`);
    if (f.avgConfidence !== null && f.avgConfidence !== undefined) meta.push(`pewność rozpoznania: ${Math.round(f.avgConfidence)}%`);

    const warnings = f.warnings.length ? `<ul class="warnings">${f.warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul>` : '';

    return `
      <div class="review-file">
        <div class="head">
          <span class="name">${escapeHtml(f.originalName)}</span>
          ${statusBadge(f.status, f.avgConfidence)}
        </div>
        ${meta.length ? `<div class="meta">${meta.join(' · ')}</div>` : ''}
        ${warnings}
        ${strip}
        <div class="block-list">${blockRows}</div>
      </div>
    `;
  }

  reviewFilesEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.split-btn');
    if (!btn) return;
    const f = analysisFiles.find(x => x.fileId === btn.dataset.file);
    if (!f) return;
    const page = Number(btn.dataset.page);
    if (f.dividers.has(page)) f.dividers.delete(page); else f.dividers.add(page);
    renderReview();
  });

  reviewFilesEl.addEventListener('input', (e) => {
    const input = e.target.closest('.block-label');
    if (!input) return;
    const f = analysisFiles.find(x => x.fileId === input.dataset.file);
    if (!f) return;
    f.labels.set(Number(input.dataset.start), input.value);
  });

  // --- Krok 3a: zatwierdzenie podziału -> wyciągnięcie pól formularza -----
  // (patrz src/fieldExtraction.js) - dopiero TERAZ, po ustaleniu ostatecznych
  // zakresów stron dla każdego adresu, ma sens szukać pól "w tym bloku".

  confirmBtn.addEventListener('click', async () => {
    if (!analysisId || !analysisFiles.length) return;
    confirmBtn.disabled = true;
    errorBox.innerHTML = '';
    setStatus('Sprawdzanie danych...', 70);

    selectedFamily = familySelect.value || '';
    if (selectedFamily) localStorage.setItem(FAMILY_STORAGE_KEY, selectedFamily);
    else localStorage.removeItem(FAMILY_STORAGE_KEY);

    const payload = {
      analysisId,
      family: selectedFamily || undefined,
      templateId: templateSelect.value || undefined,
      files: analysisFiles.map(f => ({
        fileId: f.fileId,
        blocks: computeBlocks(f).map(b => ({ ...b, label: f.labels.get(b.startPage) || '' }))
      }))
    };

    try {
      const data = await apiJson('/api/ocr/extract-fields', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Scyzoryk-Request': '1' },
        body: JSON.stringify(payload)
      });

      statusBox.hidden = true;
      const failed = (data.results || []).filter(r => !r.ok);
      if (failed.length) {
        errorBox.innerHTML = failed.map(f => `<div class="error-box">${escapeHtml(f.originalName)}: ${escapeHtml(f.error)}</div>`).join('');
      }
      fieldsFiles = (data.results || []).filter(r => r.ok);
      startFieldReview();
    } catch (err) {
      statusBox.hidden = true;
      errorBox.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
    } finally {
      confirmBtn.disabled = false;
    }
  });

  // --- Krok 3b: uzupełnianie brakujących/niepewnych pól -------------------

  // Wyodrebnione z startFieldReview (2026-07-23), zeby reuzyc PO recalibrate-remaining -
  // przebudowuje cala kolejke od zera z aktualnego stanu fieldsFiles (patrz
  // applyRecalibratedBlocks nizej).
  function buildReviewQueue() {
    const queue = [];
    for (const file of fieldsFiles) {
      for (const block of file.blocks) {
        for (const [fieldKey, field] of Object.entries(block.fields)) {
          if (field.needsReview) queue.push({ fileId: file.fileId, originalName: file.originalName, blockIndex: block.blockIndex, blockLabel: block.label, startPage: block.startPage, endPage: block.endPage, fieldKey, field });
        }
      }
    }
    annotateQueueBlocks(queue);
    return queue;
  }

  // Dolicza do kazdego elementu kolejki jego pozycje WZGLEDEM WLASNEGO adresu
  // (blockOrdinal/blockTotal/posInBlock/blockSize) - bez tego "Do uzupelnienia: 9 z 36"
  // nie mowilo nic o tym, ze to np. pole 9 z 9 OSTATNIEGO pola PIERWSZEGO z 4 adresow,
  // tylko wygladalo jak jeden plaski, nieprzerwany ciag. Bloki bez ani jednego pola do
  // sprawdzenia nie dostaja numeru - nikt ich i tak nigdy nie zobaczy w tej kolejce.
  function annotateQueueBlocks(queue) {
    const blockOrder = [];
    const blockSize = new Map();
    for (const item of queue) {
      const key = `${item.fileId}|${item.blockIndex}`;
      if (!blockSize.has(key)) { blockSize.set(key, 0); blockOrder.push(key); }
      blockSize.set(key, blockSize.get(key) + 1);
    }
    const blockOrdinal = new Map(blockOrder.map((key, idx) => [key, idx + 1]));
    const seenInBlock = new Map();
    for (const item of queue) {
      const key = `${item.fileId}|${item.blockIndex}`;
      const posInBlock = (seenInBlock.get(key) || 0) + 1;
      seenInBlock.set(key, posInBlock);
      item.blockOrdinal = blockOrdinal.get(key);
      item.blockTotal = blockOrder.length;
      item.posInBlock = posInBlock;
      item.blockSize = blockSize.get(key);
    }
  }

  function startFieldReview() {
    saveTemplateNote.hidden = true;
    const familyNote = selectedFamily
      ? `Zawężono do pól rodziny "${FAMILY_LABELS[selectedFamily] || selectedFamily}".`
      : 'Nie zawężono do konkretnej rodziny - wszystkie pola.';
    // Ktory zapisany wzor gminy faktycznie zostal uzyty (recznie wybrany albo automatycznie
    // dopasowany po naglowku) - 2026-07-24, wczesniej to dzialo w 100% po cichu, bez
    // zadnego potwierdzenia dla uzytkownika czy cos sie w ogole dopasowalo.
    const usedLabels = new Set();
    for (const file of fieldsFiles) {
      for (const block of file.blocks) {
        if (block.matchedTemplateLabel) usedLabels.add(block.matchedTemplateLabel);
      }
    }
    const templateNote = usedLabels.size
      ? `Użyty wzór: ${Array.from(usedLabels).join(', ')}.`
      : 'Nie dopasowano żadnego zapisanego wzoru - pełne rozpoznawanie.';
    familyChosenNote.textContent = `${familyNote} ${templateNote}`;
    reviewQueue = buildReviewQueue();
    queuePos = 0;
    reviewPanel.hidden = true;
    fieldsPanel.hidden = false;

    if (!reviewQueue.length) {
      fieldsIntro.textContent = 'Wszystkie pola zostały rozpoznane pewnie - nic do ręcznego uzupełnienia.';
      fieldsQueueEl.hidden = true;
      excelStep.hidden = false;
      return;
    }
    fieldsIntro.textContent = 'Program nie wszystko odczytał pewnie - dla każdego brakującego pola zobaczysz podgląd miejsca na skanie. Wpisz wartość i naciśnij Enter, żeby przejść dalej. Jeśli pole faktycznie jest puste w oryginale, kliknij "Brak w oryginale".';
    fieldsQueueEl.hidden = false;
    excelStep.hidden = true;
    renderCurrentField();
  }

  function renderCurrentField() {
    const item = reviewQueue[queuePos];
    fieldProgress.textContent = item.blockTotal > 1
      ? `Adres ${item.blockOrdinal} z ${item.blockTotal} — pole ${item.posInBlock} z ${item.blockSize} (łącznie ${queuePos + 1} z ${reviewQueue.length})`
      : `Do uzupełnienia: ${queuePos + 1} z ${reviewQueue.length}`;
    const nameLine = item.blockLabel ? `${item.originalName} — ${item.blockLabel}` : item.originalName;
    fieldDocName.textContent = nameLine;
    fieldLabel.textContent = item.field.columnLabel;
    fieldValueInput.value = item.field.value || '';
    fieldMarkBox.hidden = true;
    fieldBackBtn.disabled = queuePos === 0;
    if (item.field.previewUrl) {
      fieldPreviewImg.hidden = false;
      fieldPreviewImg.src = item.field.previewUrl;
      fieldPreviewMissingBox.hidden = true;
      fieldRemarkBtn.hidden = false;
    } else {
      fieldPreviewImg.hidden = true;
      fieldPreviewImg.removeAttribute('src');
      fieldPreviewMissingBox.hidden = false;
      fieldRemarkBtn.hidden = true;
    }
    setTimeout(() => { fieldValueInput.focus(); fieldValueInput.select(); }, 0);
  }

  // Cofniecie do poprzedniego pola w kolejce - BEZ zadania do serwera (samo
  // przewiniecie widoku) - jesli uzytkownik chce POPRAWIC wartosc, wpisze nowa i
  // nacisnie Enter jak zwykle (resolveCurrentField i tak nadpisze pole na serwerze
  // i przesunie sie znow do przodu). Naprawia realny przypadek zgloszony przez
  // wlasciciela: przypadkowy Enter bez wpisania wartosci (traktowany jak puste
  // pole) nie mial dotad ZADNEGO sposobu na cofniecie i poprawienie.
  fieldBackBtn.addEventListener('click', () => {
    if (queuePos === 0) return;
    queuePos -= 1;
    renderCurrentField();
  });

  // --- Reczne zaznaczanie pola na skanie, gdy automatyczna lokalizacja zawiedzie ---

  let markPageIndex = null;
  let markDragStart = null;

  function openMarkBox(item, pageIndex) {
    markError.hidden = true;
    markPageIndex = pageIndex;
    fieldMarkBox.hidden = false;
    markPageImg.src = `/api/analysis/${analysisId}/files/${item.fileId}/page/${pageIndex}`;
    const startPage = item.startPage ?? pageIndex;
    const endPage = item.endPage ?? pageIndex;
    markPrevPageBtn.disabled = markPageIndex <= startPage;
    markNextPageBtn.disabled = markPageIndex >= endPage;
  }

  fieldMarkBtn.addEventListener('click', () => {
    const item = reviewQueue[queuePos];
    openMarkBox(item, item.field.pageIndex ?? item.startPage ?? 0);
  });

  // Ten sam mechanizm co fieldMarkBtn, ale dostepny TEZ gdy pole juz MA podglad
  // (automatyczny albo wczesniej reczny) - pozwala poprawic zle zaznaczenie zamiast
  // utknac z bledna lokalizacja bez mozliwosci korekty.
  fieldRemarkBtn.addEventListener('click', () => {
    const item = reviewQueue[queuePos];
    openMarkBox(item, item.field.pageIndex ?? item.startPage ?? 0);
  });

  markPrevPageBtn.addEventListener('click', () => {
    const item = reviewQueue[queuePos];
    if (markPageIndex > (item.startPage ?? markPageIndex)) openMarkBox(item, markPageIndex - 1);
  });
  markNextPageBtn.addEventListener('click', () => {
    const item = reviewQueue[queuePos];
    if (markPageIndex < (item.endPage ?? markPageIndex)) openMarkBox(item, markPageIndex + 1);
  });
  markCancelBtn.addEventListener('click', () => { fieldMarkBox.hidden = true; });

  markWrap.addEventListener('pointerdown', (e) => {
    const rect = markWrap.getBoundingClientRect();
    markDragStart = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    markOverlay.style.display = 'block';
    markOverlay.style.left = `${markDragStart.x}px`;
    markOverlay.style.top = `${markDragStart.y}px`;
    markOverlay.style.width = '0px';
    markOverlay.style.height = '0px';
    markWrap.setPointerCapture(e.pointerId);
  });

  markWrap.addEventListener('pointermove', (e) => {
    if (!markDragStart) return;
    const rect = markWrap.getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX - rect.left, 0), rect.width);
    const y = Math.min(Math.max(e.clientY - rect.top, 0), rect.height);
    const left = Math.min(x, markDragStart.x);
    const top = Math.min(y, markDragStart.y);
    markOverlay.style.left = `${left}px`;
    markOverlay.style.top = `${top}px`;
    markOverlay.style.width = `${Math.abs(x - markDragStart.x)}px`;
    markOverlay.style.height = `${Math.abs(y - markDragStart.y)}px`;
  });

  markWrap.addEventListener('pointerup', async (e) => {
    if (!markDragStart) return;
    const rect = markWrap.getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX - rect.left, 0), rect.width);
    const y = Math.min(Math.max(e.clientY - rect.top, 0), rect.height);
    const dispLeft = Math.min(x, markDragStart.x);
    const dispTop = Math.min(y, markDragStart.y);
    const dispW = Math.abs(x - markDragStart.x);
    const dispH = Math.abs(y - markDragStart.y);
    markDragStart = null;
    markOverlay.style.display = 'none';
    if (dispW < 8 || dispH < 8) return; // zbyt maly prostokat - prawdopodobnie przypadkowe klikniecie

    const scaleX = markPageImg.naturalWidth / markPageImg.clientWidth;
    const scaleY = markPageImg.naturalHeight / markPageImg.clientHeight;
    const region = {
      minX: Math.round(dispLeft * scaleX),
      minY: Math.round(dispTop * scaleY),
      maxX: Math.round((dispLeft + dispW) * scaleX),
      maxY: Math.round((dispTop + dispH) * scaleY)
    };

    const item = reviewQueue[queuePos];
    try {
      const data = await apiJson('/api/ocr/mark-field-region', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Scyzoryk-Request': '1' },
        body: JSON.stringify({ analysisId, fileId: item.fileId, blockIndex: item.blockIndex, fieldKey: item.fieldKey, pageIndex: markPageIndex, region })
      });
      item.field.previewUrl = data.previewUrl;
      item.field.pageIndex = markPageIndex;
      renderCurrentField();
    } catch (err) {
      markError.hidden = false;
      markError.textContent = `Nie udało się zapisać zaznaczenia: ${err.message}`;
    }
  });

  // Chroni przed wyscigiem (race condition) zlapanym na zywym pliku 2026-07-23: nic nie
  // blokowalo formularza podczas trwania zadania (zwlaszcza dlugiej rekalibracji z prawdziwym
  // wywolaniem Document AI w tle) - szybkie kolejne Enter/klikniecie odpalalo DRUGIE,
  // nakladajace sie resolveCurrentField na tym samym (jeszcze nie-przesunietym) queuePos,
  // co konczylo sie 404 z /api/ocr/resolve-field (pole juz nie istnialo pod starym indeksem
  // po przebudowaniu kolejki). isProcessingField ignoruje kazde nadmiarowe wywolanie zamiast
  // pozwalac mu wystartowac.
  let isProcessingField = false;

  function setFormBusy(busy) {
    fieldValueInput.disabled = busy;
    fieldSkipBtn.disabled = busy;
    fieldMarkBtn.disabled = busy;
    fieldRemarkBtn.disabled = busy;
    const submitBtn = fieldForm.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = busy;
    // Odwrotne (false) NIE ustawia fieldBackBtn na wlaczony - o to dba juz renderCurrentField()
    // z poprawnym stanem dla NOWEJ pozycji w kolejce (moze byc to znow poczatek kolejki po
    // rekalibracji, gdzie "Poprzednie pole" powinno zostac wylaczone).
    if (busy) fieldBackBtn.disabled = true;
  }

  async function resolveCurrentField(value) {
    if (isProcessingField) return;
    isProcessingField = true;
    setFormBusy(true);
    try {
      const item = reviewQueue[queuePos];
      const trimmed = typeof value === 'string' ? value.trim().slice(0, 300) : '';
      await apiJson('/api/ocr/resolve-field', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Scyzoryk-Request': '1' },
        body: JSON.stringify({ analysisId, fileId: item.fileId, blockIndex: item.blockIndex, fieldKey: item.fieldKey, value })
      });
      // Stan lokalny zmieniamy dopiero po potwierdzonym zapisie na serwerze.
      item.field.value = trimmed;
      item.field.needsReview = false;
      item.field.resolved = true;
      queuePos += 1;

      // Czy WLASNIE przeszlismy z jednego bloku (adresu) do innego? Jesli tak - wykorzystaj
      // blok, ktory wlasnie skonczylismy sprawdzac, jako wzor dla WSZYSTKICH pozostalych,
      // JESZCZE NIE DOTKNIETYCH blokow tej paczki (patrz plan z 2026-07-23: "wykorzystaj
      // jeden sprawdzony adres jako wzor dla pozostalych"; server.js's recalibrate-remaining
      // sam pilnuje, zeby nie nadpisac bloku, ktory uzytkownik juz zaczal przegladac).
      //
      // Realny problem zlapany 2026-07-24: wczesniej to odpalalo sie TYLKO RAZ, po pierwszym
      // bloku - jesli akurat W TYM pierwszym adresie jakies pole nie dalo sie zlokalizowac
      // (harvestTemplateFields pomija pola bez bboxa - patrz templateEngine.js), to pole
      // NIGDY nie trafialo do wzoru, wiec uzytkownik musial je recznie zaznaczac/wpisywac w
      // KAZDYM kolejnym adresie z osobna. Odpalanie tego PO KAZDYM bloku (nie tylko
      // pierwszym) pozwala nadgonic kalibracje z KOLEJNEGO adresu, jesli akurat udalo sie w
      // nim to, co nie udalo sie w poprzednim.
      const nextItem = reviewQueue[queuePos];
      const crossedIntoNewBlock = nextItem &&
        (nextItem.fileId !== item.fileId || nextItem.blockIndex !== item.blockIndex);
      if (crossedIntoNewBlock) {
        await maybeRecalibrateFromBlock(item);
      }

      if (queuePos < reviewQueue.length) {
        renderCurrentField();
      } else {
        fieldsQueueEl.hidden = true;
        excelStep.hidden = false;
      }
    } catch (err) {
      errorBox.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
    } finally {
      isProcessingField = false;
      setFormBusy(false);
    }
  }

  // Buduje w pamieci wzor z JUZ w calosci sprawdzonego bloku `sourceItem` i stosuje go do
  // WSZYSTKICH pozostalych blokow tej paczki (server.js's /api/ocr/recalibrate-remaining) -
  // best-effort: w razie bledu kolejka po prostu zostaje taka, jaka byla (bez pogorszenia).
  async function maybeRecalibrateFromBlock(sourceItem) {
    setStatus('Wykorzystuję sprawdzony adres jako wzór dla pozostałych...', 80);
    try {
      const data = await apiJson('/api/ocr/recalibrate-remaining', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Scyzoryk-Request': '1' },
        body: JSON.stringify({ analysisId, sourceFileId: sourceItem.fileId, sourceBlockIndex: sourceItem.blockIndex, family: selectedFamily || undefined })
      });
      if (data.updatedBlocks?.length) applyRecalibratedBlocks(data.updatedBlocks);
    } catch (err) {
      errorBox.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
    }
    statusBox.hidden = true;
  }

  // Podmienia fields tych blokow w fieldsFiles, ktore recalibrate-remaining zdazyl przeliczyc,
  // i przebudowuje kolejke OD ZERA z nowego stanu - blok zrodlowy (juz w calosci sprawdzony)
  // nie ma juz needsReview pol, wiec naturalnie wypada z nowej kolejki; queuePos=0 w NOWEJ
  // kolejce odpowiada dokladnie "pierwszy jeszcze niesprawdzony element", czyli tam gdzie
  // uzytkownik i tak wlasnie jest.
  function applyRecalibratedBlocks(updatedBlocks) {
    const byKey = new Map(updatedBlocks.map((u) => [`${u.fileId}|${u.blockIndex}`, u.fields]));
    for (const file of fieldsFiles) {
      for (const block of file.blocks) {
        const newFields = byKey.get(`${file.fileId}|${block.blockIndex}`);
        if (newFields) block.fields = newFields;
      }
    }
    reviewQueue = buildReviewQueue();
    queuePos = 0;
  }

  fieldForm.addEventListener('submit', (e) => {
    e.preventDefault();
    resolveCurrentField(fieldValueInput.value);
  });
  fieldSkipBtn.addEventListener('click', () => resolveCurrentField(''));

  // Kalibracja "wzoru gminy" (patrz src/templateEngine.js) - harvestuje polozenia pol z
  // pierwszego pliku/bloku tej sesji (zrecenzowanego przez czlowieka) do biblioteki wzorow,
  // zeby kolejne adresy tej samej gminy lecialy szybsza sciezka. Etykieta sluzy jednoczesnie
  // do rozpoznawania naglowka - musi byc charakterystycznym fragmentem (np. nazwa gminy).
  saveTemplateBtn.addEventListener('click', async () => {
    const file = fieldsFiles[0];
    const block = file?.blocks?.[0];
    if (!file || !block) return;
    const label = window.prompt('Podaj nazwę gminy tak, jak pojawia się w nagłówku protokołu (np. "Kazimierz Biskupi"):', '');
    if (!label || !label.trim()) return;
    saveTemplateBtn.disabled = true;
    saveTemplateNote.hidden = true;
    try {
      const data = await apiJson('/api/ocr/save-template', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Scyzoryk-Request': '1' },
        body: JSON.stringify({ analysisId, fileId: file.fileId, blockIndex: block.blockIndex, label: label.trim() })
      });
      saveTemplateNote.hidden = false;
      saveTemplateNote.textContent = `Zapisano wzór (${data.textFieldsCount} pól tekstowych, ${data.groupFieldsCount} grup checkboxów) - kolejne adresy tej gminy skorzystają z niego automatycznie.`;
    } catch (err) {
      saveTemplateNote.hidden = false;
      saveTemplateNote.textContent = `Nie udało się zapisać wzoru: ${err.message}.`;
    } finally {
      saveTemplateBtn.disabled = false;
    }
  });

  // --- Krok 3c: ścieżka do Excela + finalizacja ---------------------------

  finalizeBtn.addEventListener('click', async () => {
    if (!analysisId) return;
    finalizeBtn.disabled = true;
    errorBox.innerHTML = '';
    setStatus('Zapisywanie plików...', 90);

    const excelPath = excelPathInput.value.trim();
    if (excelPath) localStorage.setItem(EXCEL_PATH_STORAGE_KEY, excelPath);
    else localStorage.removeItem(EXCEL_PATH_STORAGE_KEY);

    const payload = {
      analysisId,
      files: fieldsFiles.map(f => ({ fileId: f.fileId })),
      excelPath: excelPath || undefined,
      family: selectedFamily || undefined
    };

    try {
      let data;
      try {
        data = await apiJson('/api/ocr/finalize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Scyzoryk-Request': '1' },
          body: JSON.stringify(payload)
        });
      } catch (err) {
        if (err.code !== 'EXCEL_ALREADY_EXISTS') throw err;
        const choice = window.prompt(
          'Plik Excel już istnieje.\n\nWpisz 1 — wybierz inną nazwę\nWpisz 2 — nadpisz i zachowaj kopię zapasową\nWpisz 3 — anuluj',
          '1'
        );
        if (choice === '1') {
          statusBox.hidden = true;
          excelPathInput.focus();
          excelPathInput.select();
          return;
        }
        if (choice !== '2') {
          statusBox.hidden = true;
          return;
        }
        data = await apiJson('/api/ocr/finalize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Scyzoryk-Request': '1' },
          body: JSON.stringify({ ...payload, overwriteConfirmed: true })
        });
      }

      setStatus('Gotowe.', 100);
      statusBox.hidden = true;
      // fieldsPanel (w tym przycisk "Zapisz uklad jako wzor") NIE jest ukrywany po
      // finalizacji - dane sesji analizy dalej zyja po stronie serwera (finalize ich
      // nie usuwa), a wlasciciel chce moc zapisac wzor gminy PO pobraniu gotowego pliku,
      // nie tylko przed (user report 2026-07-23: "zapisałem do excela i chciałem jeszcze
      // to dac jako wzor a tu chuj i juz nie moge" - przycisk znikal razem z panelem).
      resultsPanel.hidden = false;
      renderResults(data.results);

      // Kazde "Zapisz i pobierz" tworzy TERAZ zawsze nowy plik Excela (nadpisujac,
      // jesli juz istnieje pod ta sciezka) z jednym wierszem na kazdy adres z TEJ
      // paczki - nie dopisuje juz do ewentualnego starego pliku (2026-07-23, patrz
      // excelExport.js). Jeden zbiorczy komunikat zamiast "dopisano wiersz" per plik.
      if (data.excelPath) {
        excelResultNote.hidden = false;
        excelResultNote.textContent = data.excelError
          ? `Pliki PDF zapisane, ale nie udało się zapisać Excela: ${data.excelError}`
          : `Zapisano nowy plik Excela (${data.excelRowCount} ${data.excelRowCount === 1 ? 'adres' : 'adresów'}): ${data.excelPath}${data.excelBackupPath ? ` (kopia poprzedniego pliku: ${data.excelBackupPath})` : ''}`;
      } else {
        excelResultNote.hidden = true;
      }
    } catch (err) {
      statusBox.hidden = true;
      errorBox.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
    } finally {
      finalizeBtn.disabled = false;
    }
  });

  function renderResults(results) {
    resultList.innerHTML = results.map(item => {
      const meta = [];
      if (item.pageCount) meta.push(`${item.pageCount} stron`);
      if (item.pageRange) meta.push(`str. ${item.pageRange[0]}–${item.pageRange[1]} oryginału`);
      if (item.avgConfidence !== null && item.avgConfidence !== undefined) meta.push(`pewność rozpoznania: ${Math.round(item.avgConfidence)}%`);
      if (item.excelRow) meta.push('w pliku Excela');
      const warnings = (item.warnings || []).length
        ? `<ul class="warnings">${item.warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`
        : '';
      const errorLine = item.ok ? '' : `<div class="warnings">${escapeHtml(item.error)}</div>`;
      const downloadLink = item.ok ? `<a class="button-link" href="${item.url}" download>Pobierz PDF</a>` : '';
      const displayName = item.label ? `${item.originalName} — ${item.label}` : item.originalName;
      return `
        <div class="result-item ${item.ok ? '' : 'err'}">
          <div class="head">
            <span class="name">${escapeHtml(displayName)}</span>
            ${item.ok ? statusBadge(item.status, item.avgConfidence) : '<span class="badge unknown">Błąd</span>'}
          </div>
          ${meta.length ? `<div class="meta">${meta.join(' · ')}</div>` : ''}
          ${warnings}
          ${errorLine}
          ${downloadLink ? `<div style="margin-top:10px">${downloadLink}</div>` : ''}
        </div>
      `;
    }).join('');
  }

  // Audyt rozdz. 22 (dystrybucja sekretu OCR): zamiast wypiekac klucz w
  // instalatorze (co wymagaloby prywatnego repo i psulo publiczne
  // aktualizacje), uzytkownik wgrywa klucz recznie RAZ na tym komputerze -
  // ekran ponizej pokazuje sie zamiast normalnego formularza, dopoki
  // /api/health zglasza ocrConfigured:false. "Zmień klucz OCR" w naglowku
  // pozwala otworzyc ten sam formularz TAKZE gdy OCR juz dziala (np. zmiana
  // na inne konto Google/platnika) - nowy klucz nadpisuje poprzedni.
  let ocrIsConfigured = false;

  function setOcrLocked(locked) {
    ocrLockedPanel.hidden = !locked;
    ocrHeroSection.hidden = locked;
    ocrUploadPanel.hidden = locked;
    // Anuluj ma sens tylko gdy OCR juz dziala (recznie otwarta zmiana klucza)
    // - przy faktycznym braku konfiguracji nie ma "normalnego" stanu, do
    // ktorego dałoby się wrocic.
    ocrUnlockCancelBtn.hidden = !locked || !ocrIsConfigured;
    ocrLockedTitle.textContent = ocrIsConfigured
      ? '🔑 Zmień klucz OCR'
      : '🔒 OCR nie jest jeszcze skonfigurowany na tym komputerze';
  }

  async function checkOcrConfigured() {
    try {
      const res = await fetch('/api/health');
      const data = await res.json().catch(() => null);
      ocrIsConfigured = Boolean(data?.ok) && data.ocrConfigured === true;
      ocrChangeKeyBtn.hidden = !ocrIsConfigured;
      if (!ocrIsConfigured) setOcrLocked(true);
    } catch {
      // Brak odpowiedzi z wlasnego /api/health to problem innej natury
      // (np. serwer wlasnie startuje) - nie chowamy normalnego UI z tego
      // powodu, zwykle sciezki uzycia i tak zglosza swoj wlasny blad.
    }
  }
  checkOcrConfigured();

  ocrChangeKeyBtn.addEventListener('click', () => {
    ocrUnlockStatus.className = '';
    ocrUnlockStatus.textContent = '';
    setOcrLocked(true);
  });

  ocrUnlockCancelBtn.addEventListener('click', () => {
    ocrUnlockForm.reset();
    ocrUnlockStatus.className = '';
    ocrUnlockStatus.textContent = '';
    setOcrLocked(false);
  });

  ocrUnlockForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = ocrKeyFileInput.files[0];
    if (!file) return;

    ocrUnlockBtn.disabled = true;
    ocrUnlockStatus.className = '';
    ocrUnlockStatus.textContent = 'Zapisuję...';
    try {
      const formData = new FormData();
      formData.append('keyFile', file);
      formData.append('location', ocrLocationInput.value.trim());
      formData.append('processorId', ocrProcessorIdInput.value.trim());
      const res = await fetch('/api/ocr/setup-credentials', {
        method: 'POST',
        headers: { 'X-Scyzoryk-Request': '1' },
        body: formData
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) throw new Error(data?.message || 'Nie udało się zapisać konfiguracji OCR.');

      ocrUnlockStatus.className = 'ok';
      ocrUnlockStatus.textContent = `Gotowe. Zapisano konfigurację (projekt: ${data.projectId}). Odblokowuję...`;
      ocrIsConfigured = true;
      ocrChangeKeyBtn.hidden = false;
      setOcrLocked(false);
      ocrUnlockForm.reset();
    } catch (err) {
      ocrUnlockStatus.className = 'err';
      ocrUnlockStatus.textContent = err.message || 'Nie udało się zapisać konfiguracji OCR.';
    } finally {
      ocrUnlockBtn.disabled = false;
    }
  });
})();
