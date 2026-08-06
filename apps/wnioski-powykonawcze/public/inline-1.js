function friendlyErrorMessage(message){
  const text = String(message || '');
  if (/archiver|zip/i.test(text)) return 'Nie udało się utworzyć paczki ZIP z wynikami.';
  if (/PowerShell|WINWORD|Word/i.test(text)) return 'Nie udało się przygotować dokumentu w Wordzie.';
  return text || 'Wystąpił błąd podczas generowania.';
}


// Wspolny powrot do panelu glownego w tej samej karcie.
const scyzorykMainPanelUrl = 'http://scyzoryk.localhost:3000';
document.querySelectorAll('[data-main-link]').forEach(link => { link.href = scyzorykMainPanelUrl; link.removeAttribute('target'); });

const $ = s => document.querySelector(s);
    const filesInput = $('#files');
    const fileList = $('#fileList');
    const statusBox = $('#status');
    const resultBox = $('#result');
    const submitBtn = $('#submit');
    const form = $('#form');
    const today = new Date();
    let selectedFiles = [];
    let lastFailedKeys = new Set();
    let activeJobId = null;
    let manualPollTimer = null;
    const dateInput = $('#date');
    const monthOnlyEl = $('#monthOnly');
    const dateHint = $('#dateHint');
    const monthYearFields = $('#monthYearFields');
    const monthNumInput = $('#monthNum');
    const yearNumInput = $('#yearNum');
    dateInput.value = today.toISOString().slice(0,10);

    function pad2(n) { return String(n).padStart(2, '0'); }

    // Osobne pola liczbowe na miesiac/rok (zamiast natywnego <input type=month>),
    // zeby na kazdym systemie/przegladarce miesiac zawsze byl liczba, a nie
    // nazwa slowna z natywnego kalendarza (np. "lipiec" w polskiej lokalizacji).
    function setDateMode(monthOnly) {
      if (monthOnly) {
        dateInput.hidden = true;
        dateInput.required = false;
        monthYearFields.style.display = '';
        if (!monthNumInput.value) monthNumInput.value = today.getMonth() + 1;
        if (!yearNumInput.value) yearNumInput.value = today.getFullYear();
        dateHint.textContent = 'Wpisujesz tylko miesiąc i rok (liczbowo) - dzień zostanie pominięty we wszystkich dokumentach.';
      } else {
        dateInput.hidden = false;
        dateInput.required = true;
        monthYearFields.style.display = 'none';
        dateHint.textContent = 'Ta sama data trafi do wszystkich miejsc w dokumentach.';
      }
    }

    monthOnlyEl.addEventListener('change', () => setDateMode(monthOnlyEl.checked));

    function getDateValue() {
      if (!monthOnlyEl.checked) return dateInput.value;
      const month = Number(monthNumInput.value);
      const year = Number(yearNumInput.value);
      if (!month || month < 1 || month > 12 || !year) return '';
      return `${year}-${pad2(month)}`;
    }

    function showStatus(text, type='') {
      statusBox.hidden = false;
      statusBox.className = 'status ' + type;
      statusBox.textContent = text;
    }

    function updateSubmitText() {
      const count = selectedFiles.length;
      submitBtn.textContent = count === 1 ? 'Utwórz 1 PDF' : count ? `Utwórz ${count} PDF-y` : 'Utwórz PDF-y';
    }

    function fileKey(f){ return `${f.name}|${f.size}|${f.lastModified}`; }
    function addFiles(fileListLike) {
      const incoming = [...fileListLike].filter(f => /\.docx$/i.test(f.name));
      if (!incoming.length) {
        showStatus('Wybierz pliki DOCX / Word.', 'err');
        return;
      }
      const existing = new Set(selectedFiles.map(fileKey));
      let added = 0;
      let skipped = 0;
      for (const file of incoming) {
        const key = fileKey(file);
        if (existing.has(key)) { skipped += 1; continue; }
        file._state = 'czeka';
        selectedFiles.push(file);
        existing.add(key);
        added += 1;
      }
      if (skipped) showStatus(`Dodano ${added} plików, pominięto duplikaty: ${skipped}.`, '');
      else statusBox.hidden = true;
      resultBox.innerHTML = '';
      renderFiles();
    }

    function removeFile(index) {
      selectedFiles.splice(index, 1);
      renderFiles();
    }

    function renderFiles() {
      if (!selectedFiles.length) {
        fileList.innerHTML = '<div class="empty">Nie dodano jeszcze plików.</div>';
        updateSubmitText();
        return;
      }
      fileList.innerHTML = selectedFiles.map((f, i) => `
        <div class="row ${f._state === 'gotowe' ? 'ok' : f._state === 'błąd' ? 'err' : ''}">
          <span>${i+1}.</span>
          <div class="grow">${escapeHtml(f.name)}<small>${(f.size/1024/1024).toFixed(2)} MB</small></div>
          <span class="file-state">${escapeHtml(f._state || 'czeka')}</span>
          <button class="remove" type="button" data-remove="${i}" title="Usuń ten plik">Usuń</button>
        </div>
      `).join('');
      fileList.querySelectorAll('[data-remove]').forEach(btn => {
        btn.addEventListener('click', () => removeFile(Number(btn.dataset.remove)));
      });
      updateSubmitText();
    }

    function escapeHtml(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}

    filesInput.addEventListener('change', () => {
      addFiles(filesInput.files);
      filesInput.value = '';
    });

    $('#clear').addEventListener('click', () => {
      selectedFiles = [];
      lastFailedKeys = new Set();
      filesInput.value = '';
      form.reset();
      monthOnlyEl.checked = false;
      setDateMode(false);
      $('#prefix').value='WM dok.pod';
      fileList.innerHTML='<div class="empty">Nie dodano jeszcze plików.</div>';
      statusBox.hidden=true;
      resultBox.innerHTML='';
      updateSubmitText();
    });

    const drop = $('#drop');
    ['dragenter','dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.style.background='#fff1f2'; }));
    ['dragleave','drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.style.background='#fff8f8'; }));
    drop.addEventListener('drop', e => {
      addFiles(e.dataTransfer.files);
    });

    form.addEventListener('submit', async e => {
      e.preventDefault();
      const files = selectedFiles;
      if (!files.length) return showStatus('Dodaj przynajmniej jeden plik DOCX.', 'err');
      const dateValue = getDateValue();
      if (!dateValue) return showStatus('Wpisz poprawną datę (albo miesiąc i rok).', 'err');
      files.forEach(f => f._state = 'w kolejce');
      renderFiles();
      const fd = new FormData();
      files.forEach(f => fd.append('files', f));
      fd.append('date', dateValue);
      fd.append('prefix', $('#prefix').value);
      const saveDocxEl = $('#saveDocx');
      const visibleWordEl = $('#visibleWord');
      fd.append('saveDocx', saveDocxEl && saveDocxEl.checked ? 'true' : 'false');
      fd.append('visibleWord', visibleWordEl && visibleWordEl.checked ? 'true' : 'false');
      submitBtn.disabled = true;
      resultBox.innerHTML = '';
      showStatus(`Przygotowuję ${files.length} plików w Wordzie. Word działa pojedynczo, więc większa paczka może potrwać.`, '');
      try {
        const res = await fetch('/api/jobs', { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' }, body: fd });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.message || 'Nie udało się wygenerować PDF-ów.');
        activeJobId = data.jobId;
        $('#cancelJob').hidden = false;
        showStatus('Zadanie czeka w kolejce Word.', '');
        await pollManualJob();
        if (activeJobId) manualPollTimer = setInterval(pollManualJob, 1200);
      } catch (err) {
        selectedFiles.forEach(f => f._state = 'błąd');
        renderFiles();
        showStatus(err.message || 'Błąd generowania.', 'err');
      } finally {
        if (!activeJobId) submitBtn.disabled = false;
      }
    });

    async function pollManualJob() {
      if (!activeJobId) return;
      const res = await fetch(`/api/jobs/${activeJobId}`);
      if (res.status === 404) {
        stopManualPolling();
        showStatus('Zadanie nie istnieje (prawdopodobnie restart panelu). Uruchom je ponownie.', 'err');
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        stopManualPolling();
        showStatus(data.message || 'Nie udało się odczytać statusu zadania.', 'err');
        return;
      }
      const job = data.job;
      showStatus(`Status: ${job.status}. Gotowe: ${job.done || 0} / ${job.total || 0}.`, '');
      if (job.status === 'interrupted') {
        stopManualPolling();
        showStatus('Zadanie zostało przerwane przez restart panelu. Uruchom je ponownie.', 'err');
        return;
      }
      if (!['finished', 'finished-with-errors', 'cancelled', 'fatal-error'].includes(job.status)) return;
      stopManualPolling();
      if (job.status === 'cancelled') return showStatus('Generowanie zostało przerwane.', '');
      if (job.status === 'fatal-error') return showStatus(job.error || 'Generowanie nie powiodło się.', 'err');

      const failedList = job.failed || [];
      const failedText = failedList.map(x => String(x.input || x.error || '')).join(' ');
      selectedFiles.forEach(f => { f._state = failedText.includes(f.name) ? 'błąd' : 'gotowe'; });
      renderFiles();
      showStatus(`Gotowe. Utworzono PDF-y: ${(job.files || []).length}.`, job.status === 'finished-with-errors' ? '' : 'ok');
      const failed = failedList.length ? `<p class="status err">Niektóre pliki miały błąd: ${escapeHtml(failedList.map(x => x.error).join(' | '))}</p>` : '';
      const downloadsHtml = job.zipUrl
        ? `<a class="button primary" href="${job.zipUrl}">Pobierz ZIP z PDF-ami</a>`
        : (job.files || []).map(item => `<a class="button primary" href="${escapeHtml(item.url)}">Pobierz ${escapeHtml(item.file)}</a>`).join('');
      const summary = renderChangesSummary(job.files || []);

      if (!summary.hasChanges) {
        resultBox.innerHTML = `${failed}${downloadsHtml}`;
        return;
      }

      // Audyt rozdz. 13, P0/P1: gdy jest cokolwiek do sprawdzenia (podmienione
      // daty albo usunieta sekcja), przyciski pobierania NIE renderuja sie od
      // razu - dopiero po jawnym kliknieciu "Rozumiem, pokaż pobieranie".
      // Bez tego bylo latwo pobrac plik obok zwinietego podsumowania, nigdy
      // go nie otwierajac.
      resultBox.innerHTML = `${failed}${summary.html}`
        + `<button type="button" class="button secondary" id="wmConfirmReviewBtn" style="margin-top:10px;">Rozumiem, pokaż pobieranie</button>`;
      $('#wmConfirmReviewBtn').addEventListener('click', () => {
        resultBox.innerHTML = `${failed}${summary.html}${downloadsHtml}`;
      });
    }

    // Widocznosc tego, co skrypt faktycznie zmienil w kazdym dokumencie
    // (audyt v1.0.4, P0-3/P0-4; rozdz. 13 biezacego audytu) - zamiana
    // wszystkich dat na jedna wartosc i usuwanie od markera "ZATWIERDZAM..."
    // do konca dokumentu nadal nie maja bezpiecznej, precyzyjnej granicy
    // (wymaga realnego szablonu WM), wiec dopoki jej nie ma, pokazujemy
    // uzytkownikowi co zostalo zmienione/usuniete. Wczesniej byl to zwiniety
    // <details> obok JUZ aktywnych przyciskow pobierania - latwo bylo pobrac
    // plik bez otwarcia go w ogole. Teraz podsumowanie jest zawsze rozwiniete
    // (nie do przeoczenia), a w trybie recznym (patrz gateDownloadsBehindReview
    // ponizej) przyciski pobierania w ogole nie renderuja sie, dopoki
    // uzytkownik jawnie nie potwierdzi, ze je zobaczyl.
    function renderChangesSummary(files) {
      const withChanges = files.filter(f => f.deletedSection || (f.dateReplacements || []).length);
      if (!withChanges.length) return { html: '', hasChanges: false };
      const rows = withChanges.map(f => {
        const dateLines = (f.dateReplacements || [])
          .map(d => `${escapeHtml(d.from)} → ${escapeHtml(d.to)}`)
          .join(', ');
        const deletionLine = f.deletedSection
          ? `Usunięto sekcję od miejsca zatwierdzenia do końca dokumentu (${f.deletedCharCount} znaków). Podgląd usuniętego fragmentu: „${escapeHtml((f.deletedPreview || '').slice(0, 160))}${(f.deletedPreview || '').length > 160 ? '…' : ''}”`
          : '';
        return `<li><strong>${escapeHtml(f.file)}</strong>`
          + (dateLines ? `<div class="small">Zamienione daty: ${dateLines}</div>` : '')
          + (deletionLine ? `<div class="small">${deletionLine}</div>` : '')
          + `</li>`;
      }).join('');
      const html = `<div class="status" style="margin-top:10px;">`
        + `<div>Sprawdź, co zostało zmienione przed wysłaniem dalej:</div>`
        + `<ul style="margin:8px 0 0;padding-left:20px;font-weight:400;">${rows}</ul>`
        + `</div>`;
      return { html, hasChanges: true };
    }

    function stopManualPolling() {
      if (manualPollTimer) clearInterval(manualPollTimer);
      manualPollTimer = null;
      activeJobId = null;
      submitBtn.disabled = false;
      $('#cancelJob').hidden = true;
    }

    $('#cancelJob').addEventListener('click', async () => {
      if (!activeJobId) return;
      await fetch(`/api/jobs/${activeJobId}/cancel`, { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' } });
      await pollManualJob();
    });
    renderFiles();

    // --- Tryb "caly folder WM": skanowanie + przerobienie w miejscu ---
    const flowManual = $('#flowManual');
    const flowFolder = $('#flowFolder');
    const modeManualBtn = $('#modeManualBtn');
    const modeFolderBtn = $('#modeFolderBtn');

    function setMode(mode) {
      flowManual.classList.toggle('hidden', mode !== 'manual');
      flowFolder.classList.toggle('hidden', mode !== 'folder');
      modeManualBtn.classList.toggle('mode-active', mode === 'manual');
      modeFolderBtn.classList.toggle('mode-active', mode === 'folder');
    }
    modeManualBtn.addEventListener('click', () => setMode('manual'));
    modeFolderBtn.addEventListener('click', () => setMode('folder'));

    const wmFolderPathInput = $('#wmFolderPath');
    const wmFolderDateInput = $('#wmFolderDate');
    const wmFolderMonthOnlyEl = $('#wmFolderMonthOnly');
    const wmFolderDateHint = $('#wmFolderDateHint');
    const wmFolderMonthYearFields = $('#wmFolderMonthYearFields');
    const wmFolderMonthNumInput = $('#wmFolderMonthNum');
    const wmFolderYearNumInput = $('#wmFolderYearNum');
    const wmFolderPrefixInput = $('#wmFolderPrefix');
    const wmScanBtn = $('#wmScanBtn');
    const wmScanStatus = $('#wmScanStatus');
    const wmResultsCard = $('#wmResultsCard');
    const wmResultsHint = $('#wmResultsHint');
    const wmToConvertList = $('#wmToConvertList');
    const wmAlreadyBlock = $('#wmAlreadyBlock');
    const wmAlreadyList = $('#wmAlreadyList');
    const wmMissingBlock = $('#wmMissingBlock');
    const wmMissingList = $('#wmMissingList');
    const wmConvertBtn = $('#wmConvertBtn');
    const wmConvertStatus = $('#wmConvertStatus');
    const wmConvertResult = $('#wmConvertResult');
    wmFolderDateInput.value = today.toISOString().slice(0, 10);
    let wmScanItems = [];

    function setWmFolderDateMode(monthOnly) {
      if (monthOnly) {
        wmFolderDateInput.hidden = true;
        wmFolderDateInput.required = false;
        wmFolderMonthYearFields.style.display = '';
        if (!wmFolderMonthNumInput.value) wmFolderMonthNumInput.value = today.getMonth() + 1;
        if (!wmFolderYearNumInput.value) wmFolderYearNumInput.value = today.getFullYear();
        wmFolderDateHint.textContent = 'Wpisujesz tylko miesiąc i rok (liczbowo) - dzień zostanie pominięty we wszystkich dokumentach.';
      } else {
        wmFolderDateInput.hidden = false;
        wmFolderDateInput.required = true;
        wmFolderMonthYearFields.style.display = 'none';
        wmFolderDateHint.textContent = 'Ta sama data trafi do wszystkich miejsc w dokumentach.';
      }
    }
    wmFolderMonthOnlyEl.addEventListener('change', () => setWmFolderDateMode(wmFolderMonthOnlyEl.checked));

    function getWmFolderDateValue() {
      if (!wmFolderMonthOnlyEl.checked) return wmFolderDateInput.value;
      const month = Number(wmFolderMonthNumInput.value);
      const year = Number(wmFolderYearNumInput.value);
      if (!month || month < 1 || month > 12 || !year) return '';
      return `${year}-${pad2(month)}`;
    }

    function showWmScanStatus(text, type = '') {
      wmScanStatus.hidden = false;
      wmScanStatus.className = 'status ' + type;
      wmScanStatus.textContent = text;
    }
    function showWmConvertStatus(text, type = '') {
      wmConvertStatus.hidden = false;
      wmConvertStatus.className = 'status ' + type;
      wmConvertStatus.textContent = text;
    }

    function renderWmRow(item, { withCheckbox } = { withCheckbox: false }) {
      const check = withCheckbox
        ? `<input type="checkbox" data-wm-check="${escapeHtml(item.sourcePath)}" checked>`
        : '';
      const sub = item.status === 'juz-istnieje'
        ? `już ma: ${escapeHtml(item.existingDokPod || '')}`
        : item.status === 'brak-docx'
          ? 'brak pliku WM ...docx w tym folderze'
          : escapeHtml(item.sourceDocx || '');
      return `
        <div class="row${withCheckbox ? '' : ' muted-row'}">
          ${check}
          <div class="grow">${escapeHtml(item.category)}<small>${sub}</small></div>
        </div>`;
    }

    wmScanBtn.addEventListener('click', async () => {
      const folderPath = wmFolderPathInput.value.trim();
      if (!folderPath) return showWmScanStatus('Podaj ścieżkę folderu WM.', 'err');
      wmResultsCard.hidden = true;
      wmConvertResult.innerHTML = '';
      wmConvertStatus.hidden = true;
      wmScanBtn.disabled = true;
      showWmScanStatus('Skanuję folder...', '');
      try {
        const res = await fetch('/api/wm-folder/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Scyzoryk-Request': '1' },
          body: JSON.stringify({ folderPath })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.message || 'Nie udało się przeskanować folderu.');
        wmScanItems = data.items || [];
        const toConvert = wmScanItems.filter(i => i.status === 'do-przerobienia');
        const already = wmScanItems.filter(i => i.status === 'juz-istnieje');
        const missing = wmScanItems.filter(i => i.status === 'brak-docx');

        if (!wmScanItems.length) {
          showWmScanStatus(`Nie znaleziono żadnego podfolderu z plikiem "WM ..." w: ${folderPath}`, 'err');
          return;
        }
        wmResultsHint.textContent = `Znaleziono ${data.categoriesFound} kategorii WM, do przerobienia: ${toConvert.length}.`;
        wmToConvertList.innerHTML = toConvert.length
          ? toConvert.map(i => renderWmRow(i, { withCheckbox: true })).join('')
          : '<div class="empty">Brak nowych kategorii do przerobienia - wszystkie mają już wersję powykonawczą albo brakuje pliku źródłowego.</div>';
        wmAlreadyBlock.hidden = !already.length;
        wmAlreadyList.innerHTML = already.map(i => renderWmRow(i, { withCheckbox: false })).join('');
        wmMissingBlock.hidden = !missing.length;
        wmMissingList.innerHTML = missing.map(i => renderWmRow(i, { withCheckbox: false })).join('');
        wmResultsCard.hidden = false;
        wmConvertBtn.disabled = !toConvert.length;
        showWmScanStatus(`Gotowe. Znaleziono ${data.categoriesFound} kategorii.`, 'ok');
      } catch (err) {
        showWmScanStatus(err.message || 'Błąd skanowania folderu.', 'err');
      } finally {
        wmScanBtn.disabled = false;
      }
    });

    wmConvertBtn.addEventListener('click', async () => {
      const dateValue = getWmFolderDateValue();
      if (!dateValue) return showWmConvertStatus('Wpisz poprawną datę (albo miesiąc i rok).', 'err');
      const checked = [...wmToConvertList.querySelectorAll('[data-wm-check]:checked')]
        .map(el => el.dataset.wmCheck);
      const items = wmScanItems.filter(i => i.status === 'do-przerobienia' && checked.includes(i.sourcePath));
      if (!items.length) return showWmConvertStatus('Zaznacz przynajmniej jedną kategorię do przerobienia.', 'err');

      wmConvertBtn.disabled = true;
      wmConvertResult.innerHTML = '';
      showWmConvertStatus(`Przerabiam ${items.length} ${items.length === 1 ? 'kategorię' : 'kategorii'} w Wordzie i zapisuję w folderach...`, '');
      try {
        const res = await fetch('/api/wm-folder/convert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Scyzoryk-Request': '1' },
          body: JSON.stringify({
            items: items.map(i => ({ sourcePath: i.sourcePath, folderPath: i.folderPath, category: i.category })),
            date: dateValue,
            prefix: wmFolderPrefixInput.value
          })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.message || 'Nie udało się przerobić dokumentów.');
        const failedList = data.failed || [];
        showWmConvertStatus(`Gotowe. Utworzono i zapisano w folderach: ${data.created}.`, failedList.length ? '' : 'ok');
        const okLines = (data.files || []).map(f => `<div class="row ok"><div class="grow">${escapeHtml(f.category)}<small>${escapeHtml(f.file)}</small></div></div>`).join('');
        const failLines = failedList.map(f => `<div class="row err"><div class="grow">${escapeHtml(f.category)}<small>${escapeHtml(f.error)}</small></div></div>`).join('');
        // Tryb folderowy zapisuje pliki bezposrednio w docelowych folderach -
        // nie ma tu przyciskow pobierania do bramkowania (patrz komentarz przy
        // renderChangesSummary), wiec uzywamy samego .html, zawsze rozwinietego.
        wmConvertResult.innerHTML = `<div class="list">${okLines}${failLines}</div>${renderChangesSummary(data.files || []).html}`;
      } catch (err) {
        showWmConvertStatus(err.message || 'Błąd przerabiania dokumentów.', 'err');
      } finally {
        wmConvertBtn.disabled = false;
      }
    });
