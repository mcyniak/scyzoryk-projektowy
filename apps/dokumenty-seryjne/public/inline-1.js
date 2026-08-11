

// Wspolny powrot do panelu glownego w tej samej karcie.
const scyzorykMainPanelUrl = 'http://scyzoryk.localhost:3000';
document.querySelectorAll('[data-main-link]').forEach(link => { link.href = scyzorykMainPanelUrl; link.removeAttribute('target'); });

const headers = { 'X-Scyzoryk-Request': '1' };
    let currentJob = null;
    let currentWorkbook = null;
    let detectedTemplatePower = '';
    let pollTimer = null;
    let lastStatus = null;

    const $ = id => document.getElementById(id);
    function setDisabled(id, isBusy) { const el = $(id); if (el) el.disabled = isBusy; }
    function status(el, msg, type='') { el.textContent = msg; el.className = `status ${type}`; el.classList.remove('hidden'); }
    function hide(el) { el.classList.add('hidden'); }
    function show(el) { el.classList.remove('hidden'); }
    function esc(v) { return String(v ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }

    function setBusy(isBusy) {
      ['uploadBtn','generateBtn','selectAllBtn','selectNoneBtn','selectVisibleBtn','selectVisibleNoneBtn','recordSearch','filePrefix'].forEach(id => setDisabled(id, isBusy));
    }

    function setJobPill(text) { $('jobPill').textContent = text; show($('jobPill')); }
    function selectedRows() { return [...document.querySelectorAll('.row-check')].filter(ch => ch.checked).map(ch => Number(ch.dataset.record)); }
    function visibleChecks() { return [...document.querySelectorAll('.row-check')].filter(ch => !ch.closest('tr')?.classList.contains('is-hidden')); }
    function updateSelectedMetric() {
      const selected = selectedRows().length;
      const total = document.querySelectorAll('.row-check').length;
      const visible = visibleChecks().length;
      const checkedVisible = visibleChecks().filter(ch => ch.checked).length;
      $('metricSelected').textContent = String(selected);
      $('selectionCounter').textContent = `${selected} zaznaczonych z ${total}` + (visible !== total ? ` · widoczne: ${checkedVisible}/${visible}` : '');
      $('generateBtn').textContent = selected === 1 ? 'Utwórz 1 PDF' : `Utwórz ${selected} PDF-y`;
      const all = $('checkAllRows');
      if (all) {
        all.checked = total > 0 && selected === total;
        all.indeterminate = selected > 0 && selected < total;
      }
      document.querySelectorAll('.row-check').forEach(ch => ch.closest('tr')?.classList.toggle('is-selected', ch.checked));
      updateFileNamePreview();
    }

    function fileBasePreview(prefix, address) {
      const p = String(prefix || '').trim().replace(/\s+/g, ' ');
      const a = String(address || 'Adres').trim() || 'Adres';
      if (!p) return a;
      if (/_$/.test(p)) return `${p}${a}`.trim();
      if (/[\-.]$/.test(p)) return `${p} ${a}`.trim();
      return `${p} - ${a}`;
    }

    function updateFileNamePreview() {
      const first = [...document.querySelectorAll('.row-check')].find(ch => ch.checked);
      const tr = first?.closest('tr');
      const addressCol = $('addressColumn')?.value || 'Adres';
      let address = '';
      if (tr && currentWorkbook?.rows) {
        const record = Number(first.dataset.record);
        const row = currentWorkbook.rows.find(r => Number(r._record) === record);
        address = row?.[addressCol] || row?.Adres || `rekord_${record}`;
      }
      const preview = fileBasePreview($('filePrefix')?.value || '', address || 'Adres');
      $('fileNamePreview').textContent = `Przykładowa nazwa: ${preview}.pdf`;
    }

    function updateProgress(progress = {}) {
      show($('progressPanel'));
      const percent = Math.max(0, Math.min(100, Number(progress.percent || 0)));
      const phaseNames = { queued:'Przygotowanie', start:'Start', word:'Uruchamianie Worda', prepare:'Przygotowanie szablonu', records:'Tworzenie dokumentów', export:'Eksport do PDF', finish:'Zakończenie', done:'Gotowe', error:'Błąd', cancelled:'Przerwano' };
      $('progressTitle').textContent = phaseNames[progress.phase] || 'Praca w toku';
      $('progressMsg').textContent = progress.message || 'Przetwarzanie...';
      $('progressPercent').textContent = `${percent}%`;
      $('progressBar').style.width = `${percent}%`;
    }

    function renderLogs(logs = []) {
      const shouldShow = $('settingsBox').open || logs.some(log => log.level === 'error');
      if (!shouldShow) return;
      show($('logPanel'));
      $('logCount').textContent = `${logs.length} wpisów`;
      $('logContent').innerHTML = logs.map(log => {
        const cls = log.level === 'error' ? 'error' : (log.level === 'ok' ? 'ok' : (log.level === 'warn' ? 'warn' : ''));
        const time = log.time ? new Date(log.time).toLocaleTimeString() : '';
        return `<div class="logline ${cls}">[${esc(time)}] [${esc(log.level || 'info')}] ${esc(log.message || '')}</div>`;
      }).join('');
      $('logContent').scrollTop = $('logContent').scrollHeight;
    }

    function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

    async function pollJob() {
      if (!currentJob) return;
      try {
        const res = await fetch(`/api/job/${currentJob}`);
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.message || 'Nie udało się pobrać statusu.');
        lastStatus = data;
        updateProgress(data.progress || {});
        renderLogs(data.logs || []);
        $('logsLink').href = data.logUrl || `/api/download/${currentJob}/logs`;
        $('resultLogsLink').href = data.logUrl || `/api/download/${currentJob}/logs`;
        show($('logsLink'));

        if (data.status === 'running') {
          setBusy(true); show($('cancelBtn')); setJobPill('Generowanie trwa');
          status($('recordsStatus'), data.progress?.message || 'Generuję PDF-y...', 'warn');
        } else if (data.status === 'done') {
          stopPolling(); setBusy(false); hide($('cancelBtn')); setJobPill('Zakończono');
          status($('recordsStatus'), 'PDF-y zostały utworzone.', 'ok');
          renderResult(data.result); show($('resultPanel'));
          $('resultPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
        } else if (data.status === 'error') {
          stopPolling(); setBusy(false); hide($('cancelBtn')); setJobPill('Wymaga sprawdzenia');
          status($('recordsStatus'), data.result?.message || data.progress?.message || 'Wystąpił błąd. Otwórz pomoc techniczną i pobierz logi.', 'err');
          $('settingsBox').open = true; show($('resultLogsLink'));
          if (data.result) renderResult(data.result);
        }
      } catch (e) {
        renderLogs([...(lastStatus?.logs || []), { time: new Date().toISOString(), level: 'error', message: e.message }]);
      }
    }

    async function uploadFiles() {
      hide($('uploadStatus')); hide($('recordsPanel')); hide($('resultPanel')); hide($('progressPanel')); hide($('logPanel'));
      stopPolling();
      const excel = $('excelFile').files[0];
      if (!excel) return status($('uploadStatus'), 'Dodaj plik Excel.', 'err');
      const fd = new FormData();
      fd.append('excel', excel);

      const templateFiles = [...$('templateFile').files].filter(f => /\.docx$/i.test(f.name));
      if (!templateFiles.length) return status($('uploadStatus'), 'Dodaj najpierw folder z szablonami Word.', 'err');
      // Podfolder bezposrednio nad plikiem (np. "VARMERO VPM 9020") - dla
      // szablonow lezacych wprost w wybranym folderze (jak dzis Kolektory)
      // zostaje pusty, bo tam wariant siedzi w samej nazwie pliku (sufiks
      // _250/_300/_400), nie w strukturze folderow.
      const templateRelFolders = templateFiles.map(f => {
        const rel = f.webkitRelativePath || '';
        const parts = rel.split('/').filter(Boolean);
        return parts.length >= 3 ? parts[parts.length - 2] : '';
      });
      for (const f of templateFiles) fd.append('templates', f);
      fd.append('templateRelFolders', JSON.stringify(templateRelFolders));

      setBusy(true); status($('uploadStatus'), 'Wczytuję pliki i sprawdzam tabelę...', 'warn');
      try {
        const res = await fetch('/api/upload', { method: 'POST', headers, body: fd });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.message || 'Nie udało się wczytać plików.');

        currentJob = data.jobId; detectedTemplatePower = data.detectedTemplatePower || '';
        data.workbook = await loadAllRows(data.workbook);
        currentWorkbook = data.workbook;
        $('filePrefix').value = '';
        renderWorkbook(data.workbook, data.suggestedAddressColumn); refreshUidColumnOptions(data.workbook.columns || []); renderTemplateGroups(data.templateGroups || [], data.workbook.columns || [], data.suggestedUidColumn || '');
        const ambiguous = data.ambiguousTemplates || [];
        const ambiguousNote = ambiguous.length
          ? ` Uwaga: w ${ambiguous.length === 1 ? 'folderze' : 'folderach'} znaleziono więcej niż jeden pasujący plik tego samego typu (${ambiguous.map(a => a.resolved ? `"${a.relFolder}": użyto nowszego "${a.keptFile}" (starszy "${a.skippedFile}" zignorowano)` : `"${a.relFolder}": ${a.files.join(' / ')} — pominięto, sprawdź ręcznie`).join('; ')}).`
          : '';
        const ozcNote = data.ozcFoldersFound ? ` Znaleziono dane OZC/audytów — dodatkowe pola w szablonach będą uzupełniane automatycznie tam, gdzie to możliwe.` : '';
        status($('uploadStatus'), `Wczytano ${data.workbook.totalRows} rekordów.${ambiguousNote}${ozcNote}`, ambiguous.length ? 'warn' : 'ok');
        show($('recordsPanel')); setJobPill('Gotowe');
        await pollJob();
        $('recordsPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (e) { status($('uploadStatus'), e.message, 'err'); }
      finally { setBusy(false); }
    }

    function selectedTemplateGroups() {
      return [...document.querySelectorAll('.template-group-check')].filter(ch => ch.checked).map(ch => ch.value);
    }
    function refreshUidColumnOptions(columns) {
      const uidSelect = $('uidColumn');
      if (!uidSelect) return;
      const previousValue = uidSelect.value;
      const cols = columns || [];
      const keepPrevious = previousValue && cols.includes(previousValue);
      uidSelect.innerHTML = '<option value="">— wybierz kolumnę —</option>' + cols.map(col => `<option ${col === previousValue ? 'selected' : ''}>${esc(col)}</option>`).join('');
      uidSelect.value = keepPrevious ? previousValue : '';
    }
    function renderTemplateGroups(groups, columns, suggestedUidColumn) {
      const box = $('templateGroupsBox');
      const list = $('templateGroupsList');
      const uidBox = $('uidColumnBox');
      const uidSelect = $('uidColumn');
      if (!groups || !groups.length) { hide(box); hide(uidBox); list.innerHTML = ''; return; }
      list.innerHTML = groups.map((g, i) => {
        const label = g.hasVariants ? `${esc(g.name)} (warianty: ${g.variants.join('/')})` : esc(g.name);
        return `<label class="checkline"><input type="checkbox" class="template-group-check" value="${esc(g.name)}" checked><span>${label}</span></label>`;
      }).join('');
      show(box);
      const anyVariant = groups.some(g => g.hasVariants);
      if (anyVariant) {
        uidSelect.innerHTML = '<option value="">— wybierz kolumnę —</option>' + (columns || []).map(col => `<option ${col === suggestedUidColumn ? 'selected' : ''}>${esc(col)}</option>`).join('');
        show(uidBox);
      } else {
        hide(uidBox);
      }
    }
    function renderWorkbook(wb, suggestedAddressColumn) {
      currentWorkbook = wb;
      $('recordsDesc').textContent = `Znaleziono ${wb.totalRows} rekordów w arkuszu „${wb.sheetName}”.`;
      $('metricSheet').textContent = wb.sheetName || '-';
      $('metricRows').textContent = String(wb.totalRows || 0);
      $('metricColumn').textContent = suggestedAddressColumn || 'Adres';
      $('sheetSelect').innerHTML = (wb.sheetNames || []).map(name => `<option ${name === wb.sheetName ? 'selected' : ''}>${esc(name)}</option>`).join('');
      $('addressColumn').innerHTML = (wb.columns || []).map(col => `<option ${col === suggestedAddressColumn ? 'selected' : ''}>${esc(col)}</option>`).join('');
      updateSheetHint(wb.sheetName);
      $('recordSearch').value = '';
      const usefulColumns = ['_record', ...pickColumns(wb.columns || [], suggestedAddressColumn)];
      const head = `<thead><tr><th class="select-col"><input id="checkAllRows" type="checkbox" checked title="Zaznacz / odznacz wszystkie"></th>${usefulColumns.map(c => `<th>${c === '_record' ? 'Nr' : esc(c)}</th>`).join('')}</tr></thead>`;
      const bodyRows = (wb.rows || []).map(row => {
        const searchText = usefulColumns.map(c => row[c]).join(' ');
        return `<tr data-search="${esc(searchText).toLowerCase()}"><td class="select-col"><input class="row-check" type="checkbox" data-record="${row._record}" checked></td>${usefulColumns.map(c => `<td>${esc(row[c])}</td>`).join('')}</tr>`;
      }).join('');
      $('recordsTable').innerHTML = head + `<tbody>${bodyRows}</tbody>`;
      $('checkAllRows').onchange = e => { document.querySelectorAll('.row-check').forEach(ch => ch.checked = e.target.checked); updateSelectedMetric(); };
      document.querySelectorAll('.row-check').forEach(ch => ch.onchange = updateSelectedMetric);
      document.querySelectorAll('#recordsTable tbody tr').forEach(tr => {
        tr.addEventListener('click', e => {
          if (e.target && e.target.tagName === 'INPUT') return;
          const ch = tr.querySelector('.row-check');
          if (ch) { ch.checked = !ch.checked; updateSelectedMetric(); }
        });
      });
      $('addressColumn').onchange = () => { $('metricColumn').textContent = $('addressColumn').value; updateFileNamePreview(); };
      $('sheetSelect').onchange = changeSheet;
      updateSelectedMetric(); hide($('recordsStatus'));
    }

    async function loadAllRows(workbook) {
      if (!currentJob || !workbook?.sheetName || (workbook.rows || []).length >= Number(workbook.totalRows || 0)) return workbook;
      const rows = [];
      const limit = 500;
      for (let offset = 0; offset < Number(workbook.totalRows || 0); offset += limit) {
        const res = await fetch(`/api/jobs/${currentJob}/sheets/${encodeURIComponent(workbook.sheetName)}/rows?offset=${offset}&limit=${limit}`);
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.message || 'Nie udało się pobrać rekordów arkusza.');
        rows.push(...(data.rows || []));
      }
      return { ...workbook, rows };
    }

    function updateSheetHint(sheetName) {
      const el = $('sheetHint');
      const sheet = String(sheetName || '');
      if (!detectedTemplatePower) {
        el.className = 'sheet-note';
        el.textContent = `Wybrany arkusz: ${sheet}. Sprawdź, czy pasuje do wybranego szablonu Word.`;
      } else if (sheet.toLowerCase() === detectedTemplatePower.toLowerCase()) {
        el.className = 'sheet-note ok';
        el.textContent = `Szablon wygląda na ${detectedTemplatePower} i taki arkusz został wybrany.`;
      } else {
        el.className = 'sheet-note warn';
        el.textContent = `Uwaga: szablon wygląda na ${detectedTemplatePower}, a wybrany arkusz to ${sheet}. Zmień arkusz albo wybierz odpowiedni szablon Word.`;
      }
    }

    async function changeSheet() {
      if (!currentJob) return;
      const sheet = $('sheetSelect').value;
      status($('recordsStatus'), `Wczytuję arkusz ${sheet}...`, 'warn');
      try {
        const res = await fetch(`/api/sheet/${currentJob}/${encodeURIComponent(sheet)}`);
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.message || 'Nie udało się wczytać arkusza.');
        data.workbook = await loadAllRows(data.workbook);
        renderWorkbook(data.workbook, data.suggestedAddressColumn); refreshUidColumnOptions(data.workbook.columns || []);
        status($('recordsStatus'), `Zmieniono arkusz na ${sheet}.`, 'ok');
      } catch (e) {
        status($('recordsStatus'), e.message, 'err');
      }
    }

    function pickColumns(columns, addressColumn) {
      const names = ['ID', addressColumn, 'Adres', 'Beneficjent', 'powierzchnia', 'rok', 'ŹRÓDŁO', 'OZC'];
      const result = [];
      for (const name of names) if (name && columns.includes(name) && !result.includes(name)) result.push(name);
      for (const col of columns) if (result.length < 8 && !result.includes(col)) result.push(col);
      return result;
    }

    function filterRecords() {
      const q = $('recordSearch').value.trim().toLowerCase();
      document.querySelectorAll('#recordsTable tbody tr').forEach(tr => {
        const hay = tr.dataset.search || tr.textContent.toLowerCase();
        tr.classList.toggle('is-hidden', q && !hay.includes(q));
      });
      updateSelectedMetric();
    }

    function setVisibleRowsChecked(checked) {
      visibleChecks().forEach(ch => ch.checked = checked);
      updateSelectedMetric();
    }

    async function generate() {
      if (!currentJob) return status($('recordsStatus'), 'Najpierw wczytaj pliki.', 'err');
      const rows = selectedRows();
      if (!rows.length) return status($('recordsStatus'), 'Zaznacz przynajmniej jeden rekord.', 'err');
      const uidBoxVisible = $('uidColumnBox') && !$('uidColumnBox').classList.contains('hidden');
      if (uidBoxVisible && !$('uidColumn').value) return status($('recordsStatus'), 'Wybierz kolumnę UID (potrzebna do rozpoznania wariantu mocy) zanim uruchomisz generowanie.', 'err');
      setBusy(true); hide($('resultPanel')); show($('cancelBtn'));
      status($('recordsStatus'), `Rozpoczynam tworzenie ${rows.length} PDF-ów...`, 'warn');
      updateProgress({ phase: 'queued', percent: 0, message: 'Przygotowuję generowanie...' });
      renderLogs([]);
      try {
        const res = await fetch(`/api/generate/${currentJob}`, {
          method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ selectedRows: rows, selectedGroups: selectedTemplateGroups(), uidColumn: $('uidColumn') ? $('uidColumn').value : '', sheetName: $('sheetSelect').value, addressColumn: $('addressColumn').value, filePrefix: $('filePrefix').value.trim(), visibleWord: $('visibleWord').checked, debugMode: $('debugMode').checked })
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.message || 'Nie udało się rozpocząć generowania.');
        setJobPill('Generowanie trwa');
        await pollJob(); stopPolling(); pollTimer = setInterval(pollJob, 1000);
      } catch (e) { setBusy(false); hide($('cancelBtn')); status($('recordsStatus'), e.message, 'err'); }
    }

    async function cancelJob() {
      if (!currentJob) return;
      if (!confirm('Przerwać generowanie PDF-ów?')) return;
      try { await fetch(`/api/cancel/${currentJob}`, { method: 'POST', headers }); await pollJob(); }
      catch (e) { status($('recordsStatus'), e.message, 'err'); }
    }

    function renderResult(result) {
      if (!result) return;
      const created = result.created || [];
      $('resultDesc').textContent = `Utworzono ${created.length} plików PDF.`;
      $('resultLogsLink').href = result.logUrl || `/api/download/${currentJob}/logs`;
      if (created.length) {
        $('zipLink').href = `/api/download/${currentJob}/zip`;
        $('zipLink').dataset.disabled = '0';
        $('zipLink').style.opacity = '';
        $('zipLink').style.pointerEvents = '';
        $('zipLink').setAttribute('aria-disabled', 'false');
        $('zipLink').title = '';
      } else {
        $('zipLink').href = '#';
        $('zipLink').dataset.disabled = '1';
        $('zipLink').style.opacity = '.45';
        $('zipLink').style.pointerEvents = 'none';
        $('zipLink').setAttribute('aria-disabled', 'true');
        $('zipLink').title = 'Brak gotowych PDF-ów do pobrania.';
      }
      $('resultList').innerHTML = created.length ? created.map(item => `
        <div class="result-item">
          <div><strong>${esc(item.file)}</strong><small>Adres: ${esc(item.address)} · rekord ${esc(item.row)}</small></div>
          <a class="button ghost" href="${item.url}">Pobierz</a>
        </div>`).join('') : '<div class="status err">Nie utworzono żadnych PDF-ów. Kliknij „Pobierz logi”, żeby zobaczyć dokładny błąd Worda/PowerShella.</div>';
      if ((result.errors || []).length) {
        status($('resultStatus'), `Część dokumentów nie została utworzona. Otwórz pomoc techniczną i pobierz logi.`, 'err');
        show($('resultLogsLink'));
      } else if (result.ok) {
        status($('resultStatus'), 'Gotowe. Każdy adres ma osobny PDF.', 'ok');
      } else {
        status($('resultStatus'), result.message || 'Generowanie zakończyło się błędem.', 'err');
        show($('resultLogsLink'));
      }
      show($('resultPanel'));
    }

    $('uploadBtn')?.addEventListener('click', () => uploadFiles());
    $('generateBtn')?.addEventListener('click', generate);
    $('cancelBtn')?.addEventListener('click', cancelJob);
    $('selectAllBtn')?.addEventListener('click', () => { document.querySelectorAll('.row-check').forEach(ch => ch.checked = true); updateSelectedMetric(); });
    $('selectNoneBtn')?.addEventListener('click', () => { document.querySelectorAll('.row-check').forEach(ch => ch.checked = false); updateSelectedMetric(); });
    $('selectVisibleBtn')?.addEventListener('click', () => setVisibleRowsChecked(true));
    $('selectVisibleNoneBtn')?.addEventListener('click', () => setVisibleRowsChecked(false));
    $('zipLink')?.addEventListener('click', e => { if ($('zipLink').dataset.disabled === '1') e.preventDefault(); });
    $('recordSearch')?.addEventListener('input', filterRecords);
    $('filePrefix')?.addEventListener('input', updateFileNamePreview);
