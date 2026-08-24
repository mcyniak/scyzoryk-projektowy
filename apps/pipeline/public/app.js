let lastAnalysis = null;
let currentExcelFile = null;
let currentRunId = null;
let pollTimer = null;
// Map<sheetName, Set<rowIndex>> - domyslnie WSZYSTKO zaznaczone zaraz po
// wczytaniu tabeli; uzytkownik odznacza to, czego nie chce przetwarzac.
let zaznaczoneAdresy = new Map();

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}

// --- Ostatnie przebiegi: pozwala wrocic do przebiegu po zamknieciu karty
// (audyt UX 2026-08-21 - runId zyl dotychczas WYLACZNIE w zmiennej JS, wiec
// zamkniecie strony w trakcie wielogodzinnego oczekiwania na Varmero
// nieodwracalnie gubilo dostep do wyniku z poziomu UI, mimo ze dane byly
// nadal na dysku). ---

const OSTATNI_RUN_KLUCZ = 'pipeline_ostatni_run_id';

async function zaladujOstatniePrzebiegi() {
  try {
    const res = await fetch('/api/pipeline/list');
    const json = await res.json().catch(() => null);
    if (!json || !json.ok || !json.runs?.length) return;
    const panel = document.querySelector('#ostatniePrzebiegiPanel');
    const list = document.querySelector('#ostatniePrzebiegiList');
    const runy = json.runs.slice(0, 10);
    list.innerHTML = runy.map(r => `
      <div class="krok-progress-item">
        <div class="krok-progress-top">
          <span>Przebieg z ${new Date(r.createdAt).toLocaleString('pl-PL')}</span>
          <span class="badge ${badgeDlaStatusu(r.status)}">${escapeHtml(STATUS_LABELS[r.status] || r.status)}</span>
        </div>
        <div class="actions">
          <button type="button" class="secondary" data-otworz-run="${r.id}">Otwórz ten przebieg</button>
          <button type="button" class="secondary" data-usun-run="${r.id}">Usuń</button>
        </div>
      </div>`).join('');
    list.querySelectorAll('[data-otworz-run]').forEach(btn => {
      btn.addEventListener('click', () => otworzPrzebieg(btn.dataset.otworzRun));
    });
    list.querySelectorAll('[data-usun-run]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Usunąć ten przebieg z historii? Pobrane dobory/dokumenty w jego folderze roboczym też znikną.')) return;
        await fetch(`/api/pipeline/${btn.dataset.usunRun}`, { method: 'DELETE', headers: { 'X-Scyzoryk-Request': '1' } }).catch(() => {});
        zaladujOstatniePrzebiegi();
      });
    });
    panel.classList.remove('hidden');
  } catch (_) { /* brak polaczenia - panel po prostu nie pokaze historii */ }
}

document.querySelector('#wyczyscHistorieBtn').addEventListener('click', async () => {
  if (!confirm('Usunąć całą historię przebiegów? Tego nie da się cofnąć.')) return;
  await fetch('/api/pipeline/runs', { method: 'DELETE', headers: { 'X-Scyzoryk-Request': '1' } }).catch(() => {});
  document.querySelector('#ostatniePrzebiegiPanel').classList.add('hidden');
  document.querySelector('#ostatniePrzebiegiList').innerHTML = '';
});

function otworzPrzebieg(runId) {
  currentRunId = runId;
  localStorage.setItem(OSTATNI_RUN_KLUCZ, runId);
  document.querySelector('#runPanel').classList.remove('hidden');
  document.querySelector('#runPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  startPolling();
}

zaladujOstatniePrzebiegi();

function hideTopNotice() {
  document.querySelector('#topNotice').classList.add('hidden');
}

function showTopNotice(message, tone = '') {
  const el = document.querySelector('#topNotice');
  el.textContent = message;
  el.className = `panel notice ${tone}`.trim();
}

// --- Przegladarka folderow w stronie (ten sam wzorzec co Tworzenie folderow -
// natywne okno Windows nie dziala niezawodnie, patrz lib/folderBrowse.js) ---
let browseTargetInput = null;
let currentBrowsePath = null;

document.querySelector('#folderBrowseClose').addEventListener('click', closeFolderBrowser);
document.querySelector('#folderBrowseModal').addEventListener('click', (event) => {
  if (event.target.id === 'folderBrowseModal') closeFolderBrowser();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.querySelector('#folderBrowseModal').classList.contains('open')) closeFolderBrowser();
});

function closeFolderBrowser() {
  document.querySelector('#folderBrowseModal').classList.remove('open');
}

async function openFolderBrowser(targetInput) {
  browseTargetInput = targetInput;
  document.querySelector('#folderBrowseModal').classList.add('open');
  await loadFolderBrowse(targetInput.value.trim() || null);
}

async function loadFolderBrowse(targetPath) {
  const listEl = document.querySelector('#folderBrowseList');
  const currentEl = document.querySelector('#folderBrowseCurrentPath');
  listEl.innerHTML = '<div class="folder-row">Wczytuję...</div>';
  try {
    const url = targetPath ? `/api/browse-folder?path=${encodeURIComponent(targetPath)}` : '/api/browse-folder';
    const res = await fetch(url);
    const json = await res.json().catch(() => null);
    if (!json || !json.ok) {
      listEl.innerHTML = `<div class="folder-row">${escapeHtml(json?.error || 'Nie udało się wczytać folderów.')}</div>`;
      return;
    }
    currentBrowsePath = json.path;
    currentEl.textContent = json.path || 'Wybierz dysk';

    const rows = [];
    if (json.path !== null) {
      const isDriveRoot = json.parent === null;
      const upTarget = isDriveRoot ? '' : json.parent;
      rows.push(`<div class="folder-row clickable up-nav" data-path="${escapeHtml(upTarget)}">${isDriveRoot ? '⬆ Lista dysków' : '⬆ ..'}</div>`);
    }
    for (const entry of json.entries) {
      rows.push(`<div class="folder-row clickable" data-path="${escapeHtml(entry.path)}">📁 ${escapeHtml(entry.name)}</div>`);
    }
    listEl.innerHTML = rows.join('') || '<div class="folder-row">Brak podfolderów.</div>';
  } catch (error) {
    listEl.innerHTML = `<div class="folder-row">${escapeHtml(String(error.message || error))}</div>`;
  }
}

document.querySelector('#folderBrowseList').addEventListener('click', (event) => {
  const row = event.target.closest('[data-path]');
  if (!row) return;
  loadFolderBrowse(row.dataset.path);
});

document.querySelector('#folderBrowseSelect').addEventListener('click', () => {
  if (!currentBrowsePath || !browseTargetInput) return;
  browseTargetInput.value = currentBrowsePath;
  closeFolderBrowser();
});

// --- Krok 1: wgranie i analiza tabeli adresowej ---

document.querySelector('#excelFile').addEventListener('change', async () => {
  hideTopNotice();
  const input = document.querySelector('#excelFile');
  const file = input.files && input.files[0];
  if (!file) return;
  if (!/\.xlsx$/i.test(file.name)) {
    showTopNotice(/\.gsheet$/i.test(file.name)
      ? 'Wybrano plik .gsheet, czyli skrót do Google Sheets. Wyeksportuj go najpierw jako .xlsx (Plik → Pobierz → Microsoft Excel).'
      : 'Wybrany plik nie jest Excelem. Wybierz plik z końcówką .xlsx.');
    return;
  }

  const data = new FormData();
  data.append('excel', file);
  try {
    const res = await fetch('/api/pipeline/analyze', { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' }, body: data });
    const json = await res.json().catch(() => null);
    if (!json || !json.ok) {
      showTopNotice(json?.error || 'Nie udało się przeanalizować tabeli adresowej.');
      return;
    }
    currentExcelFile = file;
    lastAnalysis = json;
    zaznaczoneAdresy = new Map(json.sheets.map(s => [s.sheetName, new Set(s.records.map(r => r.rowIndex))]));
    renderAnalysis(json);
    renderAdresyTable();
    renderKrokiForm(json);
  } catch (error) {
    const message = String(error.message || error) === 'Failed to fetch'
      ? 'Nie udało się połączyć z aplikacją. Sprawdź, czy Scyzoryk nadal jest uruchomiony.'
      : String(error.message || error);
    showTopNotice(message);
  }
});

function renderAnalysis(json) {
  const box = document.querySelector('#analyzaBox');
  const p = json.podsumowanie;
  const pills = [];
  if (p.pompyPowietrzne) pills.push(`<div class="sheet-pill"><strong>${p.pompyPowietrzne}</strong> pomp powietrznych</div>`);
  if (p.pompyGrunt) pills.push(`<div class="sheet-pill"><strong>${p.pompyGrunt}</strong> pomp gruntowych</div>`);
  if (p.pompyNieznane) pills.push(`<div class="sheet-pill"><strong>${p.pompyNieznane}</strong> pomp o nierozpoznanym rodzaju</div>`);
  if (p.kolektory) pills.push(`<div class="sheet-pill"><strong>${p.kolektory}</strong> zestawów solarnych</div>`);
  if (p.kotly) pills.push(`<div class="sheet-pill"><strong>${p.kotly}</strong> kotłów</div>`);
  box.innerHTML = pills.length ? pills.join('') : '<div class="sheet-pill">Nie rozpoznano żadnego arkusza Pompy/Solary/Kotły w tym pliku.</div>';
  box.classList.remove('hidden');
}

// --- Podglad adresow: filtrowanie + zaznaczanie (ten sam wzorzec co
// dokumenty-seryjne/formularze-varmero/formularze-ecodan - "zaznacz
// wszystkie" dziala TYLKO na widocznych, po filtrze, wierszach). ---

function wszystkieWierszeAdresow() {
  const wiersze = [];
  for (const sheet of lastAnalysis.sheets) {
    for (const rec of sheet.records) {
      wiersze.push({ sheetName: sheet.sheetName, type: sheet.type, ...rec });
    }
  }
  return wiersze;
}

function typLabel(type) {
  return { pompy: 'Pompy', kolektory: 'Solary', kotly: 'Kotły' }[type] || type;
}

function renderAdresyTable() {
  const wiersze = wszystkieWierszeAdresow();
  const panel = document.querySelector('#adresyPanel');
  if (!wiersze.length) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');

  const majaPompy = wiersze.some(w => w.type === 'pompy');
  const table = document.querySelector('#adresyTable');
  table.innerHTML = `
    <thead><tr>
      <th class="select-col"><input type="checkbox" id="adresCheckAll" checked title="Zaznacz/odznacz wszystkie widoczne" /></th>
      <th>Typ</th><th>Arkusz</th><th>LP/ID</th><th>Adres</th><th>Gmina</th>${majaPompy ? '<th>Rodzaj pompy</th>' : ''}
    </tr></thead>
    <tbody>${wiersze.map(w => {
      const zaznaczony = zaznaczoneAdresy.get(w.sheetName)?.has(w.rowIndex);
      const searchText = `${w.address} ${w.gmina} ${w.lpOrId} ${w.sheetName}`.toLowerCase();
      return `<tr data-sheet="${escapeHtml(w.sheetName)}" data-row="${w.rowIndex}" data-search="${escapeHtml(searchText)}">
        <td class="select-col"><input type="checkbox" class="adres-check" ${zaznaczony ? 'checked' : ''} /></td>
        <td>${escapeHtml(typLabel(w.type))}</td>
        <td>${escapeHtml(w.sheetName)}</td>
        <td>${escapeHtml(w.lpOrId)}</td>
        <td>${escapeHtml(w.address)}</td>
        <td>${escapeHtml(w.gmina)}</td>
        ${majaPompy ? `<td>${w.pumpType ? escapeHtml(w.pumpType === 'powietrzna' ? 'powietrzna' : 'gruntowa') : ''}</td>` : ''}
      </tr>`;
    }).join('')}</tbody>
  `;

  table.querySelectorAll('.adres-check').forEach(cb => {
    cb.addEventListener('change', () => {
      const tr = cb.closest('tr');
      const set = zaznaczoneAdresy.get(tr.dataset.sheet);
      const rowIndex = Number(tr.dataset.row);
      if (cb.checked) set.add(rowIndex); else set.delete(rowIndex);
      updateAdresySelectedCount();
    });
  });
  document.querySelector('#adresCheckAll').addEventListener('change', e => setWidoczneAdresyZaznaczone(e.target.checked));
  updateAdresySelectedCount();
}

function widoczneWierszeTr() {
  return [...document.querySelectorAll('#adresyTable tbody tr')].filter(tr => !tr.classList.contains('is-hidden'));
}

function setWidoczneAdresyZaznaczone(checked) {
  widoczneWierszeTr().forEach(tr => {
    const cb = tr.querySelector('.adres-check');
    cb.checked = checked;
    const set = zaznaczoneAdresy.get(tr.dataset.sheet);
    const rowIndex = Number(tr.dataset.row);
    if (checked) set.add(rowIndex); else set.delete(rowIndex);
  });
  updateAdresySelectedCount();
}

function updateAdresySelectedCount() {
  const total = document.querySelectorAll('.adres-check').length;
  const selected = [...zaznaczoneAdresy.values()].reduce((sum, set) => sum + set.size, 0);
  document.querySelector('#adresySelectedCount').textContent = `Zaznaczono: ${selected} z ${total}`;
  // Audyt UX 2026-08-21: naglowkowy checkbox bez tego zawsze wygladal jak
  // "wszystko zaznaczone", nawet po recznym odznaczeniu pojedynczego wiersza.
  const checkAll = document.querySelector('#adresCheckAll');
  if (checkAll) {
    const widoczne = widoczneWierszeTr();
    const zaznaczoneWidoczne = widoczne.filter(tr => tr.querySelector('.adres-check')?.checked).length;
    checkAll.indeterminate = zaznaczoneWidoczne > 0 && zaznaczoneWidoczne < widoczne.length;
    if (!checkAll.indeterminate) checkAll.checked = widoczne.length > 0 && zaznaczoneWidoczne === widoczne.length;
  }
}

document.querySelector('#adresSearch').addEventListener('input', () => {
  const q = document.querySelector('#adresSearch').value.trim().toLowerCase();
  document.querySelectorAll('#adresyTable tbody tr').forEach(tr => {
    tr.classList.toggle('is-hidden', q.length > 0 && !tr.dataset.search.includes(q));
  });
  updateAdresySelectedCount();
});
document.querySelector('#selectAllAdresyBtn').addEventListener('click', () => setWidoczneAdresyZaznaczone(true));
document.querySelector('#selectNoneAdresyBtn').addEventListener('click', () => setWidoczneAdresyZaznaczone(false));

// --- Krok 2: dynamiczny formularz krokow, zalezny od wykrytych typow ---

function pathField(id, label, help) {
  return `<label>${escapeHtml(label)}
    <div class="path-row">
      <input type="text" id="${id}" />
      <button type="button" class="secondary" data-browse-for="${id}">Przeglądaj...</button>
    </div>
    ${help ? `<span class="field-help">${escapeHtml(help)}</span>` : ''}
  </label>`;
}

function textField(id, label, placeholder = '') {
  return `<label>${escapeHtml(label)}<input type="text" id="${id}" placeholder="${escapeHtml(placeholder)}" /></label>`;
}

function fileField(id, label, help) {
  return `<label>${escapeHtml(label)}<input type="file" id="${id}" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" />
    ${help ? `<span class="field-help">${escapeHtml(help)}</span>` : ''}
  </label>`;
}

// Zrodlo tabeli dla dokumentow seryjnych - user SAM wybiera per typ, bo to
// zalezy od inwestycji (potwierdzone przez wlasciciela 2026-08-21): dla
// niektorych inwestycji glowna tabela adresowa juz ma kolumne Beneficjenta i
// spokojnie wystarcza, dla innych potrzebna jest osobna tabela z folderu
// "wzor". Domyslnie "glowna" (prostszy przypadek, zero dodatkowego pliku).
function dokSeryjneZrodloPola(sufiks, excelFieldId, templatesFieldId) {
  const radioName = `dokSeryjneZrodlo_${sufiks}`;
  return `
    <label><input type="radio" name="${radioName}" value="glowna" checked data-dok-seryjne-radio="${sufiks}" /> Użyj głównej tabeli adresowej</label>
    <label><input type="radio" name="${radioName}" value="osobna" data-dok-seryjne-radio="${sufiks}" /> Użyj osobnej tabeli (z folderu wzoru)</label>
    <div class="hidden" data-dok-seryjne-plik="${sufiks}">${fileField(excelFieldId, 'Tabela Excel dla dokumentów seryjnych', 'Z folderu "wzór" tej gałęzi - inna niż główna tabela adresowa.')}</div>
    <label>Szablony Word (.docx)
      <input type="file" id="${templatesFieldId}" accept=".docx" multiple required />
      <span class="field-help">Wybierz konkretne szablony z folderu "wzór" - tak samo jak w samych Dokumentach seryjnych, nie cały folder naraz.</span>
    </label>
  `;
}

function krokCheckbox(id, tytul, opis) {
  return `<div class="krok-card" data-krok="${id}">
    <label class="krok-head"><input type="checkbox" data-krok-checkbox="${id}" /><strong>${escapeHtml(tytul)}</strong></label>
    <p class="krok-desc">${escapeHtml(opis)}</p>
  </div>`;
}

function renderKrokiForm(analiza) {
  const p = analiza.podsumowanie;
  const majaPompyPowietrzne = p.pompyPowietrzne > 0;
  const majaPompy = p.pompyPowietrzne > 0 || p.pompyGrunt > 0 || p.pompyNieznane > 0;
  const majaSolary = p.kolektory > 0;
  const majaCokolwiek = majaPompy || majaSolary || p.kotly > 0;

  const tfFields = document.querySelector('[data-krok-fields="tworzenieFolderow"]');
  tfFields.innerHTML = pathField('pole_investmentFolder', 'Folder inwestycji (już istniejący)');
  tfFields.classList.add('hidden');
  tfFields.querySelector('[data-browse-for]').addEventListener('click', () => openFolderBrowser(document.querySelector('#pole_investmentFolder')));
  const tfCheckbox = document.querySelector('[data-krok-checkbox="tworzenieFolderow"]');
  tfCheckbox.checked = false;
  tfCheckbox.onchange = e => tfFields.classList.toggle('hidden', !e.target.checked);

  const wspolneBox = document.querySelector('#danaWspolneBox');
  if (majaCokolwiek) {
    wspolneBox.classList.remove('hidden');
    document.querySelector('#danaWspolnePola').innerHTML = [
      pathField('pole_audytyPath', 'Folder z gotowymi audytami (PDF)'),
      majaPompyPowietrzne ? textField('pole_lokalizacja', 'Lokalizacja / gmina inwestycji') : ''
    ].join('');
    document.querySelectorAll('#danaWspolnePola [data-browse-for]').forEach(btn => {
      btn.addEventListener('click', () => openFolderBrowser(document.querySelector(`#${btn.dataset.browseFor}`)));
    });
  } else {
    wspolneBox.classList.add('hidden');
  }

  const grupy = [];
  if (majaSolary) {
    grupy.push(`<div class="typ-grupa" data-typ-grupa="solary">
      <label class="typ-grupa-tytul"><input type="checkbox" data-typ-master="solary" checked /> Solary</label>
      <div data-typ-grupa-body="solary">
      ${pathField('pole_rootPathSolary', 'Główny folder Solary/Kolektory', 'np. ...\\Kolektory')}
      <div class="krok-fields" style="margin:12px 0 0">
        <label><input type="checkbox" data-krok-checkbox="solary" /> Przypisywanie kart katalogowych</label>
        <label><input type="checkbox" data-krok-checkbox="audytySolary" /> Dołącz audyty</label>
        <div>
          <label><input type="checkbox" data-krok-checkbox="dokSeryjneSolary" /> Dokumenty seryjne</label>
          <div class="krok-fields hidden" data-krok-fields="dokSeryjneSolary" style="margin-left:0">${dokSeryjneZrodloPola('solary', 'pole_dokSeryjneExcelSolary', 'pole_dokSeryjneTemplatesSolary')}</div>
        </div>
      </div>
      </div>
    </div>`);
  }
  if (majaPompy) {
    grupy.push(`<div class="typ-grupa" data-typ-grupa="pompy">
      <label class="typ-grupa-tytul"><input type="checkbox" data-typ-master="pompy" checked /> Pompy</label>
      <div data-typ-grupa-body="pompy">
      ${pathField('pole_rootPathPompy', 'Główny folder inwestycji (z podfolderem PC powietrzne/gruntowe)')}
      <div class="krok-fields" style="margin:12px 0 0">
        <label><input type="checkbox" data-krok-checkbox="pompy" /> Przypisywanie kart katalogowych</label>
        <label><input type="checkbox" data-krok-checkbox="audytyPompy" /> Dołącz audyty</label>
        <div>
          <label><input type="checkbox" data-krok-checkbox="dokSeryjnePompy" /> Dokumenty seryjne</label>
          <div class="krok-fields hidden" data-krok-fields="dokSeryjnePompy" style="margin-left:0">${dokSeryjneZrodloPola('pompy', 'pole_dokSeryjneExcelPompy', 'pole_dokSeryjneTemplatesPompy')}</div>
        </div>
      </div>
      ${!majaPompyPowietrzne && (p.pompyGrunt > 0 || p.pompyNieznane > 0) ? `
      <p class="field-help">Dobory myEcodan/Varmero nie są tu dostępne - w tabeli nie wykryto żadnej pompy powietrznej.${p.pompyNieznane > 0 ? ` ${p.pompyNieznane} wiersz(y) ma nierozpoznany rodzaj pompy - sprawdź kolumnę "Rodzaj pompy" w Excelu (musi zawierać słowo "powietrzna"), jeśli spodziewałeś się tu Doborów.` : ''}</p>` : ''}
      ${majaPompyPowietrzne ? `
      <h4 style="margin:16px 0 8px">Dobory (tylko pompy powietrzne)</h4>
      <div class="krok-fields">
        <div>
          <label><input type="checkbox" data-krok-checkbox="gen_myEcodan" /> Dobór myEcodan</label>
        </div>
        <div>
          <label><input type="checkbox" data-krok-checkbox="gen_varmero" /> Dobór Varmero</label>
          <div class="krok-fields hidden" data-krok-fields="gen_varmero" style="margin-left:0">
            ${textField('pole_gen_varmero_postalCode', 'Kod pocztowy')}
            <label>Strefa klimatyczna<select id="pole_gen_varmero_zone"><option value="">wybierz...</option><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option></select></label>
            ${textField('pole_gen_varmero_wojewodztwo', 'Województwo')}
          </div>
        </div>
      </div>` : ''}
      </div>
    </div>`);
  }

  const kontener = document.querySelector('#grupaTypowKontener');
  kontener.innerHTML = grupy.join('');
  kontener.querySelectorAll('[data-typ-master]').forEach(cb => {
    const body = kontener.querySelector(`[data-typ-grupa-body="${cb.dataset.typMaster}"]`);
    cb.addEventListener('change', () => body.classList.toggle('hidden', !cb.checked));
  });
  kontener.querySelectorAll('[data-browse-for]').forEach(btn => {
    btn.addEventListener('click', () => openFolderBrowser(document.querySelector(`#${btn.dataset.browseFor}`)));
  });
  kontener.querySelectorAll('[data-krok-checkbox]').forEach(cb => {
    const fields = kontener.querySelector(`[data-krok-fields="${cb.dataset.krokCheckbox}"]`);
    if (!fields) return;
    cb.addEventListener('change', () => fields.classList.toggle('hidden', !cb.checked));
  });
  kontener.querySelectorAll('[data-dok-seryjne-radio]').forEach(radio => {
    radio.addEventListener('change', () => {
      const sufiks = radio.dataset.dokSeryjneRadio;
      const plikBox = kontener.querySelector(`[data-dok-seryjne-plik="${sufiks}"]`);
      const wybranaOsobna = kontener.querySelector(`[data-dok-seryjne-radio="${sufiks}"]:checked`)?.value === 'osobna';
      plikBox.classList.toggle('hidden', !wybranaOsobna);
    });
  });

  document.querySelector('#krokiPanel').classList.remove('hidden');
  document.querySelector('#krokiPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function wartoscPola(id) {
  const el = document.querySelector(`#${id}`);
  return el ? el.value.trim() : '';
}

function krokZaznaczony(id) {
  const cb = document.querySelector(`[data-krok-checkbox="${id}"]`);
  return !!(cb && cb.checked);
}

function dokSeryjneUzywaOsobnejTabeli(sufiks) {
  return document.querySelector(`[data-dok-seryjne-radio="${sufiks}"]:checked`)?.value === 'osobna';
}

// --- Krok 3: uruchomienie i sledzenie przebiegu ---

document.querySelector('#startBtn').addEventListener('click', async () => {
  hideTopNotice();
  if (!currentExcelFile) { showTopNotice('Najpierw wgraj tabelę adresową.'); return; }

  // Glowny przelacznik typu (audyt 2026-08-24 - wlasciciel: "nie mam
  // prostego wyboru czy robie pompy czy solary") - odznaczenie calej grupy
  // musi wygaszac wszystkie jej kroki, nawet jesli user zdazyl cos zaznaczyc
  // przed zwinieciem sekcji.
  const solaryWlaczone = document.querySelector('[data-typ-master="solary"]')?.checked !== false;
  const pompyWlaczone = document.querySelector('[data-typ-master="pompy"]')?.checked !== false;
  const kroki = {
    tworzenieFolderow: krokZaznaczony('tworzenieFolderow'),
    solary: solaryWlaczone && krokZaznaczony('solary'),
    pompy: pompyWlaczone && krokZaznaczony('pompy'),
    audytySolary: solaryWlaczone && krokZaznaczony('audytySolary'),
    audytyPompy: pompyWlaczone && krokZaznaczony('audytyPompy'),
    dokSeryjneSolary: solaryWlaczone && krokZaznaczony('dokSeryjneSolary'),
    dokSeryjnePompy: pompyWlaczone && krokZaznaczony('dokSeryjnePompy')
  };
  const generatory = {
    myEcodan: pompyWlaczone && krokZaznaczony('gen_myEcodan'),
    varmero: pompyWlaczone && krokZaznaczony('gen_varmero')
  };
  const lokalizacja = wartoscPola('pole_lokalizacja');
  const opcjeDoboru = {
    myEcodan: { investmentName: lokalizacja, location: lokalizacja },
    varmero: {
      gminaName: lokalizacja,
      postalCode: wartoscPola('pole_gen_varmero_postalCode'),
      zone: wartoscPola('pole_gen_varmero_zone'),
      wojewodztwo: wartoscPola('pole_gen_varmero_wojewodztwo')
    }
  };

  if (generatory.varmero && !opcjeDoboru.varmero.zone) {
    showTopNotice('Dobór Varmero wymaga podania strefy klimatycznej (1-5) - kalkulator jej wymaga, a nie da się jej wyczytać z tabeli adresowej.');
    return;
  }
  if (kroki.dokSeryjneSolary && dokSeryjneUzywaOsobnejTabeli('solary') && !document.querySelector('#pole_dokSeryjneExcelSolary')?.files?.[0]) {
    showTopNotice('Wybrano "osobną tabelę" dla dokumentów seryjnych (Solary), ale nie wskazano pliku.');
    return;
  }
  if (kroki.dokSeryjnePompy && dokSeryjneUzywaOsobnejTabeli('pompy') && !document.querySelector('#pole_dokSeryjneExcelPompy')?.files?.[0]) {
    showTopNotice('Wybrano "osobną tabelę" dla dokumentów seryjnych (Pompy), ale nie wskazano pliku.');
    return;
  }
  if (kroki.dokSeryjneSolary && !document.querySelector('#pole_dokSeryjneTemplatesSolary')?.files?.length) {
    showTopNotice('Dokumenty seryjne (Solary): wybierz przynajmniej jeden szablon .docx.');
    return;
  }
  if (kroki.dokSeryjnePompy && !document.querySelector('#pole_dokSeryjneTemplatesPompy')?.files?.length) {
    showTopNotice('Dokumenty seryjne (Pompy): wybierz przynajmniej jeden szablon .docx.');
    return;
  }
  const zadenKrok = !Object.values(kroki).some(Boolean) && !Object.values(generatory).some(Boolean);
  if (zadenKrok) { showTopNotice('Zaznacz przynajmniej jeden krok do wykonania.'); return; }

  const selection = Object.fromEntries([...zaznaczoneAdresy.entries()].map(([sheetName, set]) => [sheetName, [...set]]));

  const data = new FormData();
  data.append('excel', currentExcelFile);
  data.append('investmentFolder', wartoscPola('pole_investmentFolder'));
  data.append('rootPathSolary', wartoscPola('pole_rootPathSolary'));
  data.append('rootPathPompy', wartoscPola('pole_rootPathPompy'));
  data.append('audytyPath', wartoscPola('pole_audytyPath'));
  data.append('kroki', JSON.stringify(kroki));
  data.append('generatory', JSON.stringify(generatory));
  data.append('opcjeDoboru', JSON.stringify(opcjeDoboru));
  data.append('selection', JSON.stringify(selection));
  if (dokSeryjneUzywaOsobnejTabeli('solary')) {
    const plik = document.querySelector('#pole_dokSeryjneExcelSolary')?.files?.[0];
    if (plik) data.append('dokSeryjneExcelSolary', plik);
  }
  if (dokSeryjneUzywaOsobnejTabeli('pompy')) {
    const plik = document.querySelector('#pole_dokSeryjneExcelPompy')?.files?.[0];
    if (plik) data.append('dokSeryjneExcelPompy', plik);
  }
  if (kroki.dokSeryjneSolary) {
    for (const plik of document.querySelector('#pole_dokSeryjneTemplatesSolary')?.files || []) data.append('dokSeryjneTemplatesSolary', plik);
  }
  if (kroki.dokSeryjnePompy) {
    for (const plik of document.querySelector('#pole_dokSeryjneTemplatesPompy')?.files || []) data.append('dokSeryjneTemplatesPompy', plik);
  }

  const btn = document.querySelector('#startBtn');
  btn.disabled = true;
  btn.textContent = 'Uruchamiam...';

  try {
    const res = await fetch('/api/pipeline/start', { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' }, body: data });
    const json = await res.json().catch(() => null);
    if (!json || !json.ok) {
      showTopNotice(json?.error || 'Nie udało się uruchomić przebiegu.');
      btn.disabled = false;
      btn.textContent = 'Uruchom pipeline';
      return;
    }
    currentRunId = json.runId;
    localStorage.setItem(OSTATNI_RUN_KLUCZ, json.runId);
    document.querySelector('#runPanel').classList.remove('hidden');
    document.querySelector('#runPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    startPolling();
  } catch (error) {
    showTopNotice(String(error.message || error));
    btn.disabled = false;
    btn.textContent = 'Uruchom pipeline';
  }
});

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  refreshStatus();
  pollTimer = setInterval(refreshStatus, 3000);
}

async function refreshStatus() {
  if (!currentRunId) return;
  try {
    const res = await fetch(`/api/pipeline/status/${currentRunId}`);
    const json = await res.json().catch(() => null);
    if (!json || !json.ok) {
      if (res.status === 404) {
        showTopNotice(json?.error || 'Nie znaleziono tego przebiegu - mógł zostać usunięty po dłuższym czasie.');
        clearInterval(pollTimer);
        pollTimer = null;
      }
      return;
    }
    renderRun(json.run);
    if (json.run.status === 'skonczony' || json.run.status === 'blad') {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  } catch (_) { /* przejsciowy blad sieci - kolejny tick sprobuje ponownie */ }
}

const STATUS_LABELS = {
  running: 'w toku', 'oczekuje-doborow': 'oczekuje na dobory', skonczony: 'skończony',
  blad: 'błąd', 'przerwany-restartem': 'przerwany restartem serwera', przerwany: 'przerwany'
};
const STATUSY_ZAKONCZONE = ['skonczony', 'blad', 'przerwany', 'przerwany-restartem'];

const KROK_STATUS_LABELS = {
  'w-toku': 'w toku', zgloszono: 'zgłoszono', skonczony: 'skończony', rozdzielono: 'rozdzielono', blad: 'błąd', przerwany: 'przerwany'
};

function renderRun(run) {
  document.querySelector('#runInfo').textContent = `Status przebiegu: ${STATUS_LABELS[run.status] || run.status} (ostatnia aktualizacja: ${new Date(run.updatedAt).toLocaleTimeString('pl-PL')})`;

  const listEl = document.querySelector('#krokiWynikList');
  if ((run.kroki || []).length) {
    listEl.classList.remove('hidden');
    listEl.innerHTML = run.kroki.map(k => {
      const maPasek = typeof k.procent === 'number';
      const zakonczony = ['skonczony', 'rozdzielono', 'blad', 'zgloszono', 'przerwany'].includes(k.status);
      return `<div class="krok-progress-item">
        <div class="krok-progress-top">
          <span>${escapeHtml(k.nazwa)}</span>
          <span class="badge ${badgeDlaStatusu(k.status)}">${escapeHtml(KROK_STATUS_LABELS[k.status] || k.status)}</span>
        </div>
        ${!zakonczony ? `<div class="krok-progress-bar-track"><div class="krok-progress-bar-fill ${maPasek ? '' : 'indeterminate'}" style="${maPasek ? `width:${k.procent}%` : ''}"></div></div>` : ''}
        ${k.wiadomosc || k.komunikat ? `<div class="krok-progress-msg">${escapeHtml(k.wiadomosc || k.komunikat)}</div>` : ''}
      </div>`;
    }).join('');
  } else {
    listEl.classList.add('hidden');
  }

  const generatoryUzyte = run.input?.generatory?.myEcodan || run.input?.generatory?.varmero;
  document.querySelector('#collectDoboryActions').classList.toggle('hidden', !generatoryUzyte);
  document.querySelector('#cancelRunBtn').classList.toggle('hidden', STATUSY_ZAKONCZONE.includes(run.status));
}

function badgeDlaStatusu(status) {
  if (status === 'skonczony' || status === 'rozdzielono') return 'ok';
  if (status === 'blad' || status === 'przerwany') return 'bad';
  if (status === 'w-toku' || status === 'zgloszono') return 'wait';
  return 'skip';
}

document.querySelector('#cancelRunBtn').addEventListener('click', async () => {
  if (!currentRunId) return;
  if (!confirm('Przerwać ten przebieg? Aktywne zgłoszenia do myEcodan/Varmero zostaną anulowane, a kolejne kroki się nie odpalą. Już rozłożone pliki zostają na miejscu.')) return;
  const btn = document.querySelector('#cancelRunBtn');
  btn.disabled = true;
  try {
    const res = await fetch(`/api/pipeline/${currentRunId}/cancel`, { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' } });
    const json = await res.json().catch(() => null);
    if (!json || !json.ok) {
      showTopNotice(json?.error || 'Nie udało się przerwać przebiegu.');
    } else {
      renderRun(json.run);
    }
  } catch (error) {
    showTopNotice(String(error.message || error));
  } finally {
    btn.disabled = false;
  }
});

document.querySelector('#collectDoboryBtn').addEventListener('click', async () => {
  if (!currentRunId) return;
  const btn = document.querySelector('#collectDoboryBtn');
  btn.disabled = true;
  try {
    const res = await fetch(`/api/pipeline/${currentRunId}/collect-dobory`, { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' } });
    const json = await res.json().catch(() => null);
    if (!json || !json.ok) {
      showTopNotice(json?.error || 'Nie udało się sprawdzić statusu doborów.');
    } else {
      renderRun(json.run);
      if (!json.wynikiKroku?.length) {
        showTopNotice('Wszystkie dobory zostały już wcześniej rozłożone albo zakończyły się błędem - nie ma nic nowego do zrobienia.', 'blue');
      } else if (json.wynikiKroku.every(w => w.status === 'oczekujace')) {
        showTopNotice('Karty/wyniki jeszcze nie są gotowe - spróbuj ponownie później.', 'blue');
      }
    }
  } catch (error) {
    showTopNotice(String(error.message || error));
  } finally {
    btn.disabled = false;
  }
});
