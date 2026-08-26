(() => {
  const mainPanelHost = location.hostname === 'scyzoryk.localhost' ? 'scyzoryk.localhost' : '127.0.0.1';
  const mainPanelUrl = `http://${mainPanelHost}:3000`;
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
  const fieldsBlocksEl = document.getElementById('fieldsBlocks');
  const excelStep = document.getElementById('excelStep');
  const excelPathInput = document.getElementById('excelPathInput');
  const familySelect = document.getElementById('familySelect');
  const familyChosenNote = document.getElementById('familyChosenNote');
  const finalizeBtn = document.getElementById('finalizeBtn');
  const resultsPanel = document.getElementById('resultsPanel');
  const resultList = document.getElementById('resultList');
  const excelResultNote = document.getElementById('excelResultNote');

  const tablePanel = document.getElementById('tablePanel');
  const tableFamilySelect = document.getElementById('tableFamilySelect');
  const tableExcelPathInput = document.getElementById('tableExcelPathInput');
  const inspectTableBtn = document.getElementById('inspectTableBtn');
  const skipTableBtn = document.getElementById('skipTableBtn');
  const tableError = document.getElementById('tableError');
  const tableChecklistWrap = document.getElementById('tableChecklistWrap');
  const tableChecklistIntro = document.getElementById('tableChecklistIntro');
  const tableChecklistEl = document.getElementById('tableChecklist');
  const tableUnrecognizedNote = document.getElementById('tableUnrecognizedNote');
  const tableContinueBtn = document.getElementById('tableContinueBtn');
  const browseTableFileBtn = document.getElementById('browseTableFileBtn');
  const tableFileBrowseModal = document.getElementById('tableFileBrowseModal');
  const tableFileBrowseList = document.getElementById('tableFileBrowseList');
  const tableFileBrowseCurrentPath = document.getElementById('tableFileBrowseCurrentPath');
  const tableFileBrowseClose = document.getElementById('tableFileBrowseClose');
  const tableFileBrowseCancel = document.getElementById('tableFileBrowseCancel');
  const familySelectField = document.getElementById('familySelectField');
  const excelPathField = document.getElementById('excelPathField');
  const excelStepHint = document.getElementById('excelStepHint');

  const ocrLockedPanel = document.getElementById('ocrLockedPanel');
  const ocrLockedTitle = document.getElementById('ocrLockedTitle');
  const ocrHeroSection = document.getElementById('ocrHeroSection');
  const ocrUploadPanel = document.getElementById('ocrUploadPanel');
  const ocrChangeKeyBtn = document.getElementById('ocrChangeKeyBtn');
  const ocrActiveProviderNote = document.getElementById('ocrActiveProviderNote');
  const ocrUnlockForm = document.getElementById('ocrUnlockForm');
  const ocrApiKeyInput = document.getElementById('ocrApiKeyInput');
  const ocrApiKeyField = document.getElementById('ocrApiKeyField');
  const ocrApiKeyLabel = document.getElementById('ocrApiKeyLabel');
  const ocrManualHint = document.getElementById('ocrManualHint');
  const ocrProviderGemini = document.getElementById('ocrProviderGemini');
  const ocrProviderOpenai = document.getElementById('ocrProviderOpenai');
  const ocrProviderManual = document.getElementById('ocrProviderManual');
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
  // CLAUDE.md: podzial na adresy NIGDY nie jest w pelni automatyczny,
  // uzytkownik zawsze przeglada i moze poprawic proponowane bloki tutaj.
  let analysisId = null;
  let analysisFiles = []; // [{ fileId, originalName, pageCount, warnings, thumbnails, dividers:Set, labels:Map }]
  // Stan kroku 3 (uzupelnianie niepewnych pol) - odpowiedz z /api/ocr/extract-fields.
  let fieldsFiles = [];

  // --- Krok 0 (opcjonalny): wgraj gotowa tabele adresowa, zamiast zawsze
  // ciagnac pelny zestaw pol - patrz POST /api/ocr/inspect-table. Dopasowanie
  // wiersz-audyt <-> wiersz-tabeli idzie po numerze LP (etykieta bloku w
  // kroku 2 pelni ta role, gdy ten tryb jest aktywny - patrz renderReviewFile).
  let tableMode = false;
  let tableExcelPath = '';
  let tableFamily = '';
  let selectedFieldKeys = new Set();
  // Czy uzytkownik juz przeszedl krok 0 (kliknal "Sprawdz tabele"->"Dalej" albo
  // "Pomiń") - decyduje, ktory panel wraca po odblokowaniu ekranu klucza API.
  let pastTableStep = false;

  function guessLpFromFilename(name) {
    const base = String(name || '').replace(/\.pdf$/i, '');
    const match = base.match(/^\s*(\d+)/);
    return match ? match[1] : '';
  }

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
    renderFileList();
    resultList.innerHTML = '';
    resultsPanel.hidden = true;
    reviewFilesEl.innerHTML = '';
    reviewPanel.hidden = true;
    fieldsPanel.hidden = true;
    fieldsBlocksEl.innerHTML = '';
    excelStep.hidden = true;
    errorBox.innerHTML = '';
    statusBox.hidden = true;
  }

  clearBtn.addEventListener('click', resetAll);
  cancelReviewBtn.addEventListener('click', resetAll);

  function setStatus(text, percent) {
    statusBox.hidden = false;
    statusText.textContent = text;
    // components.css ukrywa .progress, dopoki #statusBox (.status-box) nie ma
    // klasy .is-printing - bez tego pasek postepu bylby trwale niewidoczny.
    statusBox.classList.add('is-printing');
    progressBar.style.width = `${percent}%`;
  }

  // --- Krok 0 (opcjonalny): wgraj gotowa tabele ---------------------------

  function renderTableChecklist(fields) {
    tableChecklistEl.innerHTML = fields.map((f) => {
      const checked = f.missingCount > 0;
      const countClass = f.missingCount > 0 ? '' : 'none';
      const countText = f.missingCount > 0
        ? `brakuje w ${f.missingCount}/${f.totalRows}`
        : 'kompletne';
      return `<div class="field-checklist-row">
        <label><input type="checkbox" data-key="${escapeHtml(f.fieldKey)}" ${checked ? 'checked' : ''}> ${escapeHtml(f.label)}</label>
        <span class="missing-count ${countClass}">${countText}</span>
      </div>`;
    }).join('');
  }

  inspectTableBtn.addEventListener('click', async () => {
    tableError.innerHTML = '';
    const excelPath = tableExcelPathInput.value.trim();
    const family = tableFamilySelect.value;
    if (!excelPath) { tableError.innerHTML = '<div class="error-box">Podaj ścieżkę do pliku Excel.</div>'; return; }

    inspectTableBtn.disabled = true;
    try {
      const data = await apiJson('/api/ocr/inspect-table', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Scyzoryk-Request': '1' },
        body: JSON.stringify({ excelPath, family })
      });
      tableChecklistIntro.textContent = `Znaleziono ${data.rowCount} ${data.rowCount === 1 ? 'wiersz' : 'wierszy'} w tabeli. Odznacz pola, których nie chcesz teraz szukać - zaznaczone domyślnie to te, których gdzieś brakuje.`;
      renderTableChecklist(data.fields);
      tableUnrecognizedNote.textContent = data.unrecognizedHeaders.length
        ? `Nierozpoznane nagłówki (pominięte, nigdy nie zgadywane): ${data.unrecognizedHeaders.join(', ')}`
        : '';
      tableChecklistWrap.hidden = false;
      tableExcelPath = excelPath;
      tableFamily = family;
    } catch (err) {
      tableChecklistWrap.hidden = true;
      tableError.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
    } finally {
      inspectTableBtn.disabled = false;
    }
  });

  tableContinueBtn.addEventListener('click', () => {
    selectedFieldKeys = new Set(
      [...tableChecklistEl.querySelectorAll('input[type=checkbox]:checked')].map((el) => el.dataset.key)
    );
    tableMode = true;
    pastTableStep = true;
    tablePanel.hidden = true;
    ocrUploadPanel.hidden = false;
    familySelectField.hidden = true;
  });

  skipTableBtn.addEventListener('click', () => {
    tableMode = false;
    pastTableStep = true;
    tablePanel.hidden = true;
    ocrUploadPanel.hidden = false;
  });

  // Przegladarka pliku .xlsx w stronie (zamiast recznego wpisywania sciezki) -
  // ten sam wzorzec co lib/folderBrowse.js w innych apkach (karty katalogowe
  // itp.), rozszerzony o klikanie plikow .xlsx (nie tylko nawigacje po
  // folderach) - patrz GET /api/browse-folder w server.js.
  function closeTableFileBrowser() {
    tableFileBrowseModal.classList.remove('open');
  }

  async function openTableFileBrowser(startPath) {
    tableFileBrowseModal.classList.add('open');
    await loadTableFileBrowse(startPath);
  }

  async function loadTableFileBrowse(targetPath) {
    tableFileBrowseList.innerHTML = '<div class="folder-row">Wczytuję...</div>';
    try {
      const url = targetPath ? `/api/browse-folder?path=${encodeURIComponent(targetPath)}` : '/api/browse-folder';
      const res = await fetch(url);
      const json = await res.json().catch(() => null);
      if (!json || !json.ok) {
        tableFileBrowseList.innerHTML = `<div class="folder-row">${escapeHtml((json && json.error) || 'Nie udało się wczytać folderów.')}</div>`;
        return;
      }
      tableFileBrowseCurrentPath.textContent = json.path || 'Wybierz dysk';

      const rows = [];
      if (json.path !== null) {
        const isDriveRoot = json.parent === null;
        const upTarget = isDriveRoot ? '' : json.parent;
        rows.push(`<div class="folder-row clickable up-nav" data-path="${escapeHtml(upTarget)}">${isDriveRoot ? '⬆ Lista dysków' : '⬆ ..'}</div>`);
      }
      for (const entry of json.entries) {
        if (entry.isFile) {
          rows.push(`<div class="folder-row clickable file-row" data-file-path="${escapeHtml(entry.path)}">📄 ${escapeHtml(entry.name)}</div>`);
        } else {
          rows.push(`<div class="folder-row clickable" data-path="${escapeHtml(entry.path)}">📁 ${escapeHtml(entry.name)}</div>`);
        }
      }
      tableFileBrowseList.innerHTML = rows.join('') || '<div class="folder-row">Brak podfolderów ani plików .xlsx.</div>';
    } catch (error) {
      tableFileBrowseList.innerHTML = `<div class="folder-row">${escapeHtml(String(error.message || error))}</div>`;
    }
  }

  browseTableFileBtn.addEventListener('click', () => {
    const startPath = tableExcelPathInput.value.trim();
    openTableFileBrowser(startPath || null);
  });
  tableFileBrowseClose.addEventListener('click', closeTableFileBrowser);
  tableFileBrowseCancel.addEventListener('click', closeTableFileBrowser);
  tableFileBrowseModal.addEventListener('click', (event) => {
    if (event.target.id === 'tableFileBrowseModal') closeTableFileBrowser();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && tableFileBrowseModal.classList.contains('open')) closeTableFileBrowser();
  });
  tableFileBrowseList.addEventListener('click', (event) => {
    const fileRow = event.target.closest('[data-file-path]');
    if (fileRow) {
      tableExcelPathInput.value = fileRow.dataset.filePath;
      closeTableFileBrowser();
      return;
    }
    const folderRow = event.target.closest('[data-path]');
    if (folderRow) loadTableFileBrowse(folderRow.dataset.path);
  });

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
      setStatus('Rozpoznawanie stron i szukanie adresów... To może potrwać chwilę, zależnie od liczby stron.', 55);
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
        if (tableMode) {
          // Tryb "wgraj tabele": etykieta = numer LP. Pliki audytow sa juz
          // nazwane numerem (potwierdzone realnie) - dla jedynego bloku w
          // pliku podpowiadamy go od razu; przy wielu blokach w jednym
          // pliku nie da sie tego rozstrzygnac automatem, zostaje puste.
          if ((item.blocks.length || 1) === 1) labels.set(b.startPage, guessLpFromFilename(item.originalName));
        } else if ((item.blocks.length || 1) > 1) {
          labels.set(b.startPage, `Adres ${i + 1}`);
        }
      });
      analysisFiles.push({
        fileId: item.fileId,
        originalName: item.originalName,
        pageCount: item.pageCount,
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
    }
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
      if (tableMode) {
        // Etykieta = numer LP w tym trybie (dopasowanie wiersza tabeli),
        // zawsze edytowalna - w odroznieniu od zwyklego trybu ponizej,
        // gdzie pojedynczy blok w ogole nie ma pola (nie jest potrzebne).
        const label = f.labels.get(b.startPage) ?? '';
        return `<div class="block-row">
          <span class="block-range">${range}</span>
          <input type="text" class="block-label" data-file="${f.fileId}" data-start="${b.startPage}" placeholder="Numer LP" value="${escapeHtml(label)}">
        </div>`;
      }
      if (blocks.length === 1) {
        return `<div class="block-row"><span class="block-range">${range}</span><span class="block-single-note">jeden plik = jeden adres</span></div>`;
      }
      const label = f.labels.get(b.startPage) ?? `Adres ${i + 1}`;
      return `<div class="block-row">
        <span class="block-range">${range}</span>
        <input type="text" class="block-label" data-file="${f.fileId}" data-start="${b.startPage}" placeholder="Adres ${i + 1}" value="${escapeHtml(label)}">
      </div>`;
    }).join('');

    const meta = f.pageCount ? `<div class="meta">${f.pageCount} stron</div>` : '';
    const warnings = f.warnings.length ? `<ul class="warnings">${f.warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul>` : '';

    return `
      <div class="review-file">
        <div class="head">
          <span class="name">${escapeHtml(f.originalName)}</span>
        </div>
        ${meta}
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
  // (patrz src/geminiFieldEngine.js) - dopiero TERAZ, po ustaleniu ostatecznych
  // zakresów stron dla każdego adresu, ma sens pytać o pola "w tym bloku".

  confirmBtn.addEventListener('click', async () => {
    if (!analysisId || !analysisFiles.length) return;
    errorBox.innerHTML = '';

    if (tableMode) {
      // Kazdy blok musi miec numer LP - inaczej cicho zgubilibysmy dane tego
      // audytu (patrz plan: "czytelny blad zamiast cichego pominiecia").
      const missingLp = analysisFiles.some((f) => computeBlocks(f).some((b) => !f.labels.get(b.startPage)?.trim()));
      if (missingLp) {
        errorBox.innerHTML = '<div class="error-box">Uzupełnij numer LP dla każdego adresu (pole nad listą stron) przed dalszym krokiem.</div>';
        return;
      }
    } else {
      selectedFamily = familySelect.value || '';
      if (selectedFamily) localStorage.setItem(FAMILY_STORAGE_KEY, selectedFamily);
      else localStorage.removeItem(FAMILY_STORAGE_KEY);
    }

    confirmBtn.disabled = true;
    setStatus('Odczytuję dane z formularzy... To może potrwać do kilkudziesięciu sekund na adres.', 70);

    const payload = {
      analysisId,
      family: tableMode ? tableFamily : (selectedFamily || undefined),
      selectedKeys: tableMode ? [...selectedFieldKeys] : undefined,
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

  // --- Krok 3b: tabela pól, edycja niepewnych ----------------------------

  // Pola ukryte (patrz CONDITIONAL_FIELDS - np. "opis Inny", gdy Zrodlo
  // ciepla nie jest ustawione na "Inny") sie nie licza - inaczej odznaka
  // "X do sprawdzenia" wskazywalaby na pole, ktorego nie da sie nawet
  // zobaczyc na ekranie.
  function countNeedsReview(block) {
    return Object.entries(block.fields).filter(([key, f]) => f.needsReview && !fieldRowHidden(block, key)).length;
  }

  function startFieldReview() {
    const familyNote = tableMode
      ? `Zawężono do ${selectedFieldKeys.size} wybranych pól - wynik trafi do: ${tableExcelPath}`
      : selectedFamily
        ? `Zawężono do pól rodziny "${FAMILY_LABELS[selectedFamily] || selectedFamily}".`
        : 'Nie zawężono do konkretnej rodziny - wszystkie pola.';
    familyChosenNote.textContent = familyNote;
    fieldsIntro.textContent = activeOcrProvider === 'manual'
      ? 'Żadne pole nie zostało rozpoznane automatycznie (tryb ręczny) - odczytaj wartości z podglądu obok i wpisz je samodzielnie.'
      : 'Program rozpoznał większość pól automatycznie. Pola oznaczone na bursztynowo wymagają Twojej uwagi - sprawdź je na podglądzie obok i wpisz poprawną wartość. Zmiany zapisują się automatycznie.';
    reviewPanel.hidden = true;
    fieldsPanel.hidden = false;
    excelStep.hidden = false;
    if (tableMode) {
      excelPathInput.value = tableExcelPath;
      excelPathField.hidden = true;
      excelStepHint.textContent = 'Zapis wypełni TYLKO puste komórki w tej samej tabeli - nic już wypełnionego nie zostanie nadpisane.';
      finalizeBtn.textContent = 'Wypełnij tabelę i pobierz';
    } else {
      excelPathField.hidden = false;
      excelStepHint.textContent = 'Zostaw puste, jeśli teraz nie chcesz zapisywać do Excela - dostaniesz tylko gotowe PDF-y. Wybór rodziny (krok 3) dopasowuje nagłówki kolumn 1:1 do prawdziwego wzoru (LP, REZYGNACJA i inne kolumny biurowe zostają puste do ręcznego uzupełnienia) - to osobny plik do skopiowania, program nie zapisuje bezpośrednio do prawdziwego wzoru.';
      finalizeBtn.textContent = 'Zapisz i pobierz';
    }
    renderFieldsBlocks();
  }

  // --- Duzy, wbudowany podglad strony (zamiast miniatur + linku w nowej
  // karcie) - wzorowany na apps/nazywarka-skanow, ale zoom robi CSS na
  // <img> (nie #zoom= na <iframe>, bo strony tutaj to gotowe JPG/JP2, nie
  // PDF - patrz uzasadnienie w planie/commit message). Jeden globalny
  // poziom zoomu; aktualna strona trzymana PER BLOK (block.previewPage),
  // zeby przegladanie jednego adresu nie ruszalo podgladu innych.
  const PREVIEW_ZOOM_LEVELS = [50, 75, 90, 100, 125, 150, 175, 200, 250, 300];
  let previewZoom = 'fit';

  function previewZoomLabel() {
    return previewZoom === 'fit' ? 'Dopasuj' : `${previewZoom}%`;
  }

  function findBlock(fileId, blockIndex) {
    const file = fieldsFiles.find((f) => f.fileId === fileId);
    return file?.blocks?.find((b) => b.blockIndex === Number(blockIndex)) || null;
  }

  // Podglad = ORYGINALNY wgrany PDF (nie wyciety obrazek strony), pokazany
  // przez <iframe> na natywna przegladarke PDF (jak w nazywarce-skanow) -
  // #page=/#zoom= to standardowe parametry otwierania PDF, rozumiane przez
  // wbudowana przegladarke Chrome/Edge. Daje "za darmo" zaznaczanie/
  // kopiowanie tekstu (o ile skan juz ma warstwe tekstu) oraz natywne
  // przewijanie/przeciaganie i skalowanie przegladarki - bez wlasnej
  // implementacji zoom/pan na obrazku.
  function pdfPreviewUrl(fileId, pageIndex, zoom) {
    const zoomValue = zoom === 'fit' ? 'page-width' : String(zoom);
    return `/api/analysis/${analysisId}/files/${fileId}/pdf#page=${pageIndex + 1}&zoom=${encodeURIComponent(zoomValue)}&toolbar=0`;
  }

  function renderPreviewPane(fileId, block) {
    if (block.previewPage == null) block.previewPage = block.startPage;
    const pageCount = block.endPage - block.startPage + 1;
    const pageNoInBlock = block.previewPage - block.startPage + 1;
    return `
      <div class="field-preview" data-file="${fileId}" data-block="${block.blockIndex}">
        <div class="doc-viewer">
          <div class="doc-viewer-toolbar">
            <button type="button" class="btn btn-icon" data-action="prev" ${block.previewPage <= block.startPage ? 'disabled' : ''} title="Poprzednia strona"><svg class="icon"><use href="/shared/icons.svg#i-chevron-left"/></svg></button>
            <span class="zoom-label" data-page-label>Str. ${pageNoInBlock}/${pageCount}</span>
            <button type="button" class="btn btn-icon" data-action="next" ${block.previewPage >= block.endPage ? 'disabled' : ''} title="Następna strona"><svg class="icon"><use href="/shared/icons.svg#i-chevron-right"/></svg></button>
            <span style="flex:1"></span>
            <button type="button" class="btn btn-icon" data-action="zoom-out" title="Pomniejsz"><svg class="icon"><use href="/shared/icons.svg#i-zoom-out"/></svg></button>
            <span class="zoom-label" data-zoom-label>${previewZoomLabel()}</span>
            <button type="button" class="btn btn-icon" data-action="zoom-in" title="Powiększ"><svg class="icon"><use href="/shared/icons.svg#i-zoom-in"/></svg></button>
            <button type="button" class="btn btn-icon" data-action="zoom-fit" title="Dopasuj do szerokości"><svg class="icon"><use href="/shared/icons.svg#i-refresh"/></svg></button>
          </div>
          <div class="doc-viewer-stage"><iframe data-preview-frame src="${pdfPreviewUrl(fileId, block.previewPage, previewZoom)}" title="Strona ${block.previewPage + 1}"></iframe></div>
        </div>
      </div>
    `;
  }

  // Aktualizuje TYLKO podglad danego bloku bezposrednio przez DOM (bez
  // wywolania renderFieldsBlocks) - inaczej klikniecie strzalki/zoomu
  // resetowaloby scroll i fokus w tabeli pol obok, dokladnie tak jak
  // saveFieldValue nizej aktualizuje pojedyncze pole bez przeladowania
  // calej listy.
  function updatePreviewPaneDom(paneEl, fileId, block) {
    const stage = paneEl.querySelector('.doc-viewer-stage');
    stage.innerHTML = `<iframe data-preview-frame src="${pdfPreviewUrl(fileId, block.previewPage, previewZoom)}" title="Strona ${block.previewPage + 1}"></iframe>`;
    const pageCount = block.endPage - block.startPage + 1;
    const pageNoInBlock = block.previewPage - block.startPage + 1;
    paneEl.querySelector('[data-page-label]').textContent = `Str. ${pageNoInBlock}/${pageCount}`;
    paneEl.querySelector('[data-zoom-label]').textContent = previewZoomLabel();
    const prevBtn = paneEl.querySelector('[data-action="prev"]');
    const nextBtn = paneEl.querySelector('[data-action="next"]');
    prevBtn.disabled = block.previewPage <= block.startPage;
    nextBtn.disabled = block.previewPage >= block.endPage;
  }

  fieldsBlocksEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const paneEl = btn.closest('.field-preview');
    const fileId = paneEl.dataset.file;
    const block = findBlock(fileId, paneEl.dataset.block);
    if (!block) return;

    switch (btn.dataset.action) {
      case 'prev':
        block.previewPage = Math.max(block.startPage, block.previewPage - 1);
        break;
      case 'next':
        block.previewPage = Math.min(block.endPage, block.previewPage + 1);
        break;
      case 'zoom-out': {
        if (previewZoom === 'fit') { previewZoom = 100; break; }
        const i = PREVIEW_ZOOM_LEVELS.findIndex((x) => x >= previewZoom);
        previewZoom = PREVIEW_ZOOM_LEVELS[i <= 0 ? 0 : i - 1];
        break;
      }
      case 'zoom-in': {
        if (previewZoom === 'fit') { previewZoom = 125; break; }
        const i = PREVIEW_ZOOM_LEVELS.findIndex((x) => x > previewZoom);
        previewZoom = i === -1 ? PREVIEW_ZOOM_LEVELS[PREVIEW_ZOOM_LEVELS.length - 1] : PREVIEW_ZOOM_LEVELS[i];
        break;
      }
      case 'zoom-fit':
        previewZoom = 'fit';
        break;
      default:
        return;
    }
    // Zoom jest globalny (jeden poziom dla wszystkich bloków na ekranie) -
    // przy zmianie zoomu odswiez KAZDY widoczny podglad, nie tylko ten
    // klikniety; zmiana strony dotyczy tylko bloku, w ktorym kliknieto.
    if (btn.dataset.action.startsWith('zoom')) {
      fieldsBlocksEl.querySelectorAll('.field-preview').forEach((pane) => {
        const b = findBlock(pane.dataset.file, pane.dataset.block);
        if (b) updatePreviewPaneDom(pane, pane.dataset.file, b);
      });
    } else {
      updatePreviewPaneDom(paneEl, fileId, block);
    }
  });

  // Pola z zamknietym slownikiem (field.options, patrz
  // src/fieldExtraction.js#COLUMN_OPTIONS) sa renderowane jako <select>, nie
  // wolne pole tekstowe - wartosc spoza listy i tak zostalaby oflagowana
  // needsReview (patrz toFieldResult), wiec dropdown od razu wymusza
  // poprawna wartosc zamiast literowek. "Źródło ciepła - opis Inny" jest
  // widoczne TYLKO gdy "Źródło ciepła" ma zaznaczone "Inny".
  const CONDITIONAL_FIELDS = {
    zrodloCieplaInnyOpis: { whenKey: 'zrodloCiepla', equalsValue: 'Inny' },
    ocieplenieScianyZewnGrubosc: { whenKey: 'ocieplenieScianyZewn', equalsValue: '__hide_when_brak__' },
    izolacjaScianyFundamentowejGrubosc: { whenKey: 'izolacjaScianyFundamentowej', equalsValue: 'Tak' },
    izolacjaDachuGrubosc: { whenKey: 'izolacjaDachu', equalsValue: 'Tak' }
  };

  function rowHiddenByValue(rule, parentValue) {
    if (rule.equalsValue === '__hide_when_brak__') {
      return !parentValue || parentValue === 'Brak';
    }
    return parentValue !== rule.equalsValue;
  }

  function fieldRowHidden(block, key) {
    const rule = CONDITIONAL_FIELDS[key];
    if (!rule) return false;
    return rowHiddenByValue(rule, block.fields[rule.whenKey]?.value);
  }

  function renderFieldValueControl(fileId, block, key, field) {
    const common = `data-file="${fileId}" data-block="${block.blockIndex}" data-key="${key}"`;
    if (field.options && field.options.length) {
      const known = field.options.includes(field.value);
      const optionsHtml = [
        '<option value=""></option>',
        ...field.options.map((label) => `<option value="${escapeHtml(label)}" ${field.value === label ? 'selected' : ''}>${escapeHtml(label)}</option>`),
        // Wartosc spoza listy (np. halucynacja modelu) NIE znika z ekranu -
        // zostaje jako dodatkowa opcja, zeby bylo widac co faktycznie
        // rozpoznano zamiast cichego resetu do pustego pola.
        field.value && !known ? `<option value="${escapeHtml(field.value)}" selected>${escapeHtml(field.value)} (nierozpoznane)</option>` : ''
      ].join('');
      return `<select ${common}>${optionsHtml}</select>`;
    }
    return `<input type="text" ${common} value="${escapeHtml(field.value || '')}" autocomplete="off">`;
  }

  function renderFieldsBlocks() {
    const parts = [];
    for (const file of fieldsFiles) {
      for (const block of file.blocks) {
        const remaining = countNeedsReview(block);
        const nameLine = block.label ? `${file.originalName} — ${block.label}` : file.originalName;
        const rows = Object.entries(block.fields).map(([key, field]) => `
          <tr class="${field.needsReview ? 'needs-review' : ''}" data-row-key="${key}" ${fieldRowHidden(block, key) ? 'hidden' : ''}>
            <td class="field-col-label">${escapeHtml(field.columnLabel)}</td>
            <td class="field-col-value${field.options && field.options.length ? ' has-select' : ''}">${renderFieldValueControl(file.fileId, block, key, field)}</td>
          </tr>
        `).join('');
        const blockWarnings = (file.warnings || []).filter(w => w.includes(block.label || `adres ${block.blockIndex + 1}`));
        const warningsHtml = blockWarnings.length ? `<ul class="warnings">${blockWarnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul>` : '';
        parts.push(`
          <div class="field-block">
            <div class="field-block-head">
              <span class="name">${escapeHtml(nameLine)}</span>
              <span class="badge ${remaining ? 'warn' : 'ok'}">${remaining ? `${remaining} do sprawdzenia` : 'wszystko rozpoznane'}</span>
            </div>
            ${warningsHtml}
            <div class="field-block-body">
              ${renderPreviewPane(file.fileId, block)}
              <table class="field-table"><tbody>${rows}</tbody></table>
            </div>
          </div>
        `);
      }
    }
    fieldsBlocksEl.innerHTML = parts.join('');
  }

  function findBlockFields(fileId, blockIndex) {
    return findBlock(fileId, blockIndex)?.fields || null;
  }

  // Zapisuje reczna poprawke jednego pola na serwerze (patrz POST
  // /api/ocr/resolve-field) - wywolywane przy opuszczeniu pola (blur) i przy
  // Enter, tylko gdy wartosc faktycznie sie zmienila wzgledem ostatnio
  // zapisanej (unika zbednych zadan przy zwyklym przegladaniu tabeli).
  let isSavingField = false;
  async function saveFieldValue(input) {
    const { file: fileId, block: blockIndex, key } = input.dataset;
    const fields = findBlockFields(fileId, blockIndex);
    const field = fields?.[key];
    if (!field) return;
    const value = input.value;
    if (value === (field.value || '')) return; // bez zmian - nic do zapisania
    if (isSavingField) return;
    isSavingField = true;
    input.disabled = true;
    try {
      await apiJson('/api/ocr/resolve-field', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Scyzoryk-Request': '1' },
        body: JSON.stringify({ analysisId, fileId, blockIndex: Number(blockIndex), fieldKey: key, value })
      });
      field.value = value.trim().slice(0, 300);
      field.needsReview = false;
      field.resolved = true;

      // Punktowa aktualizacja TYLKO dotknietego wiersza i naglowka jego
      // bloku - NIE pelny renderFieldsBlocks(). Pelny render niszczyl i
      // odtwarzal WSZYSTKIE bloki na ekranie (wlacznie z kazdym podgladem
      // PDF innych adresow/plikow) po KAZDYM zapisanym polu, wiec przy Enter
      // wszystkie podglady bezsensownie "mrugaly"/resetowaly zoom i strone -
      // zgloszone przez wlasciciela na zywo. Skoro <input>/<select> teraz
      // NIE jest niszczony, nie trzeba tez juz recznie zapamietywac/
      // przywracac fokusu i zaznaczenia (byla to lata tylko po to, zeby
      // przetrwac pelny re-render).
      const row = input.closest('tr[data-row-key]');
      if (row) row.classList.remove('needs-review');
      const blockEl = input.closest('.field-block');
      const block = findBlock(fileId, blockIndex);
      const badge = blockEl?.querySelector('.field-block-head .badge');
      if (badge && block) {
        const remaining = countNeedsReview(block);
        badge.textContent = remaining ? `${remaining} do sprawdzenia` : 'wszystko rozpoznane';
        badge.classList.toggle('warn', Boolean(remaining));
        badge.classList.toggle('ok', !remaining);
      }
    } catch (err) {
      errorBox.innerHTML = `<div class="error-box">Nie udało się zapisać pola: ${escapeHtml(err.message)}</div>`;
    } finally {
      isSavingField = false;
      input.disabled = false;
    }
  }

  fieldsBlocksEl.addEventListener('blur', (e) => {
    const input = e.target.closest('input[data-key]');
    if (input) saveFieldValue(input);
  }, true);

  // <select> pola (Zrodlo ciepla i inne z zamknietym slownikiem) zapisuja
  // sie od razu przy wyborze (change), nie przy blur - i aktualizuja
  // widocznosc pol zaleznych (patrz CONDITIONAL_FIELDS) NATYCHMIAST, bez
  // czekania na zapis w tle, zeby ukryte pole nie "mrugalo".
  fieldsBlocksEl.addEventListener('change', (e) => {
    const select = e.target.closest('select[data-key]');
    if (!select) return;
    const table = select.closest('table');
    for (const [depKey, rule] of Object.entries(CONDITIONAL_FIELDS)) {
      if (rule.whenKey !== select.dataset.key) continue;
      const row = table?.querySelector(`tr[data-row-key="${depKey}"]`);
      if (row) row.hidden = rowHiddenByValue(rule, select.value);
    }
    saveFieldValue(select);
  });

  // Enter = przejdz do nastepnego pola (jak Tab), nie tylko "zapisz i zgub
  // fokus". Kolejnosc pol = kolejnosc <input>/<select> w DOM (czyli kolejnosc
  // renderowania blokow/wierszy), pomijajac ukryte wiersze (CONDITIONAL_FIELDS).
  // next.focus() nizej sam wywoluje blur na biezacym polu (zapis w tle), a
  // przywrocenie fokusu po ewentualnym renderze obsluguje saveFieldValue powyzej.
  fieldsBlocksEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const input = e.target.closest('input[data-key], select[data-key]');
    if (!input) return;
    e.preventDefault();
    const allInputs = Array.from(fieldsBlocksEl.querySelectorAll('input[data-key], select[data-key]'))
      .filter((el) => !el.closest('tr[hidden]'));
    const next = allInputs[allInputs.indexOf(input) + 1];
    if (next) {
      next.focus();
      if (typeof next.select === 'function') next.select();
    } else {
      input.blur();
    }
  });

  // --- Krok 3c: ścieżka do Excela + finalizacja ---------------------------

  finalizeBtn.addEventListener('click', async () => {
    if (!analysisId) return;
    finalizeBtn.disabled = true;
    errorBox.innerHTML = '';
    setStatus('Zapisywanie plików...', 90);

    const excelPath = excelPathInput.value.trim();
    if (!tableMode) {
      if (excelPath) localStorage.setItem(EXCEL_PATH_STORAGE_KEY, excelPath);
      else localStorage.removeItem(EXCEL_PATH_STORAGE_KEY);
    }

    const payload = {
      analysisId,
      files: fieldsFiles.map(f => ({ fileId: f.fileId })),
      excelPath: excelPath || undefined,
      family: tableMode ? tableFamily : (selectedFamily || undefined),
      mode: tableMode ? 'fill-existing' : undefined,
      selectedKeys: tableMode ? [...selectedFieldKeys] : undefined
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
      resultsPanel.hidden = false;
      renderResults(data.results);

      if (data.excelPath && data.fillStats) {
        excelResultNote.hidden = false;
        const unmatched = data.fillStats.unmatchedLp || [];
        excelResultNote.textContent = data.excelError
          ? `Pliki PDF zapisane, ale nie udało się wypełnić tabeli: ${data.excelError}`
          : `Wypełniono ${data.fillStats.filledCells} pustych komórek w ${data.fillStats.matchedRows} wierszach pliku ${data.excelPath}.`
            + (unmatched.length ? ` Nie znaleziono w tabeli wiersza dla LP: ${unmatched.join(', ')}.` : '')
            + (data.excelBackupPath ? ` (kopia poprzedniej wersji: ${data.excelBackupPath})` : '');
      } else if (data.excelPath) {
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
            ${item.ok ? '<span class="badge ok">Gotowe</span>' : '<span class="badge unknown">Błąd</span>'}
          </div>
          ${meta.length ? `<div class="meta">${meta.join(' · ')}</div>` : ''}
          ${warnings}
          ${errorLine}
          ${downloadLink ? `<div style="margin-top:10px">${downloadLink}</div>` : ''}
        </div>
      `;
    }).join('');
  }

  // Zamiast wypiekac klucz w instalatorze, uzytkownik wpisuje klucz API
  // RECZNIE RAZ na tym komputerze - ekran ponizej pokazuje sie zamiast
  // normalnego formularza, dopoki /api/health zglasza ocrConfigured:false.
  // "Zmień klucz API" w naglowku pozwala otworzyc ten sam formularz TAKZE gdy
  // juz dziala (np. zmiana konta/dostawcy) - nowy klucz nadpisuje poprzedni.
  // 2026-08-19: dwaj dostawcy (Gemini/OpenAI, patrz src/aiProvider.js) -
  // wybor radiobuttona decyduje, do ktorego pliku klucz trafi i ktory
  // dostawca staje sie aktywny.
  let ocrIsConfigured = false;
  // Odczytywane w checkOcrConfigured() - uzywane m.in. przez startFieldReview
  // do podmiany tekstu wprowadzenia na ekranie "Uzupelnij dane" w trybie
  // recznym (bez AI).
  let activeOcrProvider = 'gemini';

  const PROVIDER_KEY_PLACEHOLDERS = { gemini: 'AIza...', openai: 'sk-...' };
  const PROVIDER_KEY_LABELS = { gemini: 'Klucz API Gemini', openai: 'Klucz API OpenAI' };
  const PROVIDER_DISPLAY_NAMES = { gemini: 'Google Gemini', openai: 'OpenAI', manual: 'Ręcznie (bez AI)' };

  function selectedProvider() {
    if (ocrProviderManual.checked) return 'manual';
    return ocrProviderOpenai.checked ? 'openai' : 'gemini';
  }

  // Tryb 'manual' nie potrzebuje zadnego klucza - chowa cale pole (i zdejmuje
  // `required`, inaczej formularz nigdy by sie nie dalo wyslac) i pokazuje
  // krotkie wyjasnienie zamiast niego.
  function updateApiKeyFieldForProvider() {
    const provider = selectedProvider();
    const isManual = provider === 'manual';
    ocrApiKeyField.hidden = isManual;
    ocrApiKeyInput.required = !isManual;
    ocrManualHint.hidden = !isManual;
    if (!isManual) {
      ocrApiKeyLabel.textContent = PROVIDER_KEY_LABELS[provider];
      ocrApiKeyInput.placeholder = PROVIDER_KEY_PLACEHOLDERS[provider];
    }
  }

  [ocrProviderGemini, ocrProviderOpenai, ocrProviderManual].forEach((el) => el.addEventListener('change', updateApiKeyFieldForProvider));
  updateApiKeyFieldForProvider();

  function setProviderRadio(provider) {
    if (provider === 'openai') ocrProviderOpenai.checked = true;
    else if (provider === 'manual') ocrProviderManual.checked = true;
    else ocrProviderGemini.checked = true;
  }

  function setOcrLocked(locked) {
    ocrLockedPanel.hidden = !locked;
    ocrHeroSection.hidden = locked;
    // Krok 0 (tabela) dziala bez klucza API (tylko czyta plik), ale chowamy go
    // razem z reszta przy zablokowanym ekranie - ten sam wzorzec co ocrUploadPanel.
    // Przy odblokowaniu wraca DOKLADNIE ten krok, na ktorym uzytkownik byl
    // (pastTableStep pamieta czy juz kliknal "Sprawdz tabele"/"Pomiń").
    if (locked) {
      tablePanel.hidden = true;
      ocrUploadPanel.hidden = true;
    } else {
      tablePanel.hidden = pastTableStep;
      ocrUploadPanel.hidden = !pastTableStep;
    }
    ocrUnlockCancelBtn.hidden = !locked || !ocrIsConfigured;
    ocrLockedTitle.textContent = ocrIsConfigured
      ? '🔑 Zmień klucz API'
      : '🔒 Rozpoznawanie tekstu nie jest jeszcze skonfigurowane';
  }

  async function checkOcrConfigured() {
    try {
      const res = await fetch('/api/health');
      const data = await res.json().catch(() => null);
      ocrIsConfigured = Boolean(data?.ok) && data.ocrConfigured === true;
      if (data?.ocrProvider) activeOcrProvider = data.ocrProvider;
      ocrChangeKeyBtn.hidden = !ocrIsConfigured;
      setProviderRadio(data?.ocrProvider);
      updateApiKeyFieldForProvider();
      ocrActiveProviderNote.hidden = !ocrIsConfigured;
      if (ocrIsConfigured) ocrActiveProviderNote.textContent = `Aktywny: ${data.ocrProviderLabel || data.ocrProvider}`;
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
    const provider = selectedProvider();
    const apiKey = ocrApiKeyInput.value.trim();
    if (provider !== 'manual' && !apiKey) return; // tryb reczny nie potrzebuje klucza

    ocrUnlockBtn.disabled = true;
    ocrUnlockStatus.className = '';
    ocrUnlockStatus.textContent = 'Zapisuję...';
    try {
      const data = await apiJson('/api/ocr/setup-api-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Scyzoryk-Request': '1' },
        body: JSON.stringify({ provider, apiKey })
      });
      if (!data.ok) throw new Error(data.message || 'Nie udało się zapisać klucza API.');

      ocrUnlockStatus.className = 'ok';
      ocrUnlockStatus.textContent = 'Gotowe. Odblokowuję...';
      ocrIsConfigured = true;
      activeOcrProvider = provider;
      ocrChangeKeyBtn.hidden = false;
      ocrActiveProviderNote.hidden = false;
      ocrActiveProviderNote.textContent = `Aktywny: ${PROVIDER_DISPLAY_NAMES[provider]}`;
      setOcrLocked(false);
      ocrUnlockForm.reset();
      // reset() cofa tez wybor radiobuttona do stanu domyslnego z HTML (gemini) -
      // przywracamy faktycznie wybranego dostawcy, zeby ekran "Zmień klucz API"
      // przy nastepnym otwarciu dalej pokazywal ten, ktory jest teraz aktywny.
      setProviderRadio(provider);
      updateApiKeyFieldForProvider();
    } catch (err) {
      ocrUnlockStatus.className = 'err';
      ocrUnlockStatus.textContent = err.message || 'Nie udało się zapisać klucza API.';
    } finally {
      ocrUnlockBtn.disabled = false;
    }
  });
})();
