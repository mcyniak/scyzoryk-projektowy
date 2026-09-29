function friendlyErrorMessage(message){
  const text = String((message && message.message) || message || '');
  if (/archiver|zip/i.test(text)) return 'Nie udało się utworzyć paczki ZIP z wynikami.';
  if (window.ScyzorykUI) {
    const friendly = window.ScyzorykUI.friendlyError(text);
    if (friendly !== text) return friendly;
  }
  return text || 'Wystąpił błąd podczas generowania.';
}
const P = (n, a, b, c) => window.ScyzorykUI ? window.ScyzorykUI.plural(n, a, b, c) : `${n} ${c}`;
const JOB_STATUS_PL = { queued: 'w kolejce', running: 'przetwarzanie', cancelling: 'przerywanie', finished: 'gotowe', 'finished-with-errors': 'gotowe z błędami', cancelled: 'przerwane', 'fatal-error': 'błąd', interrupted: 'przerwane' };


// Wspolny powrot do panelu glownego w tej samej karcie.
const scyzorykMainPanelHost = location.hostname === 'scyzoryk.localhost' ? 'scyzoryk.localhost' : '127.0.0.1';
const scyzorykMainPanelUrl = `http://${scyzorykMainPanelHost}:3000`;
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
    const dateModeFullEl = $('#dateModeFull');
    const dateModeMonthEl = $('#dateModeMonth');
    const dateModeNoneEl = $('#dateModeNone');
    const dateHint = $('#dateHint');
    const monthYearFields = $('#monthYearFields');
    const monthNumInput = $('#monthNum');
    const yearNumInput = $('#yearNum');
    dateInput.value = today.toISOString().slice(0,10);

    function pad2(n) { return String(n).padStart(2, '0'); }

    function currentDateMode() {
      if (dateModeNoneEl.checked) return 'none';
      if (dateModeMonthEl.checked) return 'month';
      return 'full';
    }

    // Osobne pola liczbowe na miesiac/rok (zamiast natywnego <input type=month>),
    // zeby na kazdym systemie/przegladarce miesiac zawsze byl liczba, a nie
    // nazwa slowna z natywnego kalendarza (np. "lipiec" w polskiej lokalizacji).
    // Trzeci tryb "Bez daty" (zadana funkcja): zaden dokument nie ma "daty
    // dokumentacji powykonawczej" wymyslonej z powietrza - convert-wm.ps1's
    // Replace-AllDates przy pustym DateText usuwa znalezione daty razem z
    // poprzedzajacym slowem "dnia"/"dn." (real bug 2026-09-16: wczesniej po
    // cichu NIC nie robila, wiec oryginalna data zostawala w dokumencie -
    // dokladnie odwrotnie niz zaklada ta etykieta). Wystarczy tu wyslac pusta
    // wartosc (patrz dateValidation.js#normalizeDate, opcja allowEmpty).
    function setDateMode(mode) {
      if (mode === 'none') {
        dateInput.hidden = true;
        dateInput.required = false;
        monthYearFields.style.display = 'none';
        dateHint.textContent = 'Data zostanie całkowicie usunięta z dokumentu (razem ze słowem "dnia"/"dn.") - zostaje sama nazwa miejscowości.';
      } else if (mode === 'month') {
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

    [dateModeFullEl, dateModeMonthEl, dateModeNoneEl].forEach(el => el.addEventListener('change', () => setDateMode(currentDateMode())));

    function getDateValue() {
      const mode = currentDateMode();
      if (mode === 'none') return { noDate: true, value: '' };
      if (mode === 'month') {
        const month = Number(monthNumInput.value);
        const year = Number(yearNumInput.value);
        if (!month || month < 1 || month > 12 || !year) return { noDate: false, value: '' };
        return { noDate: false, value: `${year}-${pad2(month)}` };
      }
      return { noDate: false, value: dateInput.value };
    }

    function showStatus(text, type='') {
      statusBox.hidden = false;
      statusBox.className = 'status ' + type;
      statusBox.textContent = text;
    }

    function updateSubmitText() {
      const count = selectedFiles.length;
      submitBtn.textContent = count ? `Utwórz ${P(count, 'PDF', 'PDF-y', 'PDF-ów')}` : 'Utwórz PDF-y';
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
      if (skipped) showStatus(`Dodano ${P(added, 'plik', 'pliki', 'plików')}, pominięto duplikaty: ${skipped}.`, '');
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
      setDateMode('full');
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
      const dateResult = getDateValue();
      if (!dateResult.noDate && !dateResult.value) return showStatus('Wpisz poprawną datę (albo miesiąc i rok), albo wybierz "Bez daty".', 'err');
      files.forEach(f => f._state = 'w kolejce');
      renderFiles();
      const fd = new FormData();
      files.forEach(f => fd.append('files', f));
      fd.append('date', dateResult.value);
      fd.append('noDate', dateResult.noDate ? 'true' : 'false');
      fd.append('prefix', $('#prefix').value);
      const saveDocxEl = $('#saveDocx');
      fd.append('saveDocx', saveDocxEl && saveDocxEl.checked ? 'true' : 'false');
      submitBtn.disabled = true;
      resultBox.innerHTML = '';
      showStatus(`Przygotowuję ${P(files.length, 'plik', 'pliki', 'plików')}. Pliki są przerabiane po kolei, więc większa paczka może potrwać.`, '');
      try {
        const res = await fetch('/api/jobs', { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' }, body: fd });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.message || 'Nie udało się wygenerować PDF-ów.');
        activeJobId = data.jobId;
        $('#cancelJob').hidden = false;
        showStatus('Zadanie czeka w kolejce.', '');
        await pollManualJob();
        if (activeJobId) manualPollTimer = setInterval(pollManualJob, 1200);
      } catch (err) {
        selectedFiles.forEach(f => f._state = 'błąd');
        renderFiles();
        showStatus(friendlyErrorMessage(err) || 'Błąd generowania.', 'err');
      } finally {
        if (!activeJobId) submitBtn.disabled = false;
      }
    });

    let manualJobStartedAt = 0;
    let manualPollFailures = 0;
    async function pollManualJob() {
      if (!activeJobId) return;
      if (!manualJobStartedAt) manualJobStartedAt = Date.now();
      let res;
      try {
        res = await fetch(`/api/jobs/${activeJobId}`);
        manualPollFailures = 0;
      } catch (err) {
        manualPollFailures += 1;
        if (manualPollFailures >= 5) {
          stopManualPolling();
          showStatus('Brak połączenia z narzędziem - generowanie mogło zostać przerwane. Uruchom Scyzoryka i spróbuj ponownie.', 'err');
        }
        return;
      }
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
      const elapsed = Math.round((Date.now() - manualJobStartedAt) / 1000);
      const elapsedText = elapsed >= 60 ? `${Math.floor(elapsed / 60)} min ${elapsed % 60} s` : `${elapsed} s`;
      showStatus(`Stan: ${JOB_STATUS_PL[job.status] || job.status} · gotowe ${job.done || 0} z ${job.total || 0} · trwa ${elapsedText}.`, '');
      if (job.status === 'interrupted') {
        stopManualPolling();
        showStatus('Zadanie zostało przerwane przez restart panelu. Uruchom je ponownie.', 'err');
        return;
      }
      if (!['finished', 'finished-with-errors', 'cancelled', 'fatal-error'].includes(job.status)) return;
      stopManualPolling();
      manualJobStartedAt = 0;
      if (job.status === 'cancelled') return showStatus('Generowanie zostało przerwane.', '');
      if (job.status === 'fatal-error') return showStatus(friendlyErrorMessage(job.error) || 'Generowanie nie powiodło się.', 'err');

      const failedList = job.failed || [];
      const failedText = failedList.map(x => String(x.input || x.error || '')).join(' ');
      selectedFiles.forEach(f => { f._state = failedText.includes(f.name) ? 'błąd' : 'gotowe'; });
      renderFiles();
      showStatus(`Gotowe. Utworzono ${P((job.files || []).length, 'plik', 'pliki', 'plików')}.${failedList.length ? ` Nieudane: ${failedList.length} - popraw je i kliknij „Utwórz” ponownie (gotowe pliki zostały usunięte z listy).` : ''}`, job.status === 'finished-with-errors' ? '' : 'ok');
      // Na liscie zostaja tylko pliki z bledem - ponowne "Utworz" nie przerabia
      // juz gotowych (wczesniej trzeba bylo usuwac je recznie).
      if (failedList.length) {
        selectedFiles = selectedFiles.filter(f => f._state === 'błąd');
        renderFiles();
        updateSubmitText();
      }
      const failed = failedList.length ? `<p class="status err">Niektóre pliki miały błąd: ${escapeHtml(failedList.map(x => x.error).join(' | '))}</p>` : '';
      // Przy zipUrl DOCX-y sa juz w srodku ZIP-a (leza w tym samym pdfDir co
      // PDF-y, patrz server.js) - osobny link "Pobierz DOCX" ma sens tylko przy
      // pojedynczych plikach (bez ZIP-a, patrz warunek okFiles.length>1 w server.js).
      const anyDocx = (job.files || []).some(item => item.docxUrl);
      const downloadsHtml = job.zipUrl
        ? `<a class="button primary" href="${job.zipUrl}">Pobierz ZIP z ${anyDocx ? 'wynikami' : 'PDF-ami'}</a>`
        : (job.files || []).map(item => `<a class="button primary" href="${escapeHtml(item.url)}">Pobierz ${escapeHtml(item.file)}</a>`
            + (item.docxUrl ? ` <a class="button secondary" href="${escapeHtml(item.docxUrl)}">Pobierz ${escapeHtml(item.docx)}</a>` : '')).join('');
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
    const wmFolderDateModeFullEl = $('#wmFolderDateModeFull');
    const wmFolderDateModeMonthEl = $('#wmFolderDateModeMonth');
    const wmFolderDateModeNoneEl = $('#wmFolderDateModeNone');
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
    const wmAmbiguousBlock = $('#wmAmbiguousBlock');
    const wmAmbiguousList = $('#wmAmbiguousList');
    const wmConvertBtn = $('#wmConvertBtn');
    const wmConvertStatus = $('#wmConvertStatus');
    const wmConvertResult = $('#wmConvertResult');
    wmFolderDateInput.value = today.toISOString().slice(0, 10);
    let wmScanItems = [];
    // Audyt rozdz. 13, P0/P1: /api/wm-folder/convert teraz wymaga tokena z
    // ostatniego /api/wm-folder/scan - bez niego serwer odrzuca konwersje
    // (patrz containment check w server.js).
    let wmScanToken = null;

    function currentWmFolderDateMode() {
      if (wmFolderDateModeNoneEl.checked) return 'none';
      if (wmFolderDateModeMonthEl.checked) return 'month';
      return 'full';
    }

    function setWmFolderDateMode(mode) {
      if (mode === 'none') {
        wmFolderDateInput.hidden = true;
        wmFolderDateInput.required = false;
        wmFolderMonthYearFields.style.display = 'none';
        wmFolderDateHint.textContent = 'Data zostanie całkowicie usunięta z dokumentu (razem ze słowem "dnia"/"dn.") - zostaje sama nazwa miejscowości.';
      } else if (mode === 'month') {
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
    [wmFolderDateModeFullEl, wmFolderDateModeMonthEl, wmFolderDateModeNoneEl].forEach(el => el.addEventListener('change', () => setWmFolderDateMode(currentWmFolderDateMode())));

    function getWmFolderDateValue() {
      const mode = currentWmFolderDateMode();
      if (mode === 'none') return { noDate: true, value: '' };
      if (mode === 'month') {
        const month = Number(wmFolderMonthNumInput.value);
        const year = Number(wmFolderYearNumInput.value);
        if (!month || month < 1 || month > 12 || !year) return { noDate: false, value: '' };
        return { noDate: false, value: `${year}-${pad2(month)}` };
      }
      return { noDate: false, value: wmFolderDateInput.value };
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
          : item.status === 'wieloznaczne'
            ? `kilka pasujących plików: ${escapeHtml([...(item.sourceDocxCandidates || []), ...(item.existingDokPodCandidates || [])].join(', '))} - usuń/zmień nazwę zbędnego, żeby dopasowanie było jednoznaczne`
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
        wmScanToken = data.scanToken || null;
        const toConvert = wmScanItems.filter(i => i.status === 'do-przerobienia');
        const already = wmScanItems.filter(i => i.status === 'juz-istnieje');
        const missing = wmScanItems.filter(i => i.status === 'brak-docx');
        const ambiguous = wmScanItems.filter(i => i.status === 'wieloznaczne');

        if (!wmScanItems.length) {
          showWmScanStatus(`Nie znaleziono żadnego podfolderu z plikiem "WM ..." w: ${folderPath}`, 'err');
          return;
        }
        wmResultsHint.textContent = `Znaleziono ${P(data.categoriesFound, 'kategorię', 'kategorie', 'kategorii')} WM, do przerobienia: ${toConvert.length}.`;
        wmToConvertList.innerHTML = toConvert.length
          ? toConvert.map(i => renderWmRow(i, { withCheckbox: true })).join('')
          : '<div class="empty">Brak nowych kategorii do przerobienia - wszystkie mają już wersję powykonawczą albo brakuje pliku źródłowego.</div>';
        wmAlreadyBlock.hidden = !already.length;
        wmAlreadyList.innerHTML = already.map(i => renderWmRow(i, { withCheckbox: false })).join('');
        wmMissingBlock.hidden = !missing.length;
        wmMissingList.innerHTML = missing.map(i => renderWmRow(i, { withCheckbox: false })).join('');
        wmAmbiguousBlock.hidden = !ambiguous.length;
        wmAmbiguousList.innerHTML = ambiguous.map(i => renderWmRow(i, { withCheckbox: false })).join('');
        wmResultsCard.hidden = false;
        wmConvertBtn.disabled = !toConvert.length;
        showWmScanStatus(`Gotowe. Znaleziono ${P(data.categoriesFound, 'kategorię', 'kategorie', 'kategorii')}.`, 'ok');
      } catch (err) {
        showWmScanStatus(friendlyErrorMessage(err) || 'Błąd skanowania folderu.', 'err');
      } finally {
        wmScanBtn.disabled = false;
      }
    });

    wmConvertBtn.addEventListener('click', async () => {
      const dateResult = getWmFolderDateValue();
      if (!dateResult.noDate && !dateResult.value) return showWmConvertStatus('Wpisz poprawną datę (albo miesiąc i rok), albo wybierz "Bez daty".', 'err');
      const checked = [...wmToConvertList.querySelectorAll('[data-wm-check]:checked')]
        .map(el => el.dataset.wmCheck);
      const items = wmScanItems.filter(i => i.status === 'do-przerobienia' && checked.includes(i.sourcePath));
      if (!items.length) return showWmConvertStatus('Zaznacz przynajmniej jedną kategorię do przerobienia.', 'err');

      // Audyt UX 2026-08-21: ten tryb zapisuje PDF-y wprost w prawdziwych
      // folderach klienta (czesto na dysku sieciowym), bez zadnego kroku
      // pobierania/przegladu - jedyne takie miejsce w tym repo bez
      // potwierdzenia, w odroznieniu np. od tworzenie-folderow.
      if (!confirm(`Przerobić ${P(items.length, 'kategorię', 'kategorie', 'kategorii')} i zapisać PDF-y bezpośrednio w folderach klientów? Tej operacji nie da się cofnąć.`)) return;

      wmConvertBtn.disabled = true;
      wmConvertResult.innerHTML = '';
      showWmConvertStatus(`Przerabiam ${P(items.length, 'kategorię', 'kategorie', 'kategorii')} i zapisuję w folderach...`, '');
      try {
        const res = await fetch('/api/wm-folder/convert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Scyzoryk-Request': '1' },
          body: JSON.stringify({
            items: items.map(i => ({ sourcePath: i.sourcePath, folderPath: i.folderPath, category: i.category })),
            date: dateResult.value,
            noDate: dateResult.noDate ? 'true' : 'false',
            prefix: wmFolderPrefixInput.value,
            saveDocx: $('#wmFolderSaveDocx')?.checked ? 'true' : 'false',
            scanToken: wmScanToken
          })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.message || 'Nie udało się przerobić dokumentów.');
        startWmFolderPolling(data.jobId, data.total || items.length);
      } catch (err) {
        showWmConvertStatus(friendlyErrorMessage(err) || 'Błąd przerabiania dokumentów.', 'err');
        wmConvertBtn.disabled = false;
      }
    });

    // Przerabianie w folderach dziala jako zadanie w tle (przeglad 2026-09-29):
    // postep z czasem trwania, przycisk "Przerwij", a po odswiezeniu strony
    // wynik nie ginie (id zadania w sessionStorage).
    const WM_FOLDER_JOB_KEY = 'wnioski.wmFolderJob';
    let wmFolderPollTimer = null;
    let wmFolderCancelBtn = null;
    function ensureWmFolderCancelBtn() {
      if (wmFolderCancelBtn) return wmFolderCancelBtn;
      wmFolderCancelBtn = document.createElement('button');
      wmFolderCancelBtn.type = 'button';
      wmFolderCancelBtn.className = 'button';
      wmFolderCancelBtn.textContent = 'Przerwij';
      wmFolderCancelBtn.hidden = true;
      wmConvertBtn.insertAdjacentElement('afterend', wmFolderCancelBtn);
      wmFolderCancelBtn.addEventListener('click', async () => {
        const jobId = sessionStorage.getItem(WM_FOLDER_JOB_KEY);
        if (!jobId) return;
        if (!confirm('Przerwać przerabianie? Pliki już zapisane w folderach klientów zostaną.')) return;
        wmFolderCancelBtn.disabled = true;
        await fetch(`/api/wm-folder/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' } }).catch(() => {});
      });
      return wmFolderCancelBtn;
    }
    function stopWmFolderPolling() {
      if (wmFolderPollTimer) clearInterval(wmFolderPollTimer);
      wmFolderPollTimer = null;
      try { sessionStorage.removeItem(WM_FOLDER_JOB_KEY); } catch (_) {}
      wmConvertBtn.disabled = false;
      if (wmFolderCancelBtn) { wmFolderCancelBtn.hidden = true; wmFolderCancelBtn.disabled = false; }
    }
    function startWmFolderPolling(jobId, total) {
      try { sessionStorage.setItem(WM_FOLDER_JOB_KEY, jobId); } catch (_) {}
      wmConvertBtn.disabled = true;
      ensureWmFolderCancelBtn().hidden = false;
      let failures = 0;
      const tick = async () => {
        let data;
        try {
          const res = await fetch(`/api/wm-folder/jobs/${encodeURIComponent(jobId)}`);
          data = await res.json().catch(() => ({}));
          if (res.status === 404) { stopWmFolderPolling(); return showWmConvertStatus(data.message || 'Zadanie wygasło - sprawdź pliki w folderach klientów.', 'err'); }
          failures = 0;
        } catch (err) {
          if (++failures >= 5) { stopWmFolderPolling(); showWmConvertStatus('Brak połączenia z narzędziem - przerabianie mogło zostać przerwane. Sprawdź pliki w folderach klientów.', 'err'); }
          return;
        }
        const job = data.job || {};
        const since = job.startedAt || job.createdAt || Date.now();
        const secs = Math.max(0, Math.round((Date.now() - since) / 1000));
        const elapsed = secs >= 60 ? `${Math.floor(secs / 60)} min ${secs % 60} s` : `${secs} s`;
        if (job.status === 'queued') return showWmConvertStatus('Czekam w kolejce (inne zadanie przerabia dokumenty)...', '');
        if (job.status === 'running') return showWmConvertStatus(`Przerabiam ${P(job.total || total, 'kategorię', 'kategorie', 'kategorii')} i zapisuję w folderach... trwa ${elapsed}. Możesz przerwać przyciskiem obok.`, '');
        stopWmFolderPolling();
        if (job.status === 'cancelled') return showWmConvertStatus('Przerwano. Pliki zapisane przed przerwaniem zostały w folderach klientów.', '');
        if (job.status === 'fatal-error') return showWmConvertStatus(friendlyErrorMessage(job.error) || 'Nie udało się przerobić dokumentów.', 'err');
        const result = job.result || {};
        const failedList = result.failed || [];
        showWmConvertStatus(`Gotowe. Utworzono i zapisano w folderach: ${result.created || 0}.${failedList.length ? ` Nieudane: ${failedList.length}.` : ''}`, failedList.length ? '' : 'ok');
        const okLines = (result.files || []).map(f => `<div class="row ok"><div class="grow">${escapeHtml(f.category)}<small>${escapeHtml(f.file)}${f.docx ? ` + ${escapeHtml(f.docx)}` : ''}</small></div></div>`).join('');
        const failLines = failedList.map(f => `<div class="row err"><div class="grow">${escapeHtml(f.category)}<small>${escapeHtml(f.error)}</small></div></div>`).join('');
        // Tryb folderowy zapisuje pliki bezposrednio w docelowych folderach -
        // nie ma tu przyciskow pobierania do bramkowania (patrz komentarz przy
        // renderChangesSummary), wiec uzywamy samego .html, zawsze rozwinietego.
        wmConvertResult.innerHTML = `<div class="list">${okLines}${failLines}</div>${renderChangesSummary(result.files || []).html}`;
      };
      if (wmFolderPollTimer) clearInterval(wmFolderPollTimer);
      tick();
      wmFolderPollTimer = setInterval(tick, 1500);
    }
    try {
      const pendingWmJob = sessionStorage.getItem(WM_FOLDER_JOB_KEY);
      if (pendingWmJob) startWmFolderPolling(pendingWmJob, 0);
    } catch (_) {}
