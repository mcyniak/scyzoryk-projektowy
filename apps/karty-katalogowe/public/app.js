const STATUS_LABELS = {
  'skopiowano': ['Skopiowano', 'ok'],
  'do-skopiowania': ['Do skopiowania', 'ok'],
  'pominieto-juz-sa': ['Już są', 'skip'],
  'pominieto-rezygnacja': ['Rezygnacja', 'skip'],
  'czesciowo': ['Częściowo', 'warn'],
  'blad': ['Błąd', 'err']
};

const runBtn = document.getElementById('runBtn');
const statusEl = document.getElementById('kkStatus');
const resultsPanel = document.getElementById('kkResultsPanel');
const tableBody = document.getElementById('kkTableBody');
const summaryEl = document.getElementById('kkSummary');

runBtn.addEventListener('click', async () => {
  const fileInput = document.getElementById('excelFile');
  const rootPath = document.getElementById('rootPath').value.trim();
  const dryRun = document.getElementById('dryRun').checked;

  statusEl.className = '';
  statusEl.textContent = '';

  if (!fileInput.files.length) { statusEl.className = 'err'; statusEl.textContent = 'Wybierz plik Excel.'; return; }
  if (!rootPath) { statusEl.className = 'err'; statusEl.textContent = 'Podaj ścieżkę do głównego folderu.'; return; }

  const formData = new FormData();
  formData.append('excel', fileInput.files[0]);
  formData.append('rootPath', rootPath);
  formData.append('dryRun', String(dryRun));

  runBtn.disabled = true;
  statusEl.textContent = dryRun ? 'Analizuję (podgląd, bez kopiowania)...' : 'Kopiuję karty katalogowe...';

  try {
    const resp = await fetch('/api/run', { method: 'POST', body: formData, headers: { 'X-Scyzoryk-Request': '1' } });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.message || 'Nieznany błąd.');

    statusEl.className = '';
    statusEl.textContent = `Gotowe. Przetworzono ${data.wyniki.length} wierszy.` + (dryRun ? ' (tryb podglądu — nic nie skopiowano)' : '');

    summaryEl.innerHTML = Object.entries(data.podsumowanie).map(([status, count]) => {
      const [label, cls] = STATUS_LABELS[status] || [status, 'skip'];
      return `<div class="kk-chip ${cls}"><strong>${count}</strong> — ${label}</div>`;
    }).join('');

    tableBody.innerHTML = data.wyniki.map(w => {
      const [label, cls] = STATUS_LABELS[w.status] || [w.status, 'skip'];
      return `<tr>
        <td>${w.gmina || ''}</td>
        <td>${w.id ?? ''}</td>
        <td>${w.adres || ''}</td>
        <td>${w.uid || ''}</td>
        <td>${w.folder || ''}</td>
        <td><span class="kk-badge ${cls}">${label}</span></td>
        <td>${w.komunikat || ''}</td>
      </tr>`;
    }).join('');

    resultsPanel.style.display = 'block';
  } catch (err) {
    statusEl.className = 'err';
    statusEl.textContent = 'Błąd: ' + err.message;
  } finally {
    runBtn.disabled = false;
  }
});
