let activeJob = null;
    let pollTimer = null;
    let cancelRequested = false;
    let lastPdfDir = '';
    let previewRecords = [];
    let selectedRows = new Set();

    loadSettings();

    document.querySelector('#scrollHelp')?.addEventListener('click', () => document.querySelector('#saveHelp')?.scrollIntoView({ behavior: 'smooth', block: 'center' }));

    // Swiadomie BEZ auto-sprawdzania na 'change' pliku/lokalizacji (bylo:
    // sprawdzanie odpalalo sie natychmiast po wybraniu pliku, zanim
    // uzytkownik zdazyl np. wpisac/wyczyscic globalna lokalizacje) - teraz
    // wylacznie na klikniecie #checkAddresses albo #reloadPreview, ten sam
    // wzorzec co "Sprawdz tabele" w karty-katalogowe.
    document.querySelector('#checkAddresses').addEventListener('click', () => loadAddressPreview());
    document.querySelector('#reloadPreview').addEventListener('click', () => loadAddressPreview());
    document.querySelector('#addressSearch').addEventListener('input', () => renderAddressRows());
    document.querySelector('#selectAllRecords').addEventListener('click', () => { selectedRows = new Set(previewRecords.map(row => row.rowNumber)); renderAddressRows(); });
    document.querySelector('#clearRecords').addEventListener('click', () => { selectedRows = new Set(); renderAddressRows(); });
    document.querySelector('#selectVisibleRecords')?.addEventListener('click', () => {
      const visible = filteredPreviewRecords();
      visible.forEach(row => selectedRows.add(row.rowNumber));
      renderAddressRows();
    });
    document.querySelector('#addressRows').addEventListener('click', (event) => {
      const row = event.target.closest('[data-row-number]');
      if (!row) return;
      const rowNumber = Number(row.dataset.rowNumber);
      if (!Number.isInteger(rowNumber)) return;
      if (event.target.matches('input[type="checkbox"]')) {
        if (event.target.checked) selectedRows.add(rowNumber); else selectedRows.delete(rowNumber);
      } else {
        if (selectedRows.has(rowNumber)) selectedRows.delete(rowNumber); else selectedRows.add(rowNumber);
      }
      renderAddressRows();
    });

    document.querySelector('#saveSettings')?.addEventListener('click', () => {
      saveSettings();
      alert('Ustawienia zapisane w tej przeglądarce.');
    });

    document.querySelector('#batchForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      saveSettings();

      const file = document.querySelector('#excelFile').files && document.querySelector('#excelFile').files[0];
      const fileCheck = validateExcelChoice(file);
      if (!fileCheck.ok) {
        showAddressLoadProblem(fileCheck.message);
        alert(fileCheck.message);
        return;
      }

      const data = new FormData(form);
      data.set('skipExisting', form.skipExisting.checked ? 'true' : 'false');
      data.set('concurrency', form.concurrency.value || '1');
      const chosenRows = previewRecords.length ? Array.from(selectedRows).sort((a, b) => a - b) : [];
      if (previewRecords.length && !chosenRows.length) {
        alert('Nie zaznaczono żadnego adresu. Zaznacz minimum jeden adres do wygenerowania.');
        return;
      }
      data.set('selectedRows', JSON.stringify(chosenRows));
      document.querySelector('#selectedRowsInput').value = JSON.stringify(chosenRows);

      const countText = previewRecords.length ? `${chosenRows.length} wybranych raportów` : 'raportów z Excela';
      if (!confirm(`Uruchomić generowanie ${countText}? Wyniki zostaną zapisane w bezpiecznym folderze zadania.`)) return;

      document.querySelector('#startBatch').disabled = true;
      cancelRequested = false;
      lastPdfDir = '';
      document.querySelector('#cancelBatch').disabled = false;
      document.querySelector('#cancelBatch').textContent = 'Przerwij generowanie';
      document.querySelector('#downloadZip').classList.add('hidden');
      document.querySelector('#downloadZip').href = '#';
      document.querySelector('#statusBox').classList.remove('hidden');
      document.querySelector('#finishInfo').textContent = 'Zadanie jest w toku.';
      document.querySelector('#previewRows').innerHTML = '';
      document.querySelector('#statusBox').scrollIntoView({ behavior: 'smooth', block: 'start' });

      const res = await fetch('/api/batch/start', { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' }, body: data });
      const json = await res.json();
      if (!json.ok) {
        alert(json.error || 'Nie udało się uruchomić zadania.');
        document.querySelector('#startBatch').disabled = false;
        document.querySelector('#cancelBatch').disabled = true;
        return;
      }

      activeJob = json.jobId;
      pollStatus();
      pollTimer = setInterval(pollStatus, 1500);
    });


    function isRealExcelFile(file) {
      const name = String(file?.name || '').toLowerCase();
      return /\.xlsx$/.test(name);
    }

    function isGoogleSheetShortcut(file) {
      const name = String(file?.name || '').toLowerCase();
      return name.endsWith('.gsheet');
    }

    function showAddressLoadProblem(message) {
      const selector = document.querySelector('#recordSelector');
      selector.classList.remove('hidden');
      previewRecords = [];
      selectedRows = new Set();
      document.querySelector('#selectorInfo').textContent = message;
      document.querySelector('#addressRows').innerHTML = '<tr><td colspan="5">' + escapeHtml(message) + '</td></tr>';
      updateSelectedSummary();
    }

    function validateExcelChoice(file) {
      if (!file) return { ok: false, message: 'Nie wybrano pliku Excel.' };
      if (isGoogleSheetShortcut(file)) {
        return {
          ok: false,
          message: 'Wybrano plik .gsheet, czyli skrót do Google Sheets, a nie prawdziwy Excel. Otwórz ten arkusz w Google Sheets i wybierz: Plik → Pobierz → Microsoft Excel (.xlsx), a potem wskaż pobrany plik .xlsx.'
        };
      }
      if (!isRealExcelFile(file)) {
        return { ok: false, message: 'Wybrany plik nie jest Excelem. Wybierz plik z końcówką .xlsx.' };
      }
      return { ok: true };
    }


    async function loadAddressPreview() {
      const fileInput = document.querySelector('#excelFile');
      const file = fileInput.files && fileInput.files[0];
      const selector = document.querySelector('#recordSelector');
      if (!file) {
        previewRecords = [];
        selectedRows = new Set();
        selector.classList.add('hidden');
        updateSelectedSummary();
        return;
      }

      const fileCheck = validateExcelChoice(file);
      if (!fileCheck.ok) {
        showAddressLoadProblem(fileCheck.message);
        return;
      }

      selector.classList.remove('hidden');
      document.querySelector('#selectorInfo').textContent = 'Wczytuję adresy z Excela...';
      document.querySelector('#addressRows').innerHTML = '<tr><td colspan="5">Wczytuję...</td></tr>';

      const data = new FormData();
      data.append('excel', file);
      data.append('location', document.querySelector('#location').value || '');

      try {
        const res = await fetch('/api/batch/preview', { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' }, body: data });
        const json = await res.json();
        if (!json.ok) throw new Error(json.error || 'Nie udało się odczytać Excela.');
        previewRecords = json.records || [];
        selectedRows = new Set(previewRecords.map(row => row.rowNumber));
        const skipped = json.skipped || {};
        const skippedTotal = Object.values(skipped).reduce((a, b) => a + Number(b || 0), 0);
        // Rozbicie powodu pominiecia (nie tylko suma) - zeby bylo od razu widac
        // czy chodzi o np. brak mocy/lokalizacji/zbiornika w Excelu, a nie tylko
        // "cos zostalo pominiete" bez wskazowki co poprawic w arkuszu.
        const skipLabels = {
          empty: 'puste wiersze', ground: 'pompa gruntowa', unknownPumpType: 'nierozpoznany typ pompy',
          missingAddress: 'brak adresu', missingOzc: 'brak OZC', missingPower: 'brak/niejednoznaczna moc',
          missingLocation: 'brak lokalizacji', missingHeatingShare: 'brak udziału ogrzewania', missingTank: 'brak zbiornika CWU'
        };
        const skipBreakdown = Object.entries(skipped)
          .filter(([, count]) => Number(count) > 0)
          .map(([key, count]) => `${skipLabels[key] || key}: ${count}`)
          .join(', ');
        document.querySelector('#selectorInfo').textContent = `Arkusz: ${json.sheetName || '-'} · znaleziono ${previewRecords.length} adresów${skippedTotal ? ` · pominięto ${skippedTotal} wierszy (${skipBreakdown})` : ''}.`;
        renderAddressRows();
      } catch (error) {
        previewRecords = [];
        selectedRows = new Set();
        const rawMessage = String(error.message || error);
        const message = rawMessage === 'Failed to fetch'
          ? 'Nie udało się połączyć z generatorem. Sprawdź, czy aplikacja nadal jest uruchomiona w PowerShellu. Jeśli wybrałeś plik .gsheet, pobierz go z Google Sheets jako .xlsx.'
          : rawMessage;
        document.querySelector('#selectorInfo').textContent = message;
        document.querySelector('#addressRows').innerHTML = '<tr><td colspan="5">' + escapeHtml(message) + '</td></tr>';
        updateSelectedSummary();
      }
    }

    function filteredPreviewRecords() {
      const q = normalizeSearch(document.querySelector('#addressSearch').value || '');
      if (!q) return previewRecords;
      return previewRecords.filter(row => normalizeSearch(`${row.rowNumber} ${row.name || ''} ${row.address || ''} ${row.ozc || ''} ${row.municipalityPower || ''} ${row.chosenPower || ''}`).includes(q));
    }

    function renderAddressRows() {
      const rows = filteredPreviewRecords();
      document.querySelector('#addressRows').innerHTML = rows.map(row => {
        const checked = selectedRows.has(row.rowNumber);
        const details = [row.ozc ? `OZC: ${escapeHtml(row.ozc)}` : '', row.chosenPower ? `Moc dobrana: ${escapeHtml(row.chosenPower)}` : (row.municipalityPower ? `Moc: ${escapeHtml(row.municipalityPower)}` : '')].filter(Boolean).join(' · ');
        return `<tr class="record-row ${checked ? '' : 'unselected'}" data-row-number="${row.rowNumber}">`
          + `<td><input type="checkbox" ${checked ? 'checked' : ''} aria-label="Wybierz adres" /></td>`
          + `<td>${row.rowNumber || ''}</td>`
          + `<td>${escapeHtml(row.name || '')}</td>`
          + `<td><strong>${escapeHtml(row.address || '')}</strong>${row.location ? `<div class="small">${escapeHtml(row.location)}</div>` : ''}</td>`
          + `<td>${details || '<span class="small">-</span>'}</td>`
          + `</tr>`;
      }).join('') || '<tr><td colspan="5">Brak adresów dla obecnego filtra.</td></tr>';
      updateSelectedSummary();
    }

    function updateSelectedSummary() {
      const count = selectedRows.size;
      const total = previewRecords.length;
      document.querySelector('#selectedRowsInput').value = JSON.stringify(Array.from(selectedRows).sort((a, b) => a - b));
      document.querySelector('#selectedSummary').textContent = total ? `Zaznaczono: ${count} z ${total}` : 'Zaznaczono: 0';
      const btn = document.querySelector('#startBatch');
      btn.textContent = total ? `Utwórz ${count} PDF${count === 1 ? '' : '-y'}` : 'Start generowania PDF';
    }

    function normalizeSearch(value) {
      return String(value || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l');
    }

    document.querySelector('#cancelBatch').addEventListener('click', async () => {
      if (!activeJob || cancelRequested) return;
      const sure = confirm('Przerwać generowanie PDF? Gotowe pliki zostaną w folderze inwestycji.');
      if (!sure) return;

      cancelRequested = true;
      const btn = document.querySelector('#cancelBatch');
      btn.disabled = true;
      btn.textContent = 'Przerywam...';
      document.querySelector('#finishInfo').textContent = 'Przerywanie generowania...';

      try {
        await fetch(`/api/batch/cancel/${activeJob}`, { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' } });
      } catch (error) {
        console.error(error);
      }
      pollStatus();
    });

    async function pollStatus() {
      if (!activeJob) return;
      const res = await fetch(`/api/batch/status/${activeJob}`);
      if (res.status === 404) {
        clearInterval(pollTimer);
        pollTimer = null;
        activeJob = null;
        document.querySelector('#finishInfo').textContent = 'To zadanie już nie istnieje (prawdopodobnie restart panelu). Uruchom generowanie ponownie.';
        document.querySelector('#startBatch').disabled = false;
        return;
      }
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) {
        clearInterval(pollTimer);
        pollTimer = null;
        document.querySelector('#finishInfo').textContent = json?.error || 'Błąd odczytu statusu zadania.';
        return;
      }
      const job = json.job;
      const outputWarning = document.querySelector('#outputPathWarning');
      if (job.outputPathWarning) {
        outputWarning.textContent = `Wybrana ścieżka zapisu została odrzucona: ${job.outputPathWarning}. Wyniki zapisano w: ${job.outputPath || job.outputDir || job.outputRootDisplay || job.pdfDirDisplay || '-'}`;
        outputWarning.classList.remove('hidden');
      } else {
        outputWarning.classList.add('hidden');
      }
      if (job.status === 'interrupted') {
        clearInterval(pollTimer);
        pollTimer = null;
        activeJob = null;
        document.querySelector('#finishInfo').textContent = 'Zadanie zostało przerwane przez restart panelu. Możesz uruchomić je ponownie.';
        document.querySelector('#startBatch').disabled = false;
        return;
      }

      const total = job.total || 0;
      const done = job.done || 0;
      document.querySelector('#progress').max = Math.max(total, 1);
      document.querySelector('#progress').value = done;
      document.querySelector('#jobStatus').textContent = statusLabel(job.status || '-');
      document.querySelector('#jobDone').textContent = `${done} / ${total}`;
      document.querySelector('#jobOk').textContent = `${job.ok || 0}${job.skippedExisting ? ' +' + job.skippedExisting : ''}`;
      document.querySelector('#jobFailed').textContent = job.failed || 0;

      if (job.cancelRequested || job.status === 'cancelling') {
        document.querySelector('#cancelBatch').disabled = true;
        document.querySelector('#cancelBatch').textContent = 'Przerywam...';
      }

      lastPdfDir = job.pdfDirDisplay || '';

      if (job.current) {
        document.querySelector('#current').textContent = `Aktualnie: ${job.current.index} / ${total} — wiersz ${job.current.rowNumber}: ${job.current.name || ''} ${job.current.address || ''}`;
      } else {
        document.querySelector('#current').textContent = 'Aktualnie: -';
      }

      const rows = job.resultsPreview || [];
      document.querySelector('#previewRows').innerHTML = rows.map(row => {
        const pdfLink = row.pdfUrl ? `<div class="small"><a href="${escapeHtml(row.pdfUrl)}" target="_blank">Otwórz PDF</a></div>` : '';
        const status = row.cancelled
          ? `<span class="badge skip">Przerwano</span>`
          : row.ok
            ? `<span class="badge ${row.skippedExisting ? 'skip' : 'ok'}">${row.skippedExisting ? 'Pominięto' : 'PDF gotowy'}</span>${pdfLink}`
            : `<span class="badge bad">Błąd</span><div class="small">${escapeHtml(row.error || '')}</div>`;
        return `<tr><td>${row.rowNumber || ''}</td><td>${escapeHtml(row.name || '')}</td><td>${escapeHtml(row.address || '')}</td><td>${status}</td></tr>`;
      }).join('');

      if (job.downloadZipUrl && (job.done > 0 || ['finished', 'finished-with-errors', 'fatal-error', 'cancelled'].includes(job.status))) {
        const zip = document.querySelector('#downloadZip');
        zip.href = job.downloadZipUrl;
        zip.classList.remove('hidden');
      }

      if (['finished', 'finished-with-errors', 'fatal-error', 'cancelled'].includes(job.status)) {
        clearInterval(pollTimer);
        pollTimer = null;
        activeJob = null;
        document.querySelector('#startBatch').disabled = false;
        document.querySelector('#cancelBatch').disabled = true;
        document.querySelector('#cancelBatch').textContent = 'Przerwij generowanie';
        const zipLink = job.downloadZipUrl ? ` <a href="${escapeHtml(job.downloadZipUrl)}">Pobierz ZIP z wynikami</a>.` : '';
        if (job.status === 'cancelled') {
          document.querySelector('#finishInfo').innerHTML = `Przerwano generowanie. Gotowe PDF-y można pobrać jako paczkę ZIP.${zipLink}`;
        } else if (job.status === 'fatal-error') {
          document.querySelector('#finishInfo').innerHTML = `Nie udało się rozpocząć albo zakończyć generowania raportów. Sprawdź plik Excel albo pobierz ZIP z logiem dla pomocy technicznej.${zipLink}`;
        } else {
          document.querySelector('#finishInfo').innerHTML = `Zakończono. Raporty są gotowe do pobrania jako paczka ZIP. Każdy raport jest skrócony do pierwszych 3 stron.${zipLink}`;
        }
      }
    }

    function statusLabel(status) {
      const labels = {
        queued: 'W kolejce',
        'reading-excel': 'Czytam Excel',
        running: 'W toku',
        cancelling: 'Przerywanie',
        cancelled: 'Przerwane',
        finished: 'Gotowe',
        'finished-with-errors': 'Gotowe z błędami',
        'fatal-error': 'Błąd generowania'
      };
      return labels[status] || status;
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>'"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
    }

    function saveSettings() {
      const form = document.querySelector('#batchForm');
      const settings = {
        investmentName: form.investmentName.value || '',
        outputPath: form.outputPath.value || '',
        // Audyt rozdz. 14, P0/P1: lokalizacja NIE jest zapamietywana miedzy
        // sesjami. To pole jest fallbackiem wylacznie dla wierszy bez wlasnej
        // kolumny lokalizacji (patrz src/excel.js#rowToInput) - zapamietanie
        // jej w localStorage znaczyloby, ze przy NASTEPNEJ, zupelnie innej
        // inwestycji formularz cicho podstawia lokalizacje z POPRZEDNIEJ,
        // dla kazdego wiersza, ktoremu przypadkiem zabraknie wlasnej danej.
        concurrency: form.concurrency.value || '1',
        skipExisting: form.skipExisting.checked
      };
      localStorage.setItem('ecodanGeneratorSettings', JSON.stringify(settings));
    }

    function loadSettings() {
      try {
        const settings = JSON.parse(localStorage.getItem('ecodanGeneratorSettings') || '{}');
        const form = document.querySelector('#batchForm');
        if (settings.investmentName) form.investmentName.value = settings.investmentName;
        if (settings.outputPath) form.outputPath.value = settings.outputPath;
        if (settings.concurrency) form.concurrency.value = settings.concurrency;
        if (typeof settings.skipExisting === 'boolean') form.skipExisting.checked = settings.skipExisting;
      } catch {}
    }
