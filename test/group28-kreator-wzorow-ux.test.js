// Kreator wzorow seryjnych - przeglad UX/optymalizacji 2026-09-28:
//  - podglad z ZBUDOWANEGO wzoru (wczesniej z oryginalnego Worda: brak
//    podmiany pol, blad "Brak bookmarka" przy kazdym bloku),
//  - edycja istniejacego pola/bloku (PUT) zamiast duplikatow, osierocone
//    definicje nie trafiaja do manifestu,
//  - "Dolacz do istniejacego bloku", podglad warunku na zywo,
//  - podpowiedzi: warunek (prog liczbowy / kategoria), stala dla wartosci
//    wspolnej wszystkim wierszom, linia z wynikiem obliczen -> projektant,
//  - paleta: kolor tylko z naglowkow tabel nie jest domyslnie zaznaczony,
//  - nowy front (kroki, panel obok listy, bez alert()).
// Test end-to-end przez HTTP uruchamia sie tylko tam, gdzie jest prawdziwy
// Scyzoryk.DocumentEngine.exe (+ x2t dla podgladu PDF) - inaczej skip.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const tm = require('../apps/kreator-wzorow/src/templateManifest');
const autoConfig = require('../apps/kreator-wzorow/src/autoConfigurator');
const { applyAutoConfiguration } = require('../apps/kreator-wzorow/src/autoConfigApply');
const documentEngine = require('../lib/documentEngine');
const AdmZip = require('../apps/kreator-wzorow/node_modules/adm-zip');

async function readSrc(...parts) {
  return (await fsp.readFile(path.join(ROOT, ...parts), 'utf8')).replace(/^﻿/, '').replace(/\r\n/g, '\n');
}

// --- templateManifest --------------------------------------------------------

function draftWithFieldAndBlock() {
  let draft = tm.seedCandidates(tm.emptyDraft({ templateName: 'T', addressColumn: 'Adres' }), ['c1', 'c2', 'c3']);
  const f = tm.createFieldForCandidate(draft, 'c1', { label: 'Adres', required: true, valueSpec: { type: 'column', column: 'Adres' } });
  draft = f.draft;
  const b = tm.createBlockForCandidate(draft, 'c2', { label: 'Moc', condition: { column: 'Moc', operator: 'lt', value: '6.5' } });
  return { draft: b.draft, fieldId: f.fieldId, blockId: b.blockId };
}
const CANDS = [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }];

test('templateManifest: osierocone pole/blok (po zmianie decyzji) NIE trafia do manifestu - wczesniej dawalo "Brak bookmarka" w kazdym dokumencie', () => {
  const { draft, fieldId, blockId } = draftWithFieldAndBlock();
  const before = tm.buildManifestFromDraft(draft, CANDS);
  assert.deepEqual(before.fields.map(f => f.id), [fieldId]);
  assert.deepEqual(before.blocks.map(b => b.id), [blockId]);

  // Ponowny zapis c2 jako NOWY blok (stary scenariusz edycji) zostawial stary blok w drafcie.
  const re = tm.createBlockForCandidate(draft, 'c2', { label: 'Moc 2', condition: { column: 'Moc', operator: 'lt', value: '7' } });
  const reManifest = tm.buildManifestFromDraft(re.draft, CANDS);
  assert.deepEqual(reManifest.blocks.map(b => b.id), [re.blockId], 'stary blok nie moze zostac w manifescie');

  // Kandydat pola zmieniony na "Do projektanta" - pole znika z manifestu.
  const manual = tm.setCandidateManual(draft, 'c1', null);
  assert.deepEqual(tm.buildManifestFromDraft(manual, CANDS).fields, []);
});

test('templateManifest: updateField/updateBlock zachowuja id, mergeFieldName i bookmarkName', () => {
  const { draft, fieldId, blockId } = draftWithFieldAndBlock();
  const oldMerge = draft.fields[fieldId].mergeFieldName;
  const oldBookmark = draft.blocks[blockId].bookmarkName;
  const d1 = tm.updateField(draft, fieldId, { label: 'Adres budowy', required: false, valueSpec: { type: 'column', column: 'Adres 2' }, mergeFieldName: 'HACK' });
  assert.equal(d1.fields[fieldId].mergeFieldName, oldMerge);
  assert.equal(d1.fields[fieldId].label, 'Adres budowy');
  assert.equal(d1.fields[fieldId].valueSpec.column, 'Adres 2');
  const d2 = tm.updateBlock(d1, blockId, { label: 'Moc < 8', condition: { column: 'Moc', operator: 'lt', value: '8' }, bookmarkName: 'HACK' });
  assert.equal(d2.blocks[blockId].bookmarkName, oldBookmark);
  assert.equal(d2.blocks[blockId].condition.value, '8');
  assert.equal(Object.keys(d2.blocks).length, 1, 'edycja nie tworzy duplikatu');
  assert.throws(() => tm.updateField(d2, 'fld_nie_ma', {}), /Nie istnieje pole/);
  assert.throws(() => tm.updateBlock(d2, 'blk_nie_ma', {}), /Nie istnieje blok/);
});

test('templateManifest: assignCandidateToExistingBlock - drugi fragment dzieli ten sam blok (jeden bookmark), liczniki uzycia', () => {
  const { draft, blockId, fieldId } = draftWithFieldAndBlock();
  const d = tm.assignCandidateToExistingBlock(draft, 'c3', blockId);
  assert.equal(d.candidates.c3.status, 'block');
  assert.equal(d.candidates.c3.blockId, blockId);
  assert.equal(tm.countBlockUsage(d, blockId), 2);
  assert.equal(tm.countFieldUsage(d, fieldId), 1);
  assert.equal(tm.buildManifestFromDraft(d, CANDS).blocks.length, 1);
});

// --- autoConfigurator: nowe podpowiedzi ---------------------------------------

const SHEET = {
  columns: ['Adres', 'Moc kWp', 'Typ budynku', 'Gmina'],
  rows: [
    { _record: 1, 'Adres': 'Kamion 5', 'Moc kWp': 4.32, 'Typ budynku': 'mieszkalny', 'Gmina': 'Gmina Wierzchlas' },
    { _record: 2, 'Adres': 'Wierzchlas 12', 'Moc kWp': 5.4, 'Typ budynku': 'mieszkalny', 'Gmina': 'Gmina Wierzchlas' },
    { _record: 3, 'Adres': 'Łążek 7', 'Moc kWp': '7,2', 'Typ budynku': 'gospodarczy', 'Gmina': 'Gmina Wierzchlas' },
  ],
};

test('detectBlockCandidate: prog liczbowy z jednostka z nazwy kolumny ("ponizej 6,5 kWp" -> Moc kWp < 6.5), oryginalna fraza w uzasadnieniu', () => {
  const cols = autoConfig.profileWorkbookColumns(SHEET);
  const s = autoConfig.detectBlockCandidate({ text: 'Instalacja o mocy poniżej 6,5 kWp nie wymaga uzgodnienia z rzeczoznawcą ds. ppoż.' }, cols, 'unresolved');
  assert.deepEqual(s.condition, { column: 'Moc kWp', operator: 'lt', value: '6.5' });
  assert.equal(s.label, 'Moc kWp < 6.5');
  assert.match(s.reasons[0].message, /poniżej 6,5 kWp/);
  const over = autoConfig.detectBlockCandidate({ text: 'Dla instalacji o mocy powyżej 10 kWp wymagane jest dodatkowe zabezpieczenie.' }, cols, 'unresolved');
  assert.equal(over.condition.operator, 'gt');
});

test('detectBlockCandidate: kategoria (dokladnie jedna wartosc kolumny o malej liczbie wariantow w tekscie)', () => {
  const cols = autoConfig.profileWorkbookColumns(SHEET);
  const s = autoConfig.detectBlockCandidate({ text: 'Budynek mieszkalny jednorodzinny – dach skośny, pokrycie blachodachówka.' }, cols, 'unresolved');
  assert.deepEqual(s.condition, { column: 'Typ budynku', operator: 'equals', value: 'mieszkalny' });
});

test('detectBlockCandidate: brak podpowiedzi dla krotkiego tekstu, dopasowanej kolumny i niejednoznacznosci', () => {
  const cols = autoConfig.profileWorkbookColumns(SHEET);
  assert.equal(autoConfig.detectBlockCandidate({ text: 'poniżej 6,5 kWp' }, cols, 'unresolved'), null, 'za krotki');
  assert.equal(autoConfig.detectBlockCandidate({ text: 'Instalacja o mocy poniżej 6,5 kWp nie wymaga uzgodnienia z rzeczoznawcą.' }, cols, 'auto'), null, 'wyraznie pole z Excela');
  assert.equal(autoConfig.detectBlockCandidate({ text: 'Budynek mieszkalny lub gospodarczy – opis wspólny dla wszystkich obiektów.' }, cols, 'unresolved'), null, 'dwie wartosci tej samej kolumny');
  assert.equal(autoConfig.detectBlockCandidate({ text: 'Przewód o długości do 25 m ułożony w rurce ochronnej na całej trasie.' }, cols, 'unresolved'), null, 'jednostka bez kolumny');
});

test('detectConstantCandidate: wartosc wspolna wszystkim wierszom kolumny -> review "stala"', () => {
  const cols = autoConfig.profileWorkbookColumns(SHEET);
  const s = autoConfig.detectConstantCandidate({ text: 'Gmina Wierzchlas' }, [{ score: 10 }], 1, 'unresolved', cols);
  assert.equal(s.tier, 'review');
  assert.equal(s.reasons[0].code, 'CONSTANT_UNIFORM_COLUMN');
  assert.equal(autoConfig.detectConstantCandidate({ text: 'Kamion 5' }, [{ score: 10 }], 1, 'unresolved', cols).tier, 'none');
});

test('classifyManualCandidate: krotka linia wyniku obliczen ("Spadek napiecia ...: 0,87%") -> review, samo slowo-klucz dalej nie', () => {
  assert.equal(autoConfig.classifyManualCandidate({ text: '0,87%', paragraphText: 'Spadek napięcia na odcinku DC: 0,87%' }, 'unresolved').tier, 'review');
  assert.equal(autoConfig.classifyManualCandidate({ text: 'Konstrukcja', paragraphText: 'Konstrukcja' }, 'unresolved').tier, 'none');
});

test('analyzeAutoConfiguration + applyAutoConfiguration: podpowiedz warunku akceptowana jednym kliknieciem tworzy blok; "Zastosuj pewne" nigdy nie ustawia blokow ani stalych', () => {
  const candidates = [
    { id: 'blk', text: 'Instalacja o mocy poniżej 6,5 kWp nie wymaga uzgodnienia z rzeczoznawcą ds. ppoż.', paragraphText: 'Instalacja o mocy poniżej 6,5 kWp nie wymaga uzgodnienia z rzeczoznawcą ds. ppoż.' },
    { id: 'gm', text: 'Gmina Wierzchlas', paragraphText: 'Inwestycja: Gmina Wierzchlas' },
  ];
  const workbook = { sheetNames: ['Dane'], defaultSheet: 'Dane', sheets: { Dane: SHEET } };
  const draft = tm.seedCandidates(tm.emptyDraft({ preferredSheet: 'Dane', addressColumn: 'Adres' }), candidates.map(c => c.id));
  const analysis = autoConfig.analyzeAutoConfiguration({ candidates, workbook, sheetName: 'Dane', draft });
  const byId = Object.fromEntries(analysis.candidateSuggestions.map(s => [s.candidateId, s]));
  assert.equal(byId.blk.kind, 'block');
  assert.equal(byId.blk.tier, 'review');
  assert.deepEqual(byId.blk.proposedBlock.condition, { column: 'Moc kWp', operator: 'lt', value: '6.5' });
  assert.equal(byId.gm.kind, 'constant');

  const mass = applyAutoConfiguration(draft, analysis, { applyHighConfidence: true, candidates });
  assert.equal(mass.appliedCount, 0);

  const one = applyAutoConfiguration(draft, analysis, { suggestionIds: ['blk', 'gm'], candidates });
  assert.equal(one.appliedCount, 2);
  assert.equal(one.draft.candidates.blk.status, 'block');
  assert.deepEqual(one.draft.blocks[one.draft.candidates.blk.blockId].condition, { column: 'Moc kWp', operator: 'lt', value: '6.5' });
  assert.equal(one.draft.candidates.gm.status, 'constant');
  assert.equal(one.draft.candidates.gm.constantText, null, 'stala = zostaw obecny tekst, nic nie jest zgadywane');
});

// --- statycznie: serwer i front ------------------------------------------------

test('server: podglad buduje wzor (buildSmartTemplate) do katalogu podgladu i dopiero ten plik idzie do mail-merge; bledy silnika w odpowiedzi', async () => {
  const src = await readSrc('apps', 'kreator-wzorow', 'server.js');
  const route = src.slice(src.indexOf("app.post('/api/jobs/:jobId/preview'"), src.indexOf("app.post('/api/jobs/:jobId/build'"));
  const buildIdx = route.indexOf('documentEngine.buildSmartTemplate(');
  const mergeIdx = route.indexOf("documentEngine.runEngineCommand('mail-merge'");
  assert.ok(buildIdx > 0 && mergeIdx > buildIdx, 'build przed mail-merge');
  assert.match(route, /templatePath: previewTemplatePath,/);
  assert.match(route, /errors: engineErrors/);
});

test('front: bez alert(), paleta z domyslnym wyborem, panel obok listy, jeden krok "Sprawdz i zbuduj", wznowienie pracy', async () => {
  const js = await readSrc('apps', 'kreator-wzorow', 'public', 'app.js');
  const html = await readSrc('apps', 'kreator-wzorow', 'public', 'index.html');
  assert.doesNotMatch(js, /\balert\(/);
  assert.match(js, /m\.suggested !== false/);
  assert.match(js, /await detectMarkings\(\);/, 'paleta wykrywana od razu po wczytaniu plikow');
  assert.match(js, /PUT', jobUrl\(`\/fields\/\$\{encodeURIComponent\(existingId\)\}`\)/);
  assert.match(js, /PUT', jobUrl\(`\/blocks\/\$\{encodeURIComponent\(existingId\)\}`\)/);
  assert.match(js, /condition-preview/);
  assert.match(js, /localStorage|lsGet\(LAST_JOB_KEY\)/);
  assert.match(html, /id="stepper"/);
  assert.match(html, /class="config-grid"/);
  assert.match(html, /id="saveConfigBtn"/);
  assert.doesNotMatch(html, /id="step4Panel"[\s\S]*id="step5Panel"/);
  assert.doesNotMatch(html, /Sprawdź wzór<\/button>[\s\S]*Sprawdź wzór<\/button>/, 'jeden przycisk o tej nazwie');
});

// --- end-to-end przez HTTP z prawdziwym silnikiem -----------------------------

function run(text, highlight) {
  const rPr = highlight ? `<w:rPr><w:highlight w:val="${highlight}"/></w:rPr>` : '';
  return `<w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r>`;
}
function cell(text, fill) {
  const tcPr = fill ? `<w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="${fill}"/></w:tcPr>` : '';
  return `<w:tc>${tcPr}<w:p>${run(text)}</w:p></w:tc>`;
}
function buildFixtureDocx() {
  const body = [
    `<w:p>${run('Adres inwestycji: ')}${run('Wierzchlas 12', 'yellow')}</w:p>`,
    `<w:p>${run('Inwestor: ')}${run('Jan Kowalski', 'yellow')}</w:p>`,
    `<w:p>${run('Projektowana moc: ')}${run('5,4', 'yellow')}${run(' kWp.')}</w:p>`,
    `<w:p>${run('Instalacja o mocy poniżej 6,5 kWp nie wymaga uzgodnienia z rzeczoznawcą ds. ppoż.', 'green')}</w:p>`,
    `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol/><w:gridCol/></w:tblGrid><w:tr>${cell('Pozycja', 'D9E2F3')}${cell('Wartość', 'D9E2F3')}</w:tr><w:tr>${cell('Falownik:')}${cell('SolarEdge SE5K', 'FFE599')}</w:tr></w:tbl>`,
    `<w:p>${run('Koniec.')}</w:p>`,
  ].join('');
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>', 'utf8'));
  zip.addFile('_rels/.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>', 'utf8'));
  zip.addFile('word/document.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`, 'utf8'));
  return zip.toBuffer();
}
async function buildFixtureXlsx(dir) {
  const ExcelJS = require('../apps/ocr-audytow/node_modules/exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Dane');
  ws.addRow(['Adres', 'Imię i nazwisko', 'Moc kWp', 'Falownik']);
  ws.addRow(['Kamion 5', 'Maria Wiśniewska', 4.32, 'Huawei SUN2000']);
  ws.addRow(['Wierzchlas 12', 'Jan Kowalski', 5.4, 'SolarEdge SE5K']);
  ws.addRow(['Łążek 7', 'Zofia Żółkiewska', 7.2, 'Fronius Primo']);
  const file = path.join(dir, 'dane.xlsx');
  await wb.xlsx.writeFile(file);
  return fsp.readFile(file);
}

const canRunEngine = process.platform === 'win32' && documentEngine.isEngineAvailable() && Boolean(documentEngine.resolveOnlyOfficeDir());

test('e2e HTTP: pliki -> paleta (naglowek odznaczony) -> skan -> podpowiedzi (w tym warunek) -> edycja bloku -> podglad z danymi INNEGO wiersza -> budowa', { skip: !canRunEngine && 'brak Scyzoryk.DocumentEngine.exe albo x2t', timeout: 5 * 60 * 1000 }, async (t) => {
  const dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-kreator-ux-'));
  const previous = process.env.SCYZORYK_DATA_ROOT;
  process.env.SCYZORYK_DATA_ROOT = dataRoot;
  delete require.cache[require.resolve('../apps/kreator-wzorow/server.js')];
  const { app } = require('../apps/kreator-wzorow/server.js');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    if (previous === undefined) delete process.env.SCYZORYK_DATA_ROOT; else process.env.SCYZORYK_DATA_ROOT = previous;
    await fsp.rm(dataRoot, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const H = { 'X-Scyzoryk-Request': '1' };
  const api = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: body ? { ...H, 'Content-Type': 'application/json' } : H, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json();
    assert.ok(res.ok && json.ok !== false, `${method} ${url}: ${JSON.stringify(json)}`);
    return json;
  };

  const form = new FormData();
  form.append('template', new Blob([buildFixtureDocx()]), 'Wzór PV.docx');
  form.append('excel', new Blob([await buildFixtureXlsx(dataRoot)]), 'dane.xlsx');
  const up = await (await fetch(`${base}/api/jobs`, { method: 'POST', headers: H, body: form })).json();
  assert.ok(up.ok, JSON.stringify(up));
  const job = `/api/jobs/${up.jobId}`;

  const palette = (await api('POST', `${job}/scan-markings`, {})).markings;
  const header = palette.find(m => m.key === 'shading:D9E2F3');
  assert.equal(header.suggested, false, 'kolor tylko z naglowka tabeli nie jest domyslnie zaznaczony');
  const selected = palette.filter(m => m.suggested !== false).map(m => m.key);
  assert.equal(selected.length, 3);

  const scan = await api('POST', `${job}/scan`, { sheetName: 'Dane', selectedMarkings: selected });
  assert.equal(scan.candidates.length, 5);
  let state = (await api('GET', job)).job;
  await api('PUT', `${job}/config`, { ...state.draft, addressColumn: 'Adres', preferredSheet: 'Dane' });
  await api('POST', `${job}/auto-configure/analyze`, { sheetName: 'Dane' });
  state = (await api('GET', job)).job;
  const blockSuggestion = state.autoConfig.candidateSuggestions.find(s => s.kind === 'block');
  assert.ok(blockSuggestion, 'podpowiedz warunku dla akapitu "ponizej 6,5 kWp"');

  await api('POST', `${job}/auto-configure/apply`, { applyHighConfidence: true, analysisId: state.autoConfig.analysisId });
  await api('POST', `${job}/auto-configure/analyze`, { sheetName: 'Dane' });
  state = (await api('GET', job)).job;
  const pending = state.autoConfig.candidateSuggestions.filter(s => s.tier !== 'unresolved').map(s => s.candidateId);
  await api('POST', `${job}/auto-configure/apply`, { suggestionIds: pending, analysisId: state.autoConfig.analysisId });
  state = (await api('GET', job)).job;
  for (const c of state.candidates) {
    const d = state.draft.candidates[c.id];
    if (!d || d.status === 'unresolved') await api('POST', `${job}/candidates/${c.id}/manual`, { label: null });
  }
  state = (await api('GET', job)).job;
  const [blockId, block] = Object.entries(state.draft.blocks)[0];
  assert.deepEqual(block.condition, { column: 'Moc kWp', operator: 'lt', value: '6.5' });

  // Podglad warunku na zywo: 2 z 3 wierszy (4,32 i 5,4 < 6,5).
  const cp = await api('POST', `${job}/condition-preview`, { sheetName: 'Dane', condition: block.condition });
  assert.equal(cp.matchedCount, 2);
  assert.equal(cp.total, 3);
  assert.deepEqual(cp.matchedSample.map(m => m.label), ['Kamion 5', 'Wierzchlas 12']);

  // Edycja bloku - ten sam blok, bez duplikatu.
  await api('PUT', `${job}/blocks/${blockId}`, { label: 'PPOŻ', condition: { column: 'Moc kWp', operator: 'lt', value: '5' } });
  state = (await api('GET', job)).job;
  assert.equal(Object.keys(state.draft.blocks).length, 1);
  assert.equal(state.draft.blocks[blockId].condition.value, '5');
  await api('PUT', `${job}/blocks/${blockId}`, { label: 'PPOŻ', condition: { column: 'Moc kWp', operator: 'lt', value: '6.5' } });

  const validation = (await api('POST', `${job}/validate`, { sheetName: 'Dane' })).validation;
  assert.equal(validation.ok, true, JSON.stringify(validation));

  // Podglad dla wiersza 3 (Łążek 7, 7,2 kWp) - dane tego wiersza, blok usuniety, bez bledow.
  const preview = (await api('POST', `${job}/preview`, { sheetName: 'Dane', recordNumber: 3 })).preview;
  assert.deepEqual(preview.errors, [], JSON.stringify(preview));
  assert.equal(preview.hasPdf, true);
  const docxRes = await fetch(`${base}${job}/download/preview/docx`);
  const docxText = new AdmZip(Buffer.from(await docxRes.arrayBuffer())).readAsText('word/document.xml').replace(/<[^>]+>/g, '');
  assert.match(docxText, /Łążek 7/);
  assert.match(docxText, /Zofia Żółkiewska/);
  assert.match(docxText, /Fronius Primo/);
  assert.doesNotMatch(docxText, /Jan Kowalski|Wierzchlas 12/, 'probka nie moze pokazywac danych wiersza wzorcowego');
  assert.doesNotMatch(docxText, /nie wymaga uzgodnienia/, 'blok usuniety dla 7,2 kWp');
  const pdfRes = await fetch(`${base}${job}/download/preview/pdf?inline=1`);
  assert.match(pdfRes.headers.get('content-disposition'), /^inline;/);

  const build = await api('POST', `${job}/build`, { sheetName: 'Dane', templateName: 'Wzór PV' });
  assert.match(build.downloadName, /_seryjny\.docx$/);
});
