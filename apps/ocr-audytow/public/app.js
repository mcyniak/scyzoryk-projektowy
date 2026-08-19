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
  const familySelectField = document.getElementById('familySelectField');
  const excelPathField = document.getElementById('excelPathField');
  const excelStepHint = document.getElementById('excelStepHint');

  const ocrLockedPanel = document.getElementById('ocrLockedPanel');
  const ocrLockedTitle = document.getElementById('ocrLockedTitle');
  const ocrHeroSection = document.getElementById('ocrHeroSection');
  const ocrUploadPanel = document.getElementById('ocrUploadPanel');
  const ocrChangeKeyBtn = document.getElementById('ocrChangeKeyBtn');
  const ocrUnlockForm = document.getElementById('ocrUnlockForm');
  const ocrApiKeyInput = document.getElementById('ocrApiKeyInput');
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

  function countNeedsReview(block) {
    return Object.values(block.fields).filter(f => f.needsReview).length;
  }

  function startFieldReview() {
    const familyNote = tableMode
      ? `Zawężono do ${selectedFieldKeys.size} wybranych pól - wynik trafi do: ${tableExcelPath}`
      : selectedFamily
        ? `Zawężono do pól rodziny "${FAMILY_LABELS[selectedFamily] || selectedFamily}".`
        : 'Nie zawężono do konkretnej rodziny - wszystkie pola.';
    familyChosenNote.textContent = familyNote;
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

  function thumbsForBlock(fileId, startPage, endPage) {
    const analysisFile = analysisFiles.find(f => f.fileId === fileId);
    if (!analysisFile) return '';
    const thumbByPage = new Map(analysisFile.thumbnails.map(t => [t.pageIndex, t]));
    const cells = [];
    for (let p = startPage; p <= endPage; p++) {
      const thumb = thumbByPage.get(p);
      if (!thumb?.available) continue;
      cells.push(`<a href="/api/analysis/${analysisId}/files/${fileId}/page/${p}" target="_blank" rel="noopener" class="field-thumb-link" title="Zobacz stronę ${p + 1} w pełnym rozmiarze"><img src="${thumb.url}" alt="Strona ${p + 1}" loading="lazy"><span class="page-no">${p + 1}</span></a>`);
    }
    return cells.length ? `<div class="field-block-thumbs">${cells.join('')}</div>` : '';
  }

  function renderFieldsBlocks() {
    const parts = [];
    for (const file of fieldsFiles) {
      for (const block of file.blocks) {
        const remaining = countNeedsReview(block);
        const nameLine = block.label ? `${file.originalName} — ${block.label}` : file.originalName;
        const rows = Object.entries(block.fields).map(([key, field]) => `
          <tr class="${field.needsReview ? 'needs-review' : ''}">
            <td class="field-col-label">${escapeHtml(field.columnLabel)}</td>
            <td class="field-col-value">
              <input type="text" data-file="${file.fileId}" data-block="${block.blockIndex}" data-key="${key}" value="${escapeHtml(field.value || '')}" autocomplete="off">
            </td>
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
            ${thumbsForBlock(file.fileId, block.startPage, block.endPage)}
            <table class="field-table"><tbody>${rows}</tbody></table>
          </div>
        `);
      }
    }
    fieldsBlocksEl.innerHTML = parts.join('');
  }

  function findBlockFields(fileId, blockIndex) {
    const file = fieldsFiles.find(f => f.fileId === fileId);
    const block = file?.blocks?.find(b => b.blockIndex === Number(blockIndex));
    return block?.fields || null;
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
      renderFieldsBlocks();
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

  fieldsBlocksEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const input = e.target.closest('input[data-key]');
    if (!input) return;
    e.preventDefault();
    input.blur();
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
  // Gemini RECZNIE RAZ na tym komputerze - ekran ponizej pokazuje sie zamiast
  // normalnego formularza, dopoki /api/health zglasza ocrConfigured:false.
  // "Zmień klucz API" w naglowku pozwala otworzyc ten sam formularz TAKZE gdy
  // juz dziala (np. zmiana konta) - nowy klucz nadpisuje poprzedni.
  let ocrIsConfigured = false;

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
    const apiKey = ocrApiKeyInput.value.trim();
    if (!apiKey) return;

    ocrUnlockBtn.disabled = true;
    ocrUnlockStatus.className = '';
    ocrUnlockStatus.textContent = 'Zapisuję...';
    try {
      const data = await apiJson('/api/ocr/setup-api-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Scyzoryk-Request': '1' },
        body: JSON.stringify({ apiKey })
      });
      if (!data.ok) throw new Error(data.message || 'Nie udało się zapisać klucza API.');

      ocrUnlockStatus.className = 'ok';
      ocrUnlockStatus.textContent = 'Gotowe. Odblokowuję...';
      ocrIsConfigured = true;
      ocrChangeKeyBtn.hidden = false;
      setOcrLocked(false);
      ocrUnlockForm.reset();
    } catch (err) {
      ocrUnlockStatus.className = 'err';
      ocrUnlockStatus.textContent = err.message || 'Nie udało się zapisać klucza API.';
    } finally {
      ocrUnlockBtn.disabled = false;
    }
  });
})();
