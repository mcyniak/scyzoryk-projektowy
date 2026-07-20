function friendlyErrorMessage(message){
  const text = String(message || '');
  if (/archiver|zip/i.test(text)) return 'Nie udało się utworzyć paczki ZIP z wynikami.';
  if (/PowerShell|WINWORD|Word/i.test(text)) return 'Nie udało się przygotować dokumentu w Wordzie.';
  return text || 'Wystąpił błąd podczas generowania.';
}


// Wspolny powrot do panelu glownego w tej samej karcie.
const scyzorykMainPanelUrl = window.location.protocol + '//' + window.location.hostname + ':3000';
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
        const res = await fetch('/api/convert', { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' }, body: fd });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.message || 'Nie udało się wygenerować PDF-ów.');
        const failedList = data.failed || [];
        const failedText = failedList.map(x => String(x.input || x.error || '')).join(' ');
        selectedFiles.forEach(f => { f._state = failedText.includes(f.name) ? 'błąd' : 'gotowe'; });
        renderFiles();
        showStatus(`Gotowe. Utworzono PDF-y: ${data.count}.`, data.status === 'finished-with-errors' ? '' : 'ok');
        const failed = failedList.length ? `<p class="status err">Niektóre pliki miały błąd: ${escapeHtml(failedList.map(x => x.error).join(' | '))}</p><button class="button secondary" id="retryFailed" type="button">Zostaw tylko błędne do ponowienia</button>` : '';
        const fileItems = Array.isArray(data.files) ? data.files.map(item => typeof item === 'string' ? { file: item, url: '' } : item) : [];
        const zipWarning = data.zipError ? `<p class="status err">PDF-y zostały utworzone, ale nie udało się przygotować ZIP-a. Pobierz pliki pojedynczo.</p>` : '';
        const downloads = data.zipUrl
          ? `<a class="button primary" href="${data.zipUrl}">Pobierz ZIP z PDF-ami</a>`
          : fileItems.map(item => `<a class="button primary" href="${escapeHtml(item.url || '#')}">Pobierz ${escapeHtml(item.file || 'PDF')}</a>`).join('');
        resultBox.innerHTML = `${failed}${zipWarning}${downloads || '<p class="status err">Brak linków pobierania. Sprawdź logi serwera.</p>'}`;
        const retryBtn = document.querySelector('#retryFailed');
        if (retryBtn) retryBtn.addEventListener('click', () => {
          selectedFiles = selectedFiles.filter(f => f._state === 'błąd');
          selectedFiles.forEach(f => f._state = 'czeka');
          renderFiles();
          showStatus('Na liście zostały tylko pliki błędne. Kliknij generuj jeszcze raz.', '');
        });
      } catch (err) {
        selectedFiles.forEach(f => f._state = 'błąd');
        renderFiles();
        showStatus(err.message || 'Błąd generowania.', 'err');
      } finally {
        submitBtn.disabled = false;
      }
    });
    renderFiles();
