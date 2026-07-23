(() => {
  const mainPanelUrl = window.location.protocol + '//' + window.location.hostname + ':3000';
  document.querySelectorAll('[data-main-link]').forEach((link) => { link.href = mainPanelUrl; link.removeAttribute('target'); });

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
  const fieldDocName = document.getElementById('fieldDocName');
  const fieldLabel = document.getElementById('fieldLabel');
  const fieldForm = document.getElementById('fieldForm');
  const fieldValueInput = document.getElementById('fieldValueInput');
  const fieldSkipBtn = document.getElementById('fieldSkipBtn');
  const excelStep = document.getElementById('excelStep');
  const excelPathInput = document.getElementById('excelPathInput');
  const finalizeBtn = document.getElementById('finalizeBtn');
  const resultsPanel = document.getElementById('resultsPanel');
  const resultList = document.getElementById('resultList');

  const EXCEL_PATH_STORAGE_KEY = 'ocr-audytow-excel-path';
  excelPathInput.value = localStorage.getItem(EXCEL_PATH_STORAGE_KEY) || '';

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

    const payload = {
      analysisId,
      files: analysisFiles.map(f => ({
        fileId: f.fileId,
        blocks: computeBlocks(f).map(b => ({ ...b, label: f.labels.get(b.startPage) || '' }))
      }))
    };

    try {
      const res = await fetch('/api/ocr/extract-fields', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Scyzoryk-Request': '1' },
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) throw new Error(data?.message || 'Nie udało się sprawdzić danych.');

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

  function startFieldReview() {
    reviewQueue = [];
    for (const file of fieldsFiles) {
      for (const block of file.blocks) {
        for (const [fieldKey, field] of Object.entries(block.fields)) {
          if (field.needsReview) reviewQueue.push({ fileId: file.fileId, originalName: file.originalName, blockIndex: block.blockIndex, blockLabel: block.label, fieldKey, field });
        }
      }
    }
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
    fieldProgress.textContent = `Do uzupełnienia: ${queuePos + 1} z ${reviewQueue.length}`;
    const nameLine = item.blockLabel ? `${item.originalName} — ${item.blockLabel}` : item.originalName;
    fieldDocName.textContent = nameLine;
    fieldLabel.textContent = item.field.columnLabel;
    fieldValueInput.value = item.field.value || '';
    if (item.field.previewUrl) {
      fieldPreviewImg.hidden = false;
      fieldPreviewImg.src = item.field.previewUrl;
      fieldPreviewMissing.hidden = true;
    } else {
      fieldPreviewImg.hidden = true;
      fieldPreviewImg.removeAttribute('src');
      fieldPreviewMissing.hidden = false;
    }
    setTimeout(() => { fieldValueInput.focus(); fieldValueInput.select(); }, 0);
  }

  async function resolveCurrentField(value) {
    const item = reviewQueue[queuePos];
    try {
      await fetch('/api/ocr/resolve-field', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Scyzoryk-Request': '1' },
        body: JSON.stringify({ analysisId, fileId: item.fileId, blockIndex: item.blockIndex, fieldKey: item.fieldKey, value })
      });
    } catch (_) { /* najgorszy przypadek: pole zostanie ponownie zaznaczone jako niepewne przy finalize */ }
    queuePos += 1;
    if (queuePos < reviewQueue.length) {
      renderCurrentField();
    } else {
      fieldsQueueEl.hidden = true;
      excelStep.hidden = false;
    }
  }

  fieldForm.addEventListener('submit', (e) => {
    e.preventDefault();
    resolveCurrentField(fieldValueInput.value);
  });
  fieldSkipBtn.addEventListener('click', () => resolveCurrentField(''));

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
      excelPath: excelPath || undefined
    };

    try {
      const res = await fetch('/api/ocr/finalize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Scyzoryk-Request': '1' },
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) throw new Error(data?.message || 'Nie udało się zapisać plików.');

      setStatus('Gotowe.', 100);
      statusBox.hidden = true;
      fieldsPanel.hidden = true;
      resultsPanel.hidden = false;
      renderResults(data.results);
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
      if (item.excelRow) meta.push('dopisano wiersz do Excela');
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
})();
