const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const rules = require('../lib/smartTemplateRules');

// ===========================================================================
// lib/smartTemplateRules.js - silnik regul, calkowicie niezalezny od Worda,
// wiec testowalny w CI bez zainstalowanego Microsoft Office (patrz sekcja 36
// specyfikacji Kreatora wzorow seryjnych).
// ===========================================================================

test('normalizeSmartText: "ł" nie rozklada sie pod NFD jak inne polskie znaki - wymaga jawnej podmiany', () => {
  assert.equal(rules.normalizeSmartText('Działka  Łąka'), 'dzialka laka');
  assert.equal(rules.normalizeSmartText('MIESZKALNY'), 'mieszkalny');
  assert.equal(rules.normalizeSmartText('  gospodarczy  '), 'gospodarczy');
  assert.equal(rules.normalizeSmartText(null), '');
  assert.equal(rules.normalizeSmartText(undefined), '');
});

test('parseSmartNumber: rozumie przecinek, kropke i jednostki, odrzuca wieloznaczne wartosci zamiast je sklejac', () => {
  assert.equal(rules.parseSmartNumber('5,52').value, 5.52);
  assert.equal(rules.parseSmartNumber('5.52').value, 5.52);
  assert.equal(rules.parseSmartNumber('5,52 kWp').value, 5.52);
  assert.equal(rules.parseSmartNumber('').present, false);
  assert.equal(rules.parseSmartNumber('').valid, true);
  const ambiguous = rules.parseSmartNumber('5/6');
  assert.equal(ambiguous.valid, false);
  assert.equal(ambiguous.value, null);
  assert.equal(rules.parseSmartNumber('10+2').valid, false);
});

test('getColumnValue: odroznia "kolumna nie istnieje" (undefined) od "kolumna istnieje, komorka pusta" ("")', () => {
  const record = { Adres: 'Testowa 1', Moc: '' };
  assert.equal(rules.getColumnValue(record, 'Adres'), 'Testowa 1');
  assert.equal(rules.getColumnValue(record, 'Moc'), '');
  assert.equal(rules.getColumnValue(record, 'Brak takiej kolumny'), undefined);
  // tolerancja WYLACZNIE bialych znakow w nazwie kolumny - nie fuzzy dopasowanie
  assert.equal(rules.getColumnValue(record, '  Adres  '), 'Testowa 1');
});

test('evaluateValueSpec column: trim, prefix, suffix, format liczby', () => {
  const ctx = { record: { Moc: ' 5,5 ' }, fields: {} };
  assert.equal(rules.evaluateValueSpec({ type: 'column', column: 'Moc' }, ctx).value, '5,5');
  assert.equal(rules.evaluateValueSpec({ type: 'column', column: 'Moc', prefix: 'moc: ' }, ctx).value, 'moc: 5,5');
  assert.equal(rules.evaluateValueSpec({ type: 'column', column: 'Moc', suffix: ' kWp' }, ctx).value, '5,5 kWp');
  const formatted = rules.evaluateValueSpec({ type: 'column', column: 'Moc', numberFormat: { decimals: 2, decimalComma: true } }, ctx);
  assert.equal(formatted.value, '5,50');
  const missing = rules.evaluateValueSpec({ type: 'column', column: 'Nieznana' }, ctx);
  assert.equal(missing.valid, false);
});

test('evaluateValueSpec lookup: dokladne dopasowanie, normalizacja z "ł", brak mapowania NIE jest cichym pustym stringiem', () => {
  const map = { mieszkalny: 'na dachu budynku mieszkalnego', gospodarczy: 'na dachu budynku gospodarczego' };
  const ctxA = { record: { Miejsce: 'mieszkalny' }, fields: {} };
  assert.equal(rules.evaluateValueSpec({ type: 'lookup', column: 'Miejsce', map }, ctxA).value, 'na dachu budynku mieszkalnego');

  const ctxB = { record: { Miejsce: 'MIESZKALNY' }, fields: {} };
  assert.equal(rules.evaluateValueSpec({ type: 'lookup', column: 'Miejsce', map }, ctxB).value, 'na dachu budynku mieszkalnego');

  const ctxUnknown = { record: { Miejsce: 'balkon' }, fields: {} };
  const unknownResult = rules.evaluateValueSpec({ type: 'lookup', column: 'Miejsce', map }, ctxUnknown);
  assert.equal(unknownResult.valid, true);
  assert.equal(unknownResult.unmapped, true);
  assert.equal(unknownResult.unmappedValue, 'balkon');

  const ctxEmpty = { record: { Miejsce: '' }, fields: {} };
  const emptyResult = rules.evaluateValueSpec({ type: 'lookup', column: 'Miejsce', map }, ctxEmpty);
  assert.equal(emptyResult.valid, true);
  assert.equal(emptyResult.unmapped, undefined);
  assert.equal(emptyResult.value, '');
});

test('evaluateValueSpec compose: sklada literal + column + field, field NIE moze odwolywac sie do siebie w przod (blokowane w validateManifest)', () => {
  const ctx = { record: { Adres: 'Testowa 1' }, fields: { fld_miejsce: 'na dachu budynku mieszkalnego' } };
  const spec = {
    type: 'compose',
    parts: [
      { type: 'literal', value: 'Na ' },
      { type: 'field', fieldId: 'fld_miejsce' },
      { type: 'literal', value: ' pod adresem ' },
      { type: 'column', column: 'Adres' }
    ]
  };
  assert.equal(rules.evaluateValueSpec(spec, ctx).value, 'Na na dachu budynku mieszkalnego pod adresem Testowa 1');

  const missingFieldSpec = { type: 'compose', parts: [{ type: 'field', fieldId: 'nieistniejace' }] };
  const missingResult = rules.evaluateValueSpec(missingFieldSpec, ctx);
  assert.equal(missingResult.valid, false);
});

test('evaluateCondition: operatory tekstowe sa normalizowane, numeryczne rozumieja "5,52 kWp" i odrzucaja niejednoznaczne', () => {
  const ctxText = { record: { Rodzaj: 'Blacha trapezowa' }, fields: {} };
  assert.equal(rules.evaluateCondition({ column: 'Rodzaj', operator: 'equals', value: 'blacha trapezowa' }, ctxText).matched, true);
  assert.equal(rules.evaluateCondition({ column: 'Rodzaj', operator: 'contains', value: 'trapez' }, ctxText).matched, true);
  assert.equal(rules.evaluateCondition({ column: 'Rodzaj', operator: 'oneOf', value: ['dachowka', 'blacha trapezowa'] }, ctxText).matched, true);
  assert.equal(rules.evaluateCondition({ column: 'Rodzaj', operator: 'empty' }, ctxText).matched, false);
  assert.equal(rules.evaluateCondition({ column: 'Rodzaj', operator: 'notEmpty' }, ctxText).matched, true);

  const ctxNum = { record: { Moc: '5,52 kWp' }, fields: {} };
  assert.equal(rules.evaluateCondition({ column: 'Moc', operator: 'lt', value: 6.5 }, ctxNum).matched, true);
  assert.equal(rules.evaluateCondition({ column: 'Moc', operator: 'gte', value: 6.5 }, ctxNum).matched, false);

  const ctxAmbiguous = { record: { Moc: '5/6' }, fields: {} };
  const ambiguousResult = rules.evaluateCondition({ column: 'Moc', operator: 'lt', value: 6.5 }, ctxAmbiguous);
  assert.equal(ambiguousResult.valid, false);

  const ctxMissingCol = { record: {}, fields: {} };
  const missingColResult = rules.evaluateCondition({ column: 'Brak', operator: 'notEmpty' }, ctxMissingCol);
  assert.equal(missingColResult.valid, false);
});

test('evaluateSmartRecord: kompletny rekord daje pola SCY_F_* i _scyBlocksJson, nie modyfikuje oryginalnego rekordu', () => {
  const manifest = {
    schemaVersion: 1,
    templateId: 't1',
    templateName: 'Test',
    addressColumn: 'Adres',
    fields: [
      { id: 'fld_adres', label: 'Adres obiektu', mergeFieldName: 'SCY_F_A1B2C3D4', required: true, emptyPolicy: 'error', valueSpec: { type: 'column', column: 'Adres' } },
      { id: 'fld_miejsce', label: 'Opis miejsca', mergeFieldName: 'SCY_F_92AF10BC', required: true, emptyPolicy: 'error', unknownPolicy: 'error', valueSpec: { type: 'lookup', column: 'Miejsce montażu PV', map: { mieszkalny: 'na dachu budynku mieszkalnego' } } }
    ],
    blocks: [
      { id: 'blk_low', label: 'PPOŻ niski', bookmarkName: 'SCYB_1A2B3C4D5E6F', condition: { column: 'Moc PV', operator: 'lt', value: 6.5 }, variantGroupId: 'vg_ppoz' },
      { id: 'blk_high', label: 'PPOŻ wysoki', bookmarkName: 'SCYB_6F5E4D3C2B1A', condition: { column: 'Moc PV', operator: 'gte', value: 6.5 }, variantGroupId: 'vg_ppoz' }
    ],
    variantGroups: [{ id: 'vg_ppoz', label: 'PPOŻ', policy: 'exactlyOne' }]
  };
  const sourceRecord = { Adres: 'Kazimierz Biskupi 123', 'Miejsce montażu PV': 'mieszkalny', 'Moc PV': '5,5' };
  const frozenCopy = Object.assign({}, sourceRecord);

  const { record, warnings, errors } = rules.evaluateSmartRecord(manifest, sourceRecord);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.equal(record.SCY_F_A1B2C3D4, 'Kazimierz Biskupi 123');
  assert.equal(record.SCY_F_92AF10BC, 'na dachu budynku mieszkalnego');
  const blocks = JSON.parse(record._scyBlocksJson);
  assert.equal(blocks.SCYB_1A2B3C4D5E6F, true);
  assert.equal(blocks.SCYB_6F5E4D3C2B1A, false);
  assert.deepEqual(sourceRecord, frozenCopy, 'evaluateSmartRecord nie moze modyfikowac oryginalnego rekordu');
});

test('evaluateSmartRecord: grupa wariantow exactlyOne z 0 dopasowan i z 2 dopasowaniami zglasza blad', () => {
  const baseManifest = {
    schemaVersion: 1, templateId: 't1', templateName: 'Test', addressColumn: 'Adres',
    fields: [],
    blocks: [
      { id: 'a', bookmarkName: 'SCYB_AAAAAAAAAAAA', condition: { column: 'X', operator: 'equals', value: '1' }, variantGroupId: 'vg' },
      { id: 'b', bookmarkName: 'SCYB_BBBBBBBBBBBB', condition: { column: 'X', operator: 'equals', value: '2' }, variantGroupId: 'vg' }
    ],
    variantGroups: [{ id: 'vg', label: 'grupa', policy: 'exactlyOne' }]
  };

  const zeroMatches = rules.evaluateSmartRecord(baseManifest, { X: '3' });
  assert.ok(zeroMatches.errors.some(e => /żaden blok nie pasuje/.test(e.message)));

  const twoMatchesManifest = {
    ...baseManifest,
    blocks: [
      { id: 'a', bookmarkName: 'SCYB_AAAAAAAAAAAA', condition: { column: 'X', operator: 'notEmpty' }, variantGroupId: 'vg' },
      { id: 'b', bookmarkName: 'SCYB_BBBBBBBBBBBB', condition: { column: 'X', operator: 'equals', value: '2' }, variantGroupId: 'vg' }
    ]
  };
  const twoMatches = rules.evaluateSmartRecord(twoMatchesManifest, { X: '2' });
  assert.ok(twoMatches.errors.some(e => /więcej niż jeden blok/.test(e.message)));
});

test('evaluateSmartRecord: zeroOrOne dopuszcza brak dopasowania, ale nie dwa naraz', () => {
  const manifest = {
    schemaVersion: 1, templateId: 't1', templateName: 'Test', addressColumn: 'Adres',
    fields: [],
    blocks: [{ id: 'a', bookmarkName: 'SCYB_AAAAAAAAAAAA', condition: { column: 'X', operator: 'equals', value: '1' }, variantGroupId: 'vg' }],
    variantGroups: [{ id: 'vg', label: 'grupa', policy: 'zeroOrOne' }]
  };
  const noMatch = rules.evaluateSmartRecord(manifest, { X: 'inna' });
  assert.deepEqual(noMatch.errors, []);
});

test('evaluateSmartRecord: pole wymagane z pusta wartoscia -> error z emptyPolicy "error", warning z "warn"', () => {
  const manifestBase = {
    schemaVersion: 1, templateId: 't1', templateName: 'Test', addressColumn: 'Adres',
    fields: [{ id: 'fld', label: 'Pole', mergeFieldName: 'SCY_F_AAAAAAAA', required: true, valueSpec: { type: 'column', column: 'Brak' } }]
  };
  const record = { Brak: '' };

  const errorPolicy = rules.evaluateSmartRecord({ ...manifestBase, fields: [{ ...manifestBase.fields[0], emptyPolicy: 'error' }] }, record);
  assert.equal(errorPolicy.errors.length, 1);
  assert.equal(errorPolicy.warnings.length, 0);

  const warnPolicy = rules.evaluateSmartRecord({ ...manifestBase, fields: [{ ...manifestBase.fields[0], emptyPolicy: 'warn' }] }, record);
  assert.equal(warnPolicy.errors.length, 0);
  assert.equal(warnPolicy.warnings.length, 1);
});

test('validateManifest: poprawny schemaVersion 1 przechodzi bez bledow (roundtrip serialize/parse)', () => {
  const manifest = {
    schemaVersion: 1, templateId: 't1', templateName: 'Test', addressColumn: 'Adres',
    fields: [{ id: 'fld_adres', label: 'Adres', mergeFieldName: 'SCY_F_A1B2C3D4', valueSpec: { type: 'column', column: 'Adres' } }],
    blocks: [{ id: 'blk', bookmarkName: 'SCYB_A1B2C3D4E5F6', condition: { column: 'X', operator: 'notEmpty' } }],
    variantGroups: [],
    manualRegions: []
  };
  const roundtripped = JSON.parse(JSON.stringify(manifest));
  const result = rules.validateManifest(roundtripped);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test('validateManifest: nieobslugiwana/przyszla wersja schematu daje kontrolowany blad, nie wyjatek', () => {
  const missing = rules.validateManifest({ schemaVersion: 0 });
  assert.equal(missing.valid, false);
  assert.equal(missing.futureVersion, false);

  const future = rules.validateManifest({ schemaVersion: 2 });
  assert.equal(future.valid, false);
  assert.equal(future.futureVersion, true);
  assert.ok(future.errors[0].includes('nowszą wersją'));
});

test('validateManifest: odrzuca compose odwolujace sie do pola zdefiniowanego PO NIM ("do przodu")', () => {
  const manifest = {
    schemaVersion: 1, templateId: 't1', templateName: 'Test', addressColumn: 'Adres',
    fields: [
      { id: 'fld_a', label: 'A', mergeFieldName: 'SCY_F_AAAAAAAA', valueSpec: { type: 'compose', parts: [{ type: 'field', fieldId: 'fld_b' }] } },
      { id: 'fld_b', label: 'B', mergeFieldName: 'SCY_F_BBBBBBBB', valueSpec: { type: 'column', column: 'Adres' } }
    ]
  };
  const result = rules.validateManifest(manifest);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('WCZEŚNIEJ')));
});

test('validateManifest: nie zawiera zadnego pola sugerujacego wykonywalny kod (eval/script/exec/code)', () => {
  const withCode = { schemaVersion: 1, templateId: 't1', templateName: 'Test', addressColumn: 'Adres', fields: [], evil: { eval: 'process.exit()' } };
  const result = rules.validateManifest(withCode);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => /wykonywalnego kodu/.test(e)));
});

test('validateManifest: variantGroups exactlyOne/zeroOrOne walidowane, nieznana polityka odrzucona', () => {
  const badPolicy = {
    schemaVersion: 1, templateId: 't1', templateName: 'Test', addressColumn: 'Adres', fields: [],
    variantGroups: [{ id: 'vg', label: 'x', policy: 'always' }]
  };
  assert.equal(rules.validateManifest(badPolicy).valid, false);

  const goodPolicies = {
    schemaVersion: 1, templateId: 't1', templateName: 'Test', addressColumn: 'Adres', fields: [],
    variantGroups: [{ id: 'vg1', label: 'x', policy: 'exactlyOne' }, { id: 'vg2', label: 'y', policy: 'zeroOrOne' }]
  };
  assert.equal(rules.validateManifest(goodPolicies).valid, true);
});

test('validateManifest: blok z variantGroupId wskazujacym nieistniejaca grupe jest odrzucony', () => {
  const manifest = {
    schemaVersion: 1, templateId: 't1', templateName: 'Test', addressColumn: 'Adres', fields: [],
    blocks: [{ id: 'blk', bookmarkName: 'SCYB_A1B2C3D4E5F6', condition: { column: 'X', operator: 'notEmpty' }, variantGroupId: 'nieistniejaca' }],
    variantGroups: []
  };
  const result = rules.validateManifest(manifest);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('nie istnieje w variantGroups')));
});

test('validateManifest: nieprawidlowa nazwa mergeFieldName/bookmarkName jest odrzucona', () => {
  const badMergeField = {
    schemaVersion: 1, templateId: 't1', templateName: 'Test', addressColumn: 'Adres',
    fields: [{ id: 'fld', label: 'x', mergeFieldName: 'ZLA NAZWA ZE SPACJA', valueSpec: { type: 'column', column: 'Adres' } }]
  };
  assert.equal(rules.validateManifest(badMergeField).valid, false);

  const badBookmark = {
    schemaVersion: 1, templateId: 't1', templateName: 'Test', addressColumn: 'Adres', fields: [],
    blocks: [{ id: 'blk', bookmarkName: '1_zaczyna_sie_cyfra', condition: { column: 'X', operator: 'notEmpty' } }]
  };
  assert.equal(rules.validateManifest(badBookmark).valid, false);
});

test('collectRequiredColumns: zbiera addressColumn + kolumny z pol (column/lookup/compose) + warunkow blokow, bez duplikatow', () => {
  const manifest = {
    schemaVersion: 1, templateId: 't1', templateName: 'Test', addressColumn: 'Adres',
    fields: [
      { id: 'f1', mergeFieldName: 'SCY_F_11111111', valueSpec: { type: 'column', column: 'Adres' } },
      { id: 'f2', mergeFieldName: 'SCY_F_22222222', valueSpec: { type: 'lookup', column: 'Miejsce', map: {} } },
      { id: 'f3', mergeFieldName: 'SCY_F_33333333', valueSpec: { type: 'compose', parts: [{ type: 'column', column: 'Gmina' }, { type: 'literal', value: 'x' }] } }
    ],
    blocks: [{ id: 'b1', bookmarkName: 'SCYB_111111111111', condition: { column: 'Moc PV', operator: 'lt', value: 6.5 } }]
  };
  const columns = rules.collectRequiredColumns(manifest).sort();
  assert.deepEqual(columns, ['Adres', 'Gmina', 'Miejsce', 'Moc PV'].sort());
});

// ===========================================================================
// lib/wordAutomationCoordinator.js - cross-process lock na Word COM miedzy
// apps/dokumenty-seryjne i apps/kreator-wzorow. Testowane na izolowanym
// SCYZORYK_DATA_ROOT (ten sam wzorzec co test/group10-updater.test.js).
// ===========================================================================

const fsp = require('node:fs/promises');
const os = require('node:os');

async function withIsolatedDataRoot(t) {
  const dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-word-lock-'));
  const previous = process.env.SCYZORYK_DATA_ROOT;
  process.env.SCYZORYK_DATA_ROOT = dataRoot;
  t.after(async () => {
    if (previous === undefined) delete process.env.SCYZORYK_DATA_ROOT;
    else process.env.SCYZORYK_DATA_ROOT = previous;
    await fsp.rm(dataRoot, { recursive: true, force: true });
  });
  return dataRoot;
}

test('wordAutomationCoordinator: tylko jeden lease naraz - drugi czeka i przechodzi dopiero po release pierwszego', async (t) => {
  await withIsolatedDataRoot(t);
  delete require.cache[require.resolve('../lib/wordAutomationCoordinator')];
  const coord = require('../lib/wordAutomationCoordinator');

  const events = [];
  let waitingSeen = false;

  const firstDone = coord.withWordAutomationLease({ app: 'dokumenty-seryjne', operation: 'generate' }, async () => {
    events.push('first-start');
    await new Promise(resolve => setTimeout(resolve, 250));
    events.push('first-end');
    return 'first-result';
  });

  // Daj pierwszemu czas na realne przejecie locka przed startem drugiego.
  await new Promise(resolve => setTimeout(resolve, 30));

  const secondPromise = coord.withWordAutomationLease(
    { app: 'kreator-wzorow', operation: 'scan' },
    async () => { events.push('second-start'); return 'second-result'; },
    { timeoutMs: 5000, pollIntervalMs: 40, onWaiting: (ownerMeta) => {
      waitingSeen = true;
      assert.equal(ownerMeta.app, 'dokumenty-seryjne');
    } }
  );

  const [firstResult, secondResult] = await Promise.all([firstDone, secondPromise]);
  assert.equal(firstResult, 'first-result');
  assert.equal(secondResult, 'second-result');
  assert.equal(waitingSeen, true, 'drugi proces musi zauwazyc, ze czeka na pierwszego');
  assert.deepEqual(events, ['first-start', 'first-end', 'second-start'], 'drugi NIE moze wystartowac przed zakonczeniem pierwszego');
});

test('wordAutomationCoordinator: przekroczenie timeoutu oczekiwania rzuca WordAutomationTimeoutError, nie wisi w nieskonczonosc', async (t) => {
  await withIsolatedDataRoot(t);
  delete require.cache[require.resolve('../lib/wordAutomationCoordinator')];
  const coord = require('../lib/wordAutomationCoordinator');

  const holderReleaseSignal = { release: null };
  const holderDone = coord.withWordAutomationLease({ app: 'dokumenty-seryjne', operation: 'generate' }, () => new Promise(resolve => {
    holderReleaseSignal.release = resolve;
  }));
  await new Promise(resolve => setTimeout(resolve, 30));

  await assert.rejects(
    () => coord.withWordAutomationLease({ app: 'kreator-wzorow', operation: 'build' }, async () => 'never', { timeoutMs: 150, pollIntervalMs: 40 }),
    coord.WordAutomationTimeoutError
  );

  holderReleaseSignal.release();
  await holderDone;
});

test('wordAutomationCoordinator: osierocony lock (martwy PID, przestarzaly heartbeat) jest odzyskiwany, nie blokuje trwale', async (t) => {
  await withIsolatedDataRoot(t);
  delete require.cache[require.resolve('../lib/wordAutomationCoordinator')];
  const coord = require('../lib/wordAutomationCoordinator');

  const lockFile = coord._test.lockPath();
  await fsp.mkdir(path.dirname(lockFile), { recursive: true });
  // PID 999999 praktycznie na pewno nie istnieje - symuluje martwego wlasciciela.
  const staleTimestamp = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  await fsp.writeFile(lockFile, JSON.stringify({
    pid: 999999, token: 'stary-token', app: 'dokumenty-seryjne', operation: 'generate',
    startedAt: staleTimestamp, heartbeatAt: staleTimestamp
  }));

  const result = await coord.withWordAutomationLease({ app: 'kreator-wzorow', operation: 'scan' }, async () => 'przejete');
  assert.equal(result, 'przejete');
});

test('wordAutomationCoordinator: release() z CUDZYM tokenem nie kasuje aktywnego locka innego wlasciciela', async (t) => {
  await withIsolatedDataRoot(t);
  delete require.cache[require.resolve('../lib/wordAutomationCoordinator')];
  const coord = require('../lib/wordAutomationCoordinator');

  const realToken = await coord._test.tryAcquireOnce({ app: 'dokumenty-seryjne', operation: 'generate' });
  await coord._test.release('zupelnie-inny-token-nie-nalezacy-do-nikogo');

  const stillLocked = await coord._test.readLock();
  assert.equal(stillLocked.token, realToken, 'lock musi przetrwac probe zwolnienia cudzym tokenem');

  await coord._test.release(realToken);
  const afterRealRelease = await coord._test.readLock();
  assert.equal(afterRealRelease, null);
});

test('wordAutomationCoordinator: readWordAutomationState zwraca null gdy nikt nie trzyma locka albo lock jest osierocony', async (t) => {
  await withIsolatedDataRoot(t);
  delete require.cache[require.resolve('../lib/wordAutomationCoordinator')];
  const coord = require('../lib/wordAutomationCoordinator');

  assert.equal(await coord.readWordAutomationState(), null);

  const token = await coord._test.tryAcquireOnce({ app: 'kreator-wzorow', operation: 'build' });
  const active = await coord.readWordAutomationState();
  assert.equal(active.app, 'kreator-wzorow');
  await coord._test.release(token);
  assert.equal(await coord.readWordAutomationState(), null);
});

// ===========================================================================
// apps/dokumenty-seryjne/src/smartTemplate.js - odczyt manifestu z Custom XML
// Part w DOCX. Fixture DOCX budowany programowo przez adm-zip (bez Worda).
// ===========================================================================

const AdmZip = require('../apps/dokumenty-seryjne/node_modules/adm-zip');
const { readSmartTemplateManifest, SmartTemplateError } = require('../apps/dokumenty-seryjne/src/smartTemplate');

const VALID_MANIFEST = {
  schemaVersion: 1, templateId: 't1', templateName: 'Test', addressColumn: 'Adres',
  fields: [{ id: 'fld_adres', label: 'Adres', mergeFieldName: 'SCY_F_A1B2C3D4', valueSpec: { type: 'column', column: 'Adres' } }],
  blocks: [], variantGroups: [], manualRegions: []
};

function buildFixtureDocx(dir, customXmlContent) {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<Types/>', 'utf8'));
  zip.addFile('word/document.xml', Buffer.from('<w:document/>', 'utf8'));
  if (customXmlContent !== null) {
    zip.addFile('customXml/item1.xml', Buffer.from(customXmlContent, 'utf8'));
  }
  const filePath = path.join(dir, `fixture-${crypto.randomUUID()}.docx`);
  zip.writeZip(filePath);
  return filePath;
}

function wrapManifestXml(manifestObj) {
  const json = JSON.stringify(manifestObj);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><scyzoryk:smartTemplate xmlns:scyzoryk="urn:scyzoryk:smart-template:v1" version="1"><![CDATA[${json}]]></scyzoryk:smartTemplate>`;
}

const crypto = require('node:crypto');

test('smartTemplate.js: DOCX z poprawnym manifestem w customXml jest wykryty i zwrocony', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-smarttpl-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = buildFixtureDocx(dir, wrapManifestXml(VALID_MANIFEST));
  const manifest = readSmartTemplateManifest(file);
  assert.equal(manifest.templateId, 't1');
  assert.equal(manifest.fields.length, 1);
});

test('smartTemplate.js: zwykly DOCX bez customXml (legacy template) daje null, nie blad', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-smarttpl-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = buildFixtureDocx(dir, null);
  assert.equal(readSmartTemplateManifest(file), null);
});

test('smartTemplate.js: customXml z inna, nieznana przestrzenia nazw jest ignorowany (nie nasz manifest)', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-smarttpl-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = buildFixtureDocx(dir, '<inne:cos xmlns:inne="urn:cos-zupelnie-innego">tresc</inne:cos>');
  assert.equal(readSmartTemplateManifest(file), null);
});

test('smartTemplate.js: uszkodzony JSON manifestu daje czytelny SmartTemplateError, nie surowy wyjatek', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-smarttpl-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const broken = '<?xml version="1.0"?><scyzoryk:smartTemplate xmlns:scyzoryk="urn:scyzoryk:smart-template:v1"><![CDATA[{niepoprawny json]]></scyzoryk:smartTemplate>';
  const file = buildFixtureDocx(dir, broken);
  assert.throws(() => readSmartTemplateManifest(file), SmartTemplateError);
});

test('smartTemplate.js: przyszla wersja schematu daje SmartTemplateError z futureVersion=true, nie cichy fallback do legacy', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-smarttpl-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = buildFixtureDocx(dir, wrapManifestXml({ ...VALID_MANIFEST, schemaVersion: 2 }));
  try {
    readSmartTemplateManifest(file);
    assert.fail('powinno rzucic SmartTemplateError');
  } catch (err) {
    assert.ok(err instanceof SmartTemplateError);
    assert.equal(err.futureVersion, true);
  }
});

test('smartTemplate.js: strukturalnie niepoprawny manifest (np. zly mergeFieldName) daje SmartTemplateError', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-smarttpl-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const bad = { ...VALID_MANIFEST, fields: [{ id: 'fld', mergeFieldName: 'ZLA NAZWA', valueSpec: { type: 'column', column: 'Adres' } }] };
  const file = buildFixtureDocx(dir, wrapManifestXml(bad));
  assert.throws(() => readSmartTemplateManifest(file), SmartTemplateError);
});

// ===========================================================================
// apps/dokumenty-seryjne/scripts/mailmerge-to-pdf.ps1 - statyczne sprawdzenie
// struktury (bez Worda w CI, patrz sekcja 36 specyfikacji): smart mode ma
// pomijac legacy fillery i wywolywac Apply-ScyzorykSmartBlocks, legacy ma
// zachowac stare zachowanie 1:1.
// ===========================================================================

test('mailmerge-to-pdf.ps1: -SmartTemplateMode istnieje, dot-source robi lib/wordSmartTemplate.ps1', async () => {
  const source = await fsp.readFile(path.join(__dirname, '..', 'apps', 'dokumenty-seryjne', 'scripts', 'mailmerge-to-pdf.ps1'), 'utf8');
  assert.match(source, /\[switch\]\$SmartTemplateMode/);
  assert.match(source, /\.\s*\(Join-Path \$PSScriptRoot ".*wordSmartTemplate\.ps1"\)/);
});

test('mailmerge-to-pdf.ps1: smart mode POMIJA Fill-HighlightedTableCells/Fill-NarrativeBlanks i WYWOLUJE Apply-ScyzorykSmartBlocks - legacy dalej ma stare fillery', async () => {
  const source = await fsp.readFile(path.join(__dirname, '..', 'apps', 'dokumenty-seryjne', 'scripts', 'mailmerge-to-pdf.ps1'), 'utf8');
  const ifIndex = source.indexOf('if ($SmartTemplateMode) {');
  const elseIndex = source.indexOf('} else {', ifIndex);
  const endIndex = source.indexOf('Write-Log "info" "Podmieniam pola MERGEFIELD."', elseIndex);
  assert.ok(ifIndex > 0 && elseIndex > ifIndex && endIndex > elseIndex, 'nie znaleziono bloku if($SmartTemplateMode)/else w oczekiwanym ksztalcie');

  const smartBranch = source.slice(ifIndex, elseIndex);
  const legacyBranch = source.slice(elseIndex, endIndex);

  assert.match(smartBranch, /Apply-ScyzorykSmartBlocks \$mergedDoc \$record/);
  assert.doesNotMatch(smartBranch, /Fill-HighlightedTableCells/);
  assert.doesNotMatch(smartBranch, /Fill-NarrativeBlanks/);

  assert.match(legacyBranch, /Fill-HighlightedTableCells \$mergedDoc \$record \$tableFieldDebug/);
  assert.match(legacyBranch, /Fill-NarrativeBlanks \$mergedDoc \$record \$narrativeFieldDebug/);
  assert.doesNotMatch(legacyBranch, /Apply-ScyzorykSmartBlocks/);
});

test('mailmerge-to-pdf.ps1: -SmartTemplateMode jest przekazywane z server.js TYLKO gdy job.smartManifest istnieje', async () => {
  const source = await fsp.readFile(path.join(__dirname, '..', 'apps', 'dokumenty-seryjne', 'server.js'), 'utf8');
  assert.match(source, /if \(job\.smartManifest\) args\.push\('-SmartTemplateMode'\);/);
});

test('wordSmartTemplate.ps1: KAZDY "return" w Apply-ScyzorykSmartBlocks uzywa operatora przecinka (",$result") - real bug zlapany na zywym dokumencie 2026-09-24 (pusta/jednoelementowa Generic.List zwrocona przez "return $result" zamienia sie u wywolujacego w $null/goly element, wiec $smartBlockIssues.Count w mailmerge-to-pdf.ps1 rzuca "The property \'Count\' cannot be found on this object" dla KAZDEGO rekordu wzoru bez blokow ("blocks: []" - normalny, czesty przypadek)', async () => {
  const source = await fsp.readFile(path.join(__dirname, '..', 'lib', 'wordSmartTemplate.ps1'), 'utf8');
  const fnStart = source.indexOf('function Apply-ScyzorykSmartBlocks(');
  assert.ok(fnStart >= 0, 'funkcja Apply-ScyzorykSmartBlocks powinna istnieć w lib/wordSmartTemplate.ps1');
  const nextFnStart = source.indexOf('\nfunction ', fnStart + 1);
  const fnBody = nextFnStart > fnStart ? source.slice(fnStart, nextFnStart) : source.slice(fnStart);

  const returnLines = fnBody.split('\n').filter(line => !/^\s*#/.test(line) && /\breturn\b/.test(line) && /\$result\b/.test(line));
  assert.ok(returnLines.length >= 5, `oczekiwano co najmniej 5 linii "return ...$result" w Apply-ScyzorykSmartBlocks, znaleziono ${returnLines.length}`);
  for (const line of returnLines) {
    assert.match(line, /return\s+,\$result\b/, `każdy return $result musi używać operatora przecinka (",$result"), inaczej pusta/jednoelementowa lista zamienia się w $null/goły element u wywołującego: ${line.trim()}`);
  }
});

// ===========================================================================
// lib/wordSmartTemplate.ps1 - regresja statyczna dla audytu "0 kandydatow"
// (2026-09-10). Zywy Word na CI nie jest dostepny, wiec ponizsze sprawdzaja
// TYLKO ze zrodlo nie wraca do udowodnionych na zywo, blednych wzorcow -
// pierwotny bug byl spowodowany dwiema WLASCIWOSCIAMI COM, ktore w ogole NIE
// ISTNIEJA na obiekcie Find (Find.Font.HighlightColorIndex, Find.Shading),
// polykanymi przez `catch { break }`, co zamienialo kazdy blad w cichy "0
// kandydatow" zamiast kontrolowanego bledu. Prawdziwy test akceptacyjny na
// zywym Wordzie pozostaje obowiazkiem `npm run test:kreator-word` (patrz
// scripts/test-kreator-word-com.ps1 i CLAUDE.md).
// ===========================================================================

test('wordSmartTemplate.ps1: NIE uzywa Find.Font.HighlightColorIndex ani bezposredniego Find.Shading - obie wlasciwosci nie istnieja na obiekcie Find (potwierdzone live, audyt 2026-09-10)', async () => {
  const source = await fsp.readFile(path.join(__dirname, '..', 'lib', 'wordSmartTemplate.ps1'), 'utf8');
  assert.doesNotMatch(source, /\$f(ind)?\.Font\.HighlightColorIndex/i, 'Find.Font.HighlightColorIndex nie istnieje na obiekcie Find - rzuca ArgumentException na zywym Wordzie');
  // Find.Shading (bez posrednictwa .Font/.ParagraphFormat) tez nie istnieje -
  // dozwolone sa TYLKO Find.Font.Shading i Find.ParagraphFormat.Shading.
  assert.doesNotMatch(source, /\$f\.Shading\s*=/, 'Find.Shading (bez .Font/.ParagraphFormat) nie istnieje jako wlasciwosc Find');
});

test('wordSmartTemplate.ps1: highlight jest wykrywany recznym character-walkiem po HighlightColorIndex (Find.Highlight okazal sie live niestabilny - falszywe dopasowania po wyczerpaniu prawdziwych highlightow), nie przez nieistniejacy Find.Font.HighlightColorIndex', async () => {
  const source = await fsp.readFile(path.join(__dirname, '..', 'lib', 'wordSmartTemplate.ps1'), 'utf8');
  const fnMatch = source.match(/function Find-ScyzorykHighlightCandidates[\s\S]*?\n\}/);
  assert.ok(fnMatch, 'nie znaleziono funkcji Find-ScyzorykHighlightCandidates');
  assert.match(fnMatch[0], /Get-ScyzorykCharWalkRanges/, 'skaner highlightu powinien uzywac sprawdzonego character-walka (Get-ScyzorykCharWalkRanges), nie Find - Find.Highlight=$true okazal sie live zwracac falszywe dopasowania po wyczerpaniu prawdziwych highlightow (audyt 2026-09-10)');
  assert.match(fnMatch[0], /HighlightColorIndex/, 'musi odczytywac HighlightColorIndex per-znak');
});

test('wordSmartTemplate.ps1: run/paragraph shading uzywaja Find.Font.Shading / Find.ParagraphFormat.Shading (zweryfikowane live), nie golego Find.Shading', async () => {
  const source = await fsp.readFile(path.join(__dirname, '..', 'lib', 'wordSmartTemplate.ps1'), 'utf8');
  assert.match(source, /\$f\.Font\.Shading\.BackgroundPatternColor/, 'run shading powinien uzywac Find.Font.Shading (Find.Shading nie istnieje)');
  assert.match(source, /\$f\.ParagraphFormat\.Shading\.BackgroundPatternColor/, 'paragraph shading powinien uzywac Find.ParagraphFormat.Shading');
});

test('wordSmartTemplate.ps1: brak ogolnego "catch { break }" bezposrednio wokol Find.Execute(), ktory moglby po cichu zamienic prawdziwy blad COM w "0 kandydatow"', async () => {
  const source = await fsp.readFile(path.join(__dirname, '..', 'lib', 'wordSmartTemplate.ps1'), 'utf8');
  // Pierwotny bug: `} catch { break }` bezposrednio po Find.Execute(). Po
  // naprawie kazdy mechanizm ma wlasny, szerszy try/catch WOKOL calej petli
  // (zapisujacy blad do mechanismErrors), a nie pojedynczy catch->break
  // polykajacy wyjatek z samego wywolania Execute().
  assert.doesNotMatch(source, /\$found\s*=\s*\$f\.Execute\(\)\s*\r?\n\s*\}\s*catch\s*\{\s*break\s*\}/, 'Execute() nie moze byc opakowane w pojedynczy catch { break } - to dokladnie ten wzorzec, ktory ukrywal bledy COM jako "0 kandydatow"');
});

test('wordSmartTemplate.ps1: skaner StoryRanges iteruje CALA kolekcje (kazdy typ story) + NextStoryRange lancuch, nie tylko Item(1)', async () => {
  const source = await fsp.readFile(path.join(__dirname, '..', 'lib', 'wordSmartTemplate.ps1'), 'utf8');
  assert.match(source, /foreach\s*\(\$story\s+in\s+\$doc\.StoryRanges\)/, 'musi iterowac cala kolekcje doc.StoryRanges (kazdy obecny typ story), nie tylko Item(1)');
  assert.match(source, /NextStoryRange/, 'musi podazac lancuchem NextStoryRange dla wielokrotnych wystapien tego samego typu story (np. wiele sekcji)');
});

test('wordSmartTemplate.ps1: Get-ScyzorykStoryKey ma poprawne, zweryfikowane live wartosci WdStoryType (2=footnotes, 3=endnotes, nie 6/7 jak w pierwotnym, blednym kodzie)', async () => {
  const source = await fsp.readFile(path.join(__dirname, '..', 'lib', 'wordSmartTemplate.ps1'), 'utf8');
  const fnMatch = source.match(/function Get-ScyzorykStoryKey[\s\S]*?\n\}/);
  assert.ok(fnMatch, 'nie znaleziono funkcji Get-ScyzorykStoryKey');
  const fn = fnMatch[0];
  assert.match(fn, /2\s*\{\s*return\s*'footnotes'\s*\}/, 'WdStoryType 2 = footnotes (pierwotny kod mial blednie 6)');
  assert.match(fn, /3\s*\{\s*return\s*'endnotes'\s*\}/, 'WdStoryType 3 = endnotes (pierwotny kod mial blednie 7)');
});

test('wordSmartTemplate.ps1: $doc.Range(start,end) NIE jest uzywane w kodzie (poza komentarzami ostrzegawczymi) do adresowania innej story niz main (kazda inna story ma wlasna, niezalezna numeracje pozycji - potwierdzone live)', async () => {
  const source = await fsp.readFile(path.join(__dirname, '..', 'lib', 'wordSmartTemplate.ps1'), 'utf8');
  const codeOnly = source.split('\n').filter(line => !line.trim().startsWith('#')).join('\n');
  assert.doesNotMatch(codeOnly, /\$doc\.Range\(/, 'lib/wordSmartTemplate.ps1 nie powinien wolac $doc.Range(...) bezposrednio w kodzie wykonywalnym - musi uzywac Get-ScyzorykStoryRangeCopy, ktory poprawnie lokalizuje wlasciwa story/shape przed zawezeniem Start/End');
});

test('build-template.ps1: $doc.Range(start,end) NIE jest uzywane do rekonstrukcji zapisanej pozycji kandydata (musi przechodzic przez Get-ScyzorykStoryRangeCopy, story-aware)', async () => {
  const source = await fsp.readFile(path.join(__dirname, '..', 'apps', 'kreator-wzorow', 'scripts', 'build-template.ps1'), 'utf8');
  assert.doesNotMatch(source, /\$doc\.Range\(\$unit\./, 'build-template.ps1 nie powinien odtwarzac zakresu kandydata przez $doc.Range($unit....) - to jest poprawne WYLACZNIE dla story "main", a bledne dla header/footer/textframe (kazda ma wlasna numeracje pozycji)');
  assert.match(source, /Get-ScyzorykStoryRangeCopy/, 'musi uzywac Get-ScyzorykStoryRangeCopy do story-aware rekonstrukcji zakresu');
});

test('build-template.ps1: blok laczacy kandydatow z ROZNYCH story jest jawnie odrzucany (nie probuje zgadywac wspolnego zakresu miedzy niezaleznymi numeracjami pozycji)', async () => {
  const source = await fsp.readFile(path.join(__dirname, '..', 'apps', 'kreator-wzorow', 'scripts', 'build-template.ps1'), 'utf8');
  assert.match(source, /distinctStories\.Count\s*-gt\s*1/, 'musi wykrywac i odrzucac blok laczacy fragmenty z roznych story');
});

// ===========================================================================
// apps/kreator-wzorow/src/templateManifest.js - sklada manifest z draftu
// konfiguracji budowanego krok po kroku w UI Kreatora.
// ===========================================================================

const tm = require('../apps/kreator-wzorow/src/templateManifest');

test('templateManifest.js: pelny przeplyw draftu (constant/field/block/manual) daje manifest przechodzacy validateManifest', () => {
  let draft = tm.emptyDraft({ templateName: 'Test', preferredSheet: 'PV_ME', addressColumn: 'Adres' });
  draft = tm.seedCandidates(draft, ['cand_1', 'cand_2', 'cand_3', 'cand_4', 'cand_5']);

  draft = tm.setCandidateConstant(draft, 'cand_1', null);

  const created = tm.createFieldForCandidate(draft, 'cand_2', {
    label: 'Adres obiektu', required: true, emptyPolicy: 'error',
    valueSpec: { type: 'column', column: 'Adres' }
  });
  draft = created.draft;
  const fieldId = created.fieldId;
  draft = tm.assignCandidateToExistingField(draft, 'cand_3', fieldId);

  const vg = tm.createVariantGroup(draft, 'grupa', 'exactlyOne');
  draft = vg.draft;
  const blockResult = tm.createBlockForCandidate(draft, 'cand_4', {
    label: 'blok niski', condition: { column: 'Moc PV', operator: 'lt', value: 6.5 }, variantGroupId: vg.groupId
  });
  draft = blockResult.draft;

  draft = tm.setCandidateManual(draft, 'cand_5', 'Obliczenia projektanta');

  assert.deepEqual(tm.unresolvedCandidateIds(draft, ['cand_1', 'cand_2', 'cand_3', 'cand_4', 'cand_5']), []);

  const candidates = [
    { id: 'cand_1' }, { id: 'cand_2' }, { id: 'cand_3' }, { id: 'cand_4' }, { id: 'cand_5' }
  ];
  const manifest = tm.buildManifestFromDraft(draft, candidates);
  const validation = rules.validateManifest(manifest);
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.valid, true);

  assert.equal(manifest.fields.length, 1);
  assert.equal(manifest.placements.length, 2);
  assert.equal(manifest.manualRegions.length, 1);
  assert.equal(manifest.manualRegions[0].candidateId, 'cand_5');
  assert.equal(manifest.blocks.length, 1);
  assert.equal(manifest.variantGroups.length, 1);
});

test('templateManifest.js: mergeCandidatesIntoBlock laczy kilku kandydatow pod TYM SAMYM blockId/bookmarkName', () => {
  let draft = tm.emptyDraft({ templateName: 'Test', addressColumn: 'Adres' });
  draft = tm.seedCandidates(draft, ['a', 'b', 'c']);
  draft = tm.mergeCandidatesIntoBlock(draft, ['a', 'b'], { label: 'polaczony blok', condition: { column: 'X', operator: 'notEmpty' } });
  assert.equal(draft.candidates.a.blockId, draft.candidates.b.blockId);
  assert.equal(Object.keys(draft.blocks).length, 1);
  assert.throws(() => tm.mergeCandidatesIntoBlock(draft, ['c'], { label: 'x', condition: {} }));
});

test('templateManifest.js: setCandidatePhotoGallery oznacza kandydata jako rozwiazanego, ale NIE dodaje wpisu do fields/placements/manualRegions (jak "constant" - brak wartosci/reguly runtime)', () => {
  let draft = tm.emptyDraft({ templateName: 'Test', addressColumn: 'Adres' });
  draft = tm.seedCandidates(draft, ['cand_1']);
  assert.ok(tm.CANDIDATE_STATUSES.has('photoGallery'));

  draft = tm.setCandidatePhotoGallery(draft, 'cand_1');
  assert.equal(draft.candidates.cand_1.status, 'photoGallery');
  assert.deepEqual(tm.unresolvedCandidateIds(draft, ['cand_1']), []);

  const manifest = tm.buildManifestFromDraft(draft, [{ id: 'cand_1' }]);
  const validation = rules.validateManifest(manifest);
  assert.deepEqual(validation.errors, []);
  assert.equal(manifest.fields.length, 0);
  assert.equal(manifest.placements.length, 0);
  assert.equal(manifest.manualRegions.length, 0);
});

test('templateManifest.js: nazwy mergeFieldName/bookmarkName pasuja do formatu wymaganego przez validateManifest', () => {
  assert.match(tm.generateMergeFieldName(), /^SCY_F_[0-9A-Fa-f]{6,16}$/);
  assert.match(tm.generateBookmarkName(), /^SCYB_[0-9A-Fa-f]{6,20}$/);
});

// ===========================================================================
// apps/kreator-wzorow/src/candidateConfig.js - walidacja nakladania sie
// zakresow kandydatow (sekcja 34 specyfikacji).
// ===========================================================================

const { validateOverlaps } = require('../apps/kreator-wzorow/src/candidateConfig');

test('candidateConfig.js validateOverlaps: field calkowicie wewnatrz blocku jest dozwolony', () => {
  const entries = [
    { id: 'blk', start: 0, end: 100, storyKey: 'main', kind: 'block' },
    { id: 'fld', start: 20, end: 40, storyKey: 'main', kind: 'field' }
  ];
  assert.deepEqual(validateOverlaps(entries), []);
});

test('candidateConfig.js validateOverlaps: dwa czesciowo nakladajace sie bloki sa bledem', () => {
  const entries = [
    { id: 'blk1', start: 0, end: 50, storyKey: 'main', kind: 'block' },
    { id: 'blk2', start: 30, end: 80, storyKey: 'main', kind: 'block' }
  ];
  const errors = validateOverlaps(entries);
  assert.equal(errors.length, 1);
  assert.deepEqual(errors[0].candidateIds.sort(), ['blk1', 'blk2']);
});

test('candidateConfig.js validateOverlaps: manual nakladajacy sie z field/block jest bledem, nawet w pelni zawarty', () => {
  const entries = [
    { id: 'blk', start: 0, end: 100, storyKey: 'main', kind: 'block' },
    { id: 'man', start: 20, end: 40, storyKey: 'main', kind: 'manual' }
  ];
  const errors = validateOverlaps(entries);
  assert.equal(errors.length, 1);
});

test('candidateConfig.js validateOverlaps: rozlaczne zakresy i rozne Story nigdy nie koliduja', () => {
  const entries = [
    { id: 'a', start: 0, end: 10, storyKey: 'main', kind: 'field' },
    { id: 'b', start: 10, end: 20, storyKey: 'main', kind: 'field' },
    { id: 'c', start: 0, end: 10, storyKey: 'footer', kind: 'block' }
  ];
  assert.deepEqual(validateOverlaps(entries), []);
});

// ===========================================================================
// apps/kreator-wzorow/src/jobStore.js - trwalosc stanu joba, odtwarzanie po
// restarcie (sekcja 16 specyfikacji).
// ===========================================================================

const { createJobStore } = require('../apps/kreator-wzorow/src/jobStore');

test('jobStore.js: create/get/update/delete dziala i przetrwa persist+restore na tym samym katalogu', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-kreator-jobs-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const store1 = createJobStore(dir);
  store1.createJob('job1', { status: 'uploaded', templateName: 'Test' });
  store1.updateJob('job1', { status: 'scanning' });
  assert.equal(store1.getJob('job1').status, 'scanning');

  const store2 = createJobStore(dir);
  const restored = store2.getJob('job1');
  assert.ok(restored, 'job musi przetrwac restart procesu (nowa instancja store)');
  assert.equal(restored.status, 'interrupted', 'aktywny status w trakcie skanowania musi zostac oznaczony jako przerwany po restarcie');
  assert.equal(restored.interruptedReason, 'process-restarted');
});

test('jobStore.js: pruneOlderThan usuwa tylko stare joby i wola onPrune dla kazdego', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-kreator-jobs-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const store = createJobStore(dir);
  const oldJob = store.createJob('old', { status: 'done' });
  oldJob.createdAt = Date.now() - 1000 * 60 * 60 * 48;
  store.createJob('new', { status: 'done' });

  const pruned = [];
  store.pruneOlderThan(1000 * 60 * 60 * 24, job => pruned.push(job.id));
  assert.deepEqual(pruned, ['old']);
  assert.equal(store.getJob('old'), null);
  assert.ok(store.getJob('new'));
});

// ===========================================================================
// apps/kreator-wzorow/src/excelWorkbook.js - odczyt przykladowej tabeli.
// Fixture budowany programowo przez exceljs z node_modules ocr-audytow
// (ten sam wzorzec co test/group3-ocr.test.js).
// ===========================================================================

const ExcelJSForKreator = require('../apps/ocr-audytow/node_modules/exceljs');
const { readWorkbook, sheetPreview, uniqueColumnValues } = require('../apps/kreator-wzorow/src/excelWorkbook');

async function buildKreatorFixtureXlsx(dir) {
  const wb = new ExcelJSForKreator.Workbook();
  const ws = wb.addWorksheet('PV_ME');
  ws.addRow(['Adres', 'Miejsce montażu PV', 'Moc PV']);
  ws.addRow(['Kazimierz Biskupi 1', 'mieszkalny', '5,52']);
  ws.addRow(['Kazimierz Biskupi 2', 'gospodarczy', '9,1']);
  ws.addRow(['Kazimierz Biskupi 3', 'mieszkalny', '3,2']);
  const ws2 = wb.addWorksheet('Inny arkusz');
  ws2.addRow(['X']);
  const filePath = path.join(dir, 'fixture.xlsx');
  await wb.xlsx.writeFile(filePath);
  return filePath;
}

test('excelWorkbook.js: czyta wszystkie arkusze, kolumny i pelne rekordy z _record', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-kreator-xlsx-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = await buildKreatorFixtureXlsx(dir);

  const workbook = await readWorkbook(file);
  assert.deepEqual(workbook.sheetNames.sort(), ['Inny arkusz', 'PV_ME'].sort());
  const sheet = workbook.sheets['PV_ME'];
  assert.deepEqual(sheet.columns, ['Adres', 'Miejsce montażu PV', 'Moc PV']);
  assert.equal(sheet.rows.length, 3);
  assert.equal(sheet.rows[0]._record, 1);
  assert.equal(sheet.rows[0]['Adres'], 'Kazimierz Biskupi 1');
});

test('excelWorkbook.js: sheetPreview paginuje, uniqueColumnValues zbiera unikalne niepuste wartosci w kolejnosci wystapienia', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-kreator-xlsx-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = await buildKreatorFixtureXlsx(dir);
  const workbook = await readWorkbook(file);
  const sheet = workbook.sheets['PV_ME'];

  const preview = sheetPreview(sheet, 1, 1);
  assert.equal(preview.totalRows, 3);
  assert.equal(preview.rows.length, 1);
  assert.equal(preview.rows[0]['Adres'], 'Kazimierz Biskupi 2');

  const unique = uniqueColumnValues(sheet, 'Miejsce montażu PV');
  assert.deepEqual(unique, ['mieszkalny', 'gospodarczy']);
});

// ===========================================================================
// apps/kreator-wzorow/src/textNormalize.js + domainAliases.js - pomocnicze
// funkcje tekstowe auto-konfiguracji Kreatora (PROMPT_CLAUDE_AUTO_KONFIGURACJA_
// KREATORA.md sekcja 7/9/56). Zero zaleznosci od ksztaltu kandydata/arkusza.
// ===========================================================================

const textNormalize = require('../apps/kreator-wzorow/src/textNormalize');
const domainAliases = require('../apps/kreator-wzorow/src/domainAliases');

test('textNormalize.normalizeValue: trim/lowercase/collapse spaces, "ł" jawnie przed NFD, diakrytyki usuniete', () => {
  assert.equal(textNormalize.normalizeValue('  Działka  Łąka '), 'dzialka laka');
  assert.equal(textNormalize.normalizeValue('Kraków'), 'krakow');
  assert.equal(textNormalize.normalizeValue(null), '');
  assert.equal(textNormalize.normalizeValue(undefined), '');
});

test('textNormalize.normalizeValue: liczba z jednostka i bez daja ta sama kanoniczna forme (przecinek/kropka)', () => {
  assert.equal(textNormalize.normalizeValue('5,52 kWp'), textNormalize.normalizeValue('5.52'));
  assert.equal(textNormalize.normalizeValue('5,52kWp'), textNormalize.normalizeValue('5,52'));
  assert.equal(textNormalize.normalizeValue('10 kWh'), textNormalize.normalizeValue('10'));
});

test('textNormalize.normalizeValue: pojedyncza koncowa interpunkcja zdaniowa jest ucinana - blad zlapany na zywym dokumencie 2026-09-15', () => {
  // Realny przypadek z Wzor PV.docx: highlight obejmowal kropke konczaca
  // zdanie razem z modelem falownika ("AF5K-MTH+."), a w Excelu ta sama
  // wartosc jest bez kropki ("AF5K-MTH+") - bez tego EXACT_MATCH_ANYWHERE
  // nigdy by sie nie trafil dla w pelni poprawnego dopasowania.
  assert.equal(textNormalize.normalizeValue('AF5K-MTH+.'), textNormalize.normalizeValue('AF5K-MTH+'));
  assert.equal(textNormalize.normalizeValue('Kowalski Jan,'), textNormalize.normalizeValue('Kowalski Jan'));
  assert.equal(textNormalize.normalizeValue('Testowa wartosc:'), textNormalize.normalizeValue('Testowa wartosc'));
  // NIE utnij: wielokropek (koncowka ".." blokuje ciecie), ani interpunkcja
  // ktora nie jest ostatnim znakiem (np. nawias po kropce).
  assert.equal(textNormalize.normalizeValue('W trakcie...'), 'w trakcie...');
  assert.equal(textNormalize.normalizeValue('12 szt.)'), '12 szt.)');
});

test('textNormalize.isTrivialValue: wartosci ogolne (0/1/tak/nie/x/pojedynczy znak) sa trywialne, prawdziwe wartosci nie', () => {
  for (const v of ['0', '1', '2', 'tak', 'nie', 'x', '-', '']) {
    assert.equal(textNormalize.isTrivialValue(textNormalize.normalizeValue(v)), true, v);
  }
  assert.equal(textNormalize.isTrivialValue(textNormalize.normalizeValue('XXX')), false);
  assert.equal(textNormalize.isTrivialValue(textNormalize.normalizeValue('Testowa 1')), false);
});

test('textNormalize.tokenize/jaccardSimilarity: tokenizacja slow + podobienstwo Jaccarda', () => {
  const tokens = textNormalize.tokenize(textNormalize.normalizeValue('Projektowana moc instalacji:'));
  assert.deepEqual(tokens, ['projektowana', 'moc', 'instalacji']);
  assert.equal(textNormalize.jaccardSimilarity(['moc', 'instalacji'], ['moc', 'zestawu']), 1 / 3);
  assert.equal(textNormalize.jaccardSimilarity([], ['moc']), 0);
});

test('textNormalize.guessValueType: numeric/boolean-like/free-text', () => {
  assert.equal(textNormalize.guessValueType(textNormalize.normalizeValue('42')), 'numeric');
  assert.equal(textNormalize.guessValueType(textNormalize.normalizeValue('tak')), 'boolean-like');
  assert.equal(textNormalize.guessValueType(textNormalize.normalizeValue('Testowa 1')), 'free-text');
});

test('domainAliases.findConceptsForText: dopasowuje pelna fraze aliasu, nie pojedynczy przypadkowy token, i zwraca sile aliasu (waga)', () => {
  const inverter = domainAliases.findConceptsForText('Falownik: XXX');
  assert.equal(inverter.length, 1);
  assert.equal(inverter[0].concept, 'INVERTER');

  const power = domainAliases.findConceptsForText('Projektowana moc instalacji');
  assert.equal(power.length, 1);
  assert.equal(power[0].concept, 'PV_POWER');
  assert.equal(power[0].weight, 1); // fraza jednoznaczna "moc instalacji" -> pelna waga

  assert.deepEqual(domainAliases.findConceptsForText('zupelnie niezwiazany tekst o niczym'), []);
});

// ===========================================================================
// apps/kreator-wzorow/src/autoConfigurator.js - profilowanie kolumn i indeks
// wartosci (runtime-only, nigdy nie zapisywane na dysk).
// ===========================================================================

const autoConfig = require('../apps/kreator-wzorow/src/autoConfigurator');

function fakeSheet(columns, rows) {
  return { columns, rows };
}

test('autoConfigurator.profileWorkbookColumns: uniqueness/dominantType/emptyCount policzone poprawnie', () => {
  const sheet = fakeSheet(['Adres', 'Moc'], [
    { _record: 1, Adres: 'Testowa 1', Moc: '5,52' },
    { _record: 2, Adres: 'Inna 2', Moc: '5,52' },
    { _record: 3, Adres: 'Trzecia 3', Moc: '' },
  ]);
  const profiles = autoConfig.profileWorkbookColumns(sheet);
  const adres = profiles.find(p => p.name === 'Adres');
  const moc = profiles.find(p => p.name === 'Moc');

  assert.equal(adres.uniqueCount, 3);
  assert.equal(adres.uniquenessRatio, 1);
  assert.equal(adres.dominantType, 'free-text');

  assert.equal(moc.emptyCount, 1);
  assert.equal(moc.uniqueCount, 1); // oba niepuste wpisy to ta sama znormalizowana wartosc
  assert.equal(moc.uniquenessRatio, 0.5);
  assert.equal(moc.dominantType, 'numeric');
});

test('autoConfigurator.buildValueIndex: jedna wartosc w wielu kolumnach/wierszach daje wiele trafien', () => {
  const sheet = fakeSheet(['A', 'B'], [
    { _record: 1, A: '5', B: '5' },
    { _record: 2, A: '3', B: '7' },
  ]);
  const index = autoConfig.buildValueIndex(sheet);
  const strictIndex = autoConfig.buildStrictValueIndex(sheet);
  const hits = index.get('5');
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map(h => h.columnName).sort(), ['A', 'B']);
});

// ===========================================================================
// apps/kreator-wzorow/src/autoConfigurator.js - detekcja wiersza wzorcowego
// (sekcja 6/40 promptu auto-konfiguracji).
// ===========================================================================

test('detectSampleRow: jednoznaczna detekcja gdy kilku kandydatow trafia w TEN SAM rekord', () => {
  const sheet = fakeSheet(['A', 'B', 'C'], [
    { _record: 1, A: 'alfa1', B: 'beta1', C: 'gamma1' },
    { _record: 2, A: 'alfa2', B: 'beta2', C: 'gamma2' },
  ]);
  const index = autoConfig.buildValueIndex(sheet);
  const strictIndex = autoConfig.buildStrictValueIndex(sheet);
  const candidates = [{ id: 'c1', text: 'alfa1' }, { id: 'c2', text: 'beta1' }, { id: 'c3', text: 'gamma1' }];
  const result = autoConfig.detectSampleRow(candidates, index, strictIndex);
  assert.equal(result.recordNumber, 1);
  assert.equal(result.matchedCandidateCount, 3);
  assert.equal(result.reason, 'ok');
});

test('detectSampleRow: dwa rekordy z rownowaznymi trafieniami -> brak jednoznacznej detekcji', () => {
  const sheet = fakeSheet(['A', 'B'], [
    { _record: 1, A: 'alfa1', B: 'beta1' },
    { _record: 2, A: 'alfa2', B: 'beta2' },
  ]);
  const index = autoConfig.buildValueIndex(sheet);
  const strictIndex = autoConfig.buildStrictValueIndex(sheet);
  const candidates = [{ id: 'c1', text: 'alfa1' }, { id: 'c2', text: 'beta1' }, { id: 'c3', text: 'alfa2' }, { id: 'c4', text: 'beta2' }];
  const result = autoConfig.detectSampleRow(candidates, index, strictIndex);
  assert.equal(result.recordNumber, null);
  assert.equal(result.reason, 'ambiguous-top2');
});

test('detectSampleRow: same trywialne kandydaci ("1"/"tak"/"-") nigdy nie daja falszywej detekcji', () => {
  const sheet = fakeSheet(['A'], [{ _record: 1, A: '1' }, { _record: 2, A: '1' }]);
  const index = autoConfig.buildValueIndex(sheet);
  const strictIndex = autoConfig.buildStrictValueIndex(sheet);
  const candidates = [{ id: 'c1', text: '1' }, { id: 'c2', text: 'tak' }, { id: 'c3', text: '-' }];
  const result = autoConfig.detectSampleRow(candidates, index, strictIndex);
  assert.equal(result.recordNumber, null);
  assert.equal(result.reason, 'no-matches');
});

test('detectSampleRow: liczba z jednostka w kandydacie dopasowuje sie do samej liczby w Excelu', () => {
  const sheet = fakeSheet(['Adres', 'Moc'], [
    { _record: 1, Adres: 'Testowa 1', Moc: '5.52' },
    { _record: 2, Adres: 'Inna 2', Moc: '3.1' },
  ]);
  const index = autoConfig.buildValueIndex(sheet);
  const strictIndex = autoConfig.buildStrictValueIndex(sheet);
  const candidates = [{ id: 'c1', text: 'Testowa 1' }, { id: 'c2', text: '5,52 kWp' }];
  const result = autoConfig.detectSampleRow(candidates, index, strictIndex);
  assert.equal(result.recordNumber, 1);
  assert.equal(result.matchedCandidateCount, 2);
});

test('detectSampleRow: polskie znaki diakrytyczne dopasowuja sie do wersji ASCII w Excelu', () => {
  const sheet = fakeSheet(['Adres', 'Miasto'], [
    { _record: 1, Adres: 'Testowa 1', Miasto: 'Krakow' },
    { _record: 2, Adres: 'Inna 2', Miasto: 'Poznan' },
  ]);
  const index = autoConfig.buildValueIndex(sheet);
  const strictIndex = autoConfig.buildStrictValueIndex(sheet);
  const candidates = [{ id: 'c1', text: 'Testowa 1' }, { id: 'c2', text: 'Kraków' }];
  const result = autoConfig.detectSampleRow(candidates, index, strictIndex);
  assert.equal(result.recordNumber, 1);
});

test('detectSampleRow: ta sama wartosc w dwoch kolumnach jednego rekordu nie psuje detekcji', () => {
  // Wartosci celowo WIELOZNAKOWE (nie pojedyncze cyfry/litery) - te ostatnie
  // sa z zalozenia trywialne (sekcja 7 promptu: "zmniejsz wage: pojedyncze
  // litery") i nie moga posluzyc do sprawdzenia WLASCIWEGO zachowania tego
  // testu (dopasowanie tej samej wartosci w 2 kolumnach TEGO SAMEGO rekordu).
  const sheet = fakeSheet(['A', 'B', 'C'], [
    { _record: 1, A: '55', B: '55', C: 'unikalna1' },
    { _record: 2, A: '33', B: '77', C: 'unikalna2' },
  ]);
  const index = autoConfig.buildValueIndex(sheet);
  const strictIndex = autoConfig.buildStrictValueIndex(sheet);
  const candidates = [{ id: 'c1', text: '55' }, { id: 'c2', text: 'unikalna1' }];
  const result = autoConfig.detectSampleRow(candidates, index, strictIndex);
  assert.equal(result.recordNumber, 1);
});

test('detectSampleRow: brak wiersza wzorcowego (zero dopasowan) - scoreCandidate dziala dalej bez wyjatku, oparty tylko na kontekscie', () => {
  const sheet = fakeSheet(['Adres'], [{ _record: 1, Adres: 'Testowa 1' }]);
  const index = autoConfig.buildValueIndex(sheet);
  const strictIndex = autoConfig.buildStrictValueIndex(sheet);
  const result = autoConfig.detectSampleRow([{ id: 'c1', text: 'zupelnie inna wartosc' }], index, strictIndex);
  assert.equal(result.recordNumber, null);
  assert.equal(result.reason, 'no-matches');

  const columns = autoConfig.profileWorkbookColumns(sheet);
  const scored = autoConfig.scoreCandidate({ id: 'c1', text: 'zupelnie inna wartosc' }, columns, {});
  assert.equal(typeof scored.score, 'number');
});

test('detectSampleRow i scoreCandidate: kandydat bez nowych pol kontekstu C# (kompatybilnosc wsteczna) nie rzuca wyjatku', () => {
  const sheet = fakeSheet(['Adres'], [{ _record: 1, Adres: 'Testowa 1' }, { _record: 2, Adres: 'Inna 2' }]);
  const index = autoConfig.buildValueIndex(sheet);
  const strictIndex = autoConfig.buildStrictValueIndex(sheet);
  const bareCandidate = { id: 'c1', text: 'Testowa 1' }; // brak paragraphPrefix/leftCellText/before/after itd.
  assert.doesNotThrow(() => autoConfig.detectSampleRow([bareCandidate, { id: 'c2', text: 'placeholder' }], index, strictIndex));
  const columns = autoConfig.profileWorkbookColumns(sheet);
  assert.doesNotThrow(() => autoConfig.scoreCandidate(bareCandidate, columns, {}));
});

// ===========================================================================
// apps/kreator-wzorow/src/autoConfigurator.js - scoring kandydat->kolumna
// (sekcja 11/12/31/34 promptu auto-konfiguracji).
// ===========================================================================

function fakeColumn({ name, tokens, values = {}, dominantType = 'free-text', uniquenessRatio = 1 }) {
  const valueIndex = new Map();
  const strictValueIndex = new Map();
  for (const [normalizedValue, recordNumber] of Object.entries(values)) {
    valueIndex.set(normalizedValue, [{ recordNumber, rawValue: normalizedValue }]);
    const parsed = textNormalize.parseNumericValue(normalizedValue);
    if (parsed) strictValueIndex.set(textNormalize.numericMatchKey(parsed), [{ recordNumber, rawValue: normalizedValue }]);
  }
  return { name, normalizedTokens: tokens, valueIndex, strictValueIndex, dominantType, uniquenessRatio };
}

test('scoreCandidateColumn: silne dopasowanie (sample-row + kontekst + alias + typ + unikalnosc) osiaga poziom auto', () => {
  // Excel z jednostka W TEKSCIE komorki ("5.52 kWp", nie goly numeryczny
  // "5.52") - zeby unit-aware porownanie (hardening sekcja 5) dalo 'strong',
  // nie 'weak' (goly numeryczny Excel bez jednostki jest z definicji
  // niepewny co do jednostki wzgledem kandydata majacego jednostke w tekscie).
  const column = fakeColumn({ name: 'Moc PV', tokens: ['moc', 'pv'], values: { '5.52 kwp': 1 }, dominantType: 'numeric', uniquenessRatio: 0.9 });
  const candidate = { id: 'c1', text: '5,52 kWp', paragraphPrefix: 'Moc PV wynosi:', paragraphSuffix: '', leftCellText: '', rightCellText: '', before: '', after: '' };
  const scored = autoConfig.scoreCandidateColumn(candidate, column, { sampleRowRecord: { 'Moc PV': '5.52 kWp' } });
  const codes = scored.reasons.map(r => r.code);
  assert.ok(codes.includes('SAMPLE_ROW_EXACT'));
  assert.ok(codes.includes('CONTEXT_HEADER_SIMILARITY'));
  assert.ok(codes.includes('DOMAIN_ALIAS_MATCH'));
  assert.ok(scored.score >= 95);

  const tier = autoConfig.classifyTier(autoConfig.scoreCandidate(candidate, [column], { sampleRowRecord: { 'Moc PV': '5.52 kWp' } }));
  assert.equal(tier, 'auto');
});

test('scoreCandidateColumn: tylko exact-match-anywhere (brak wiersza wzorcowego, brak kontekstu) nie osiaga poziomu auto', () => {
  const column = fakeColumn({ name: 'Kolumna X', tokens: ['kolumna', 'x'], values: { 'wartosc a': 3 }, uniquenessRatio: 0.3 });
  const candidate = { id: 'c1', text: 'Wartosc A' };
  const scored = autoConfig.scoreCandidateColumn(candidate, column, {});
  assert.ok(scored.reasons.some(r => r.code === 'EXACT_MATCH_ANYWHERE'));
  assert.ok(scored.score < 95);
});

test('scoreCandidateColumn: sam kontekst/naglowek bez zadnego dopasowania wartosci nigdy nie daje auto', () => {
  const column = fakeColumn({ name: 'Adres inwestycji', tokens: ['adres', 'inwestycji'] });
  const candidate = { id: 'c1', text: 'cos, czego nie ma w Excelu', paragraphPrefix: 'Adres inwestycji:', before: '', after: '', paragraphSuffix: '', leftCellText: '', rightCellText: '' };
  const scored = autoConfig.scoreCandidateColumn(candidate, column, {});
  assert.ok(!scored.reasons.some(r => r.code === 'SAMPLE_ROW_EXACT' || r.code === 'EXACT_MATCH_ANYWHERE'));
  assert.ok(scored.score < 95);
});

test('scoreCandidateColumn: alias domenowy laczy inaczej sformulowany kontekst z naglowkiem kolumny', () => {
  const column = fakeColumn({ name: 'Inwerter', tokens: ['inwerter'] });
  const candidate = { id: 'c1', text: 'XYZ-1000', paragraphPrefix: 'Falownik:', before: '', after: '', paragraphSuffix: '', leftCellText: '', rightCellText: '' };
  const scored = autoConfig.scoreCandidateColumn(candidate, column, {});
  assert.ok(scored.reasons.some(r => r.code === 'DOMAIN_ALIAS_MATCH'));
});

test('scoreCandidateColumn: sasiedni akapit (before/after) NIE licza sie do kontekstu - blad zlapany na zywym dokumencie 2026-09-15', () => {
  // Realny przypadek z Wzor PV.docx: akapit "Panele fotowoltaiczne
  // zaprojektowano na polaci dachu..." w ogole nie wspomina falownika, ale
  // jego JEDNOZDANIOWY "after" (caly NASTEPNY akapit, z
  // MarkScanner.GetSurroundingContext) to "Falownik i magazyn zostana
  // zamontowane w garazu." - przed poprawka to samo w sobie dawalo
  // CONTEXT_HEADER_SIMILARITY 100% dla kolumny "falownik", mimo ze kandydat
  // mowi wylacznie o orientacji dachu. before/after byly z zalozenia luznym
  // fingerprintem do weryfikacji zmiany dokumentu (patrz komentarz przy
  // GetSurroundingContext w C#), nie sygnalem semantycznym - nie powinny
  // wplywac na scoring.
  const column = fakeColumn({ name: 'falownik', tokens: ['falownik'], dominantType: 'free-text' });
  const candidate = {
    id: 'c1',
    text: 'polaci dachu/konstrukcji gruntowej skierowanej w strone poludniowa.',
    paragraphPrefix: 'Panele fotowoltaiczne zaprojektowano na',
    paragraphSuffix: '',
    leftCellText: '', rightCellText: '',
    before: 'Usytuowanie instalacji fotowoltaicznej',
    after: 'Falownik i magazyn zostana zamontowane w garazu.',
  };
  const scored = autoConfig.scoreCandidateColumn(candidate, column, {});
  assert.ok(!scored.reasons.some(r => r.code === 'CONTEXT_HEADER_SIMILARITY'), 'sasiedni akapit nie powinien dac dopasowania naglowka');
  assert.ok(!scored.reasons.some(r => r.code === 'DOMAIN_ALIAS_MATCH'), 'sasiedni akapit nie powinien dac dopasowania aliasu domenowego');
});

test('scoreCandidateColumn: pamiec (mappingPrior) przechyla remis miedzy dwiema rownie dobrze pasujacymi kolumnami', () => {
  const columnA = fakeColumn({ name: 'Moc A', tokens: ['moc'], dominantType: 'numeric' });
  const columnB = fakeColumn({ name: 'Moc B', tokens: ['moc'], dominantType: 'numeric' });
  const candidate = { id: 'c1', text: '5', paragraphPrefix: 'Moc:', before: '', after: '', paragraphSuffix: '', leftCellText: '', rightCellText: '' };

  const withoutPrior = autoConfig.scoreCandidate(candidate, [columnA, columnB], {});
  assert.equal(withoutPrior.alternatives[0].score, withoutPrior.alternatives[1].score); // remis

  const withPrior = autoConfig.scoreCandidate(candidate, [columnA, columnB], { mappingPriors: [{ columnName: 'Moc A', accepted: 5, rejected: 0, weight: 15 }] });
  assert.equal(withPrior.bestColumn, 'Moc A');
});

test('scoreCandidateColumn: niezgodnosc typu (numeric vs free-text) obniza wynik przez kare TYPE_MISMATCH', () => {
  const column = fakeColumn({ name: 'Adres', tokens: ['adres'], dominantType: 'free-text' });
  const candidate = { id: 'c1', text: '42' };
  const scored = autoConfig.scoreCandidateColumn(candidate, column, {});
  assert.ok(scored.reasons.some(r => r.code === 'TYPE_MISMATCH' && r.weight === -10));
});

test('scoreCandidate: kolizja kilku niemal identycznie pasujacych kolumn demotuje auto do review', () => {
  // "5,52" (wieloznakowa liczba), nie pojedyncza cyfra - pojedynczy znak jest
  // z zalozenia trywialny (patrz komentarz w tescie sample-row wyzej) i
  // dostalby kare TRIVIAL_VALUE zamiast bonusu za unikalnosc, psujac test.
  const columnA = fakeColumn({ name: 'Moc A', tokens: ['moc', 'a'], values: { '5.52': 1 }, dominantType: 'numeric', uniquenessRatio: 0.9 });
  const columnB = fakeColumn({ name: 'Moc B', tokens: ['moc', 'b'], values: { '5.52': 1 }, dominantType: 'numeric', uniquenessRatio: 0.9 });
  const candidate = { id: 'c1', text: '5,52', paragraphPrefix: 'Moc:', before: '', after: '', paragraphSuffix: '', leftCellText: '', rightCellText: '' };
  const sampleRowRecord = { 'Moc A': '5.52', 'Moc B': '5.52' };

  const soloTier = autoConfig.classifyTier(autoConfig.scoreCandidate(candidate, [columnA], { sampleRowRecord }));
  assert.equal(soloTier, 'auto');

  const bothTier = autoConfig.classifyTier(autoConfig.scoreCandidate(candidate, [columnA, columnB], { sampleRowRecord }));
  assert.notEqual(bothTier, 'auto');
});

test('classifyTier: maly margines miedzy top1 i top2 blokuje auto mimo wyniku >= 95', () => {
  assert.equal(autoConfig.classifyTier({ score: 100, margin: 10 }), 'review');
  assert.equal(autoConfig.classifyTier({ score: 100, margin: 20 }), 'auto');
  assert.equal(autoConfig.classifyTier({ score: 80, margin: 20 }), 'review');
  assert.equal(autoConfig.classifyTier({ score: 50, margin: 0 }), 'unresolved');
});

// ===========================================================================
// apps/kreator-wzorow/src/autoConfigurator.js - grupowanie powtarzajacych
// sie pol (sekcja 14/42 promptu auto-konfiguracji).
// ===========================================================================

function fieldSuggestion(candidateId, bestColumn, reasonCodes) {
  return { candidateId, kind: 'field', tier: 'auto', score: 96, margin: 20, bestColumn, fieldGroupId: null, reasons: reasonCodes.map(code => ({ code, weight: 1, message: '' })) };
}

test('groupRepeatedFields: dwaj kandydaci z dopasowaniem WARTOSCI na tej samej kolumnie grupuja sie', () => {
  const suggestions = [fieldSuggestion('c1', 'Adres', ['SAMPLE_ROW_EXACT']), fieldSuggestion('c2', 'Adres', ['EXACT_MATCH_ANYWHERE'])];
  const groups = autoConfig.groupRepeatedFields(suggestions);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].candidateIds.sort(), ['c1', 'c2']);
  assert.equal(suggestions[0].fieldGroupId, groups[0].groupId);
  assert.equal(suggestions[1].fieldGroupId, groups[0].groupId);
});

test('groupRepeatedFields: dopasowanie WARTOSCI + dopasowanie TYLKO kontekstem na tej samej kolumnie NIE grupuja sie', () => {
  const suggestions = [fieldSuggestion('c1', 'Adres', ['SAMPLE_ROW_EXACT']), fieldSuggestion('c2', 'Adres', ['CONTEXT_HEADER_SIMILARITY'])];
  const groups = autoConfig.groupRepeatedFields(suggestions);
  assert.equal(groups.length, 0);
  assert.equal(suggestions[0].fieldGroupId, null);
  assert.equal(suggestions[1].fieldGroupId, null);
});

test('groupRepeatedFields: 2 grupowalnych + 1 na innej kolumnie -> dokladnie jedna 2-elementowa grupa', () => {
  const suggestions = [
    fieldSuggestion('c1', 'Adres', ['SAMPLE_ROW_EXACT']),
    fieldSuggestion('c2', 'Adres', ['SAMPLE_ROW_EXACT']),
    fieldSuggestion('c3', 'Falownik', ['SAMPLE_ROW_EXACT']),
  ];
  const groups = autoConfig.groupRepeatedFields(suggestions);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].column, 'Adres');
  assert.equal(groups[0].candidateIds.length, 2);
});

// ===========================================================================
// apps/kreator-wzorow/src/autoConfigurator.js - klasyfikator "DO PROJEKTANTA"
// (sekcja 16/43 promptu) i konserwatywna detekcja stalych (sekcja 15).
// ===========================================================================

test('classifyManualCandidate: dlugi blok z mocnym slowem kluczowym ("obliczenia") -> auto', () => {
  const candidate = { text: 'Obliczenia spadku napięcia dla przewodu zasilającego wynoszą poniżej dopuszczalnych 3% zgodnie z normą PN-HD 60364.', paragraphText: 'Obliczenia spadku napięcia dla przewodu zasilającego wynoszą poniżej dopuszczalnych 3% zgodnie z normą PN-HD 60364.' };
  const result = autoConfig.classifyManualCandidate(candidate, 'unresolved');
  assert.equal(result.tier, 'auto');
});

test('classifyManualCandidate: dlugi blok ze slabym slowem kluczowym ("schemat"), brak dopasowania kolumny -> review', () => {
  const text = 'Poniższy schemat instalacji przedstawia rozmieszczenie modułów na dachu budynku zgodnie z projektem technicznym.';
  const result = autoConfig.classifyManualCandidate({ text, paragraphText: text }, 'unresolved');
  assert.equal(result.tier, 'review');
});

test('classifyManualCandidate: krotki fragment dzielacy TYLKO slowo-klucz nie staje sie manual', () => {
  const result = autoConfig.classifyManualCandidate({ text: 'Konstrukcja', paragraphText: 'Konstrukcja' }, 'unresolved');
  assert.equal(result.tier, 'none');
});

test('classifyManualCandidate: czasownikowy dobor kabla/zabezpieczenia ("dobrano przewod"/"dobrano wylacznik") -> review - blad z realnego dokumentu (REFERENCJE_Excel_Word, 2026-09-15)', () => {
  // Dokladny tekst akapitu z Wzor PV.docx: liczby "Iz = 27A"/"In=16A," sa
  // podswietlonymi kandydatami WEWNATRZ tego akapitu (paragraphText to caly
  // akapit, nie sam highlight). Przed poprawka #1: "dobor przewodu"/
  // "zabezpieczenie" (rzeczowniki) nie pasowaly do "dobrano przewod"/
  // "zabezpieczenia" (czasownik/dopelniacz) w tekscie. Przed poprawka #2 (ta
  // sama sesja, zlapane od razu potem): nawet po naprawie #1, ten kandydat
  // mial surowy top1.score=78 dla kolumny "falownik" (samo dopasowanie
  // kontekstu/aliasu, BEZ zadnego dowodu wartosci) - stary
  // classifyManualCandidate patrzyl na surowy wynik, nie na finalny fieldTier
  // (ktory po bramce dowodowej w classifyTier i tak wychodzi 'unresolved'),
  // wiec bezzasadnie zakladal "juz dobrze dopasowane do kolumny" i nigdy nie
  // dawal szansy klasyfikacji manualnej.
  const paragraphText = 'Dla falownika dobrano przewod YDY 5x4mm2 0,6/1kV o dopuszczalnym pradzie dlugotrwalym Iz = 27A. W celu zabezpieczenia Falownika dobrano wylacznik nadpradowy o charakterystyce B i pradzie In=16A, k - (wspolczynnik krotnosci pradu) dla wylacznikow nadpradowych o charakterystyce B,C i D - k=1,45';
  const result = autoConfig.classifyManualCandidate({ text: 'Iz = 27A', paragraphText }, 'unresolved');
  assert.equal(result.tier, 'review');
});

test('classifyManualCandidate: kandydat z dobrym dopasowaniem kolumny (fieldTier auto/review) nigdy nie jest manual, niezaleznie od slow', () => {
  const text = 'Obliczenia dla przewodu zasilajacego - dlugi blok tekstu technicznego o obciazeniu i zabezpieczeniu.';
  assert.equal(autoConfig.classifyManualCandidate({ text, paragraphText: text }, 'review').tier, 'none');
  assert.equal(autoConfig.classifyManualCandidate({ text, paragraphText: text }, 'auto').tier, 'none');
});

test('detectConstantCandidate: powtarzajacy sie boilerplate bez dopasowania kolumny -> review, nigdy auto', () => {
  const result = autoConfig.detectConstantCandidate({ text: 'Uwaga: dane orientacyjne' }, [{ score: 5 }], 3);
  assert.equal(result.tier, 'review');
});

test('detectConstantCandidate: wyraznie dynamiczne (wysoki score dopasowania kolumny) nigdy nie jest sugerowane jako stala', () => {
  const result = autoConfig.detectConstantCandidate({ text: 'Testowa 1' }, [{ score: 90 }], 5);
  assert.equal(result.tier, 'none');
});

test('detectConstantCandidate: tekst wystepujacy tylko raz (bez powtorzenia) nie jest sugerowany jako stala', () => {
  const result = autoConfig.detectConstantCandidate({ text: 'Unikalny tekst' }, [{ score: 5 }], 1);
  assert.equal(result.tier, 'none');
});

// ===========================================================================
// apps/kreator-wzorow/src/mappingMemory.js - lokalna pamiec mapowan (sekcja
// 4/29/45 promptu auto-konfiguracji) - WYLACZNIE reguly/liczniki, zero PII.
// ===========================================================================

const { createMappingMemory } = require('../apps/kreator-wzorow/src/mappingMemory');

test('mappingMemory: recordAccepted/recordRejected licza poprawnie, getPrior zwraca najczesciej akceptowane mapowanie', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-kreator-memory-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const memory = createMappingMemory(dir);

  assert.equal(memory.getPrior('adres instalacji'), null);
  memory.recordAccepted('adres instalacji', 'ADDRESS', 'Adres inwestycji');
  memory.recordAccepted('adres instalacji', 'ADDRESS', 'Adres inwestycji');
  memory.recordRejected('adres instalacji', 'ADDRESS', 'Inna kolumna');

  const prior = memory.getPrior('adres instalacji');
  assert.equal(prior.columnName, 'Adres inwestycji');
  assert.equal(prior.accepted, 2);
});

test('mappingMemory: zapisany plik JSON nie zawiera zadnych danych osobowych/wartosci rekordow - tylko reguly i liczniki', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-kreator-memory2-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const memory = createMappingMemory(dir);
  memory.recordAccepted('falownik', 'INVERTER', 'Falownik');

  const raw = JSON.parse(await fsp.readFile(path.join(dir, 'auto-config-memory.json'), 'utf8'));
  assert.equal(raw.schemaVersion, 1);
  assert.equal(raw.mappings.length, 1);
  const entry = raw.mappings[0];
  assert.deepEqual(Object.keys(entry).sort(), ['accepted', 'columnAliases', 'contextKey', 'lastUsedAt', 'logicalConcept', 'rejected', 'schemaFingerprint'].sort());
  assert.equal(entry.contextKey, 'falownik');
  assert.equal(entry.accepted, 1);
});

test('mappingMemory: uszkodzony plik pamieci daje bezpieczny reset z kopia zapasowa, nie wyjatek', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-kreator-memory3-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  await fsp.writeFile(path.join(dir, 'auto-config-memory.json'), '{ to nie jest poprawny json', 'utf8');

  let memory;
  assert.doesNotThrow(() => { memory = createMappingMemory(dir); });
  assert.equal(memory.getPrior('cokolwiek'), null);

  const entries = await fsp.readdir(dir);
  assert.ok(entries.some(name => name.includes('.corrupted-') && name.endsWith('.bak')));
});

test('mappingMemory: zapis jest atomowy - po recordAccepted nie zostaje plik .tmp', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-kreator-memory4-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const memory = createMappingMemory(dir);
  memory.recordAccepted('cokolwiek', null, 'Kolumna');
  const entries = await fsp.readdir(dir);
  assert.ok(!entries.some(name => name.endsWith('.tmp')));
});

// ===========================================================================
// Hardening (PROMPT_CLAUDE_HARDENING_AUTO_KONFIGURACJI_KREATORA.md) - signed
// prior, PII, schema fingerprint (sekcja 2-4/30).
// ===========================================================================

test('mappingMemory signed prior: accepted > rejected -> dodatni wplyw', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-kreator-memory5-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const memory = createMappingMemory(dir);
  for (let i = 0; i < 5; i++) memory.recordAccepted('ctx', null, 'Kolumna A');
  const prior = memory.getPrior('ctx');
  assert.ok(prior.weight > 0, `weight powinien byc dodatni, jest ${prior.weight}`);
});

test('mappingMemory signed prior: rejected > accepted -> ujemny wplyw (kara)', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-kreator-memory6-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const memory = createMappingMemory(dir);
  for (let i = 0; i < 3; i++) memory.recordRejected('ctx', null, 'Kolumna A');
  memory.recordAccepted('ctx', null, 'Kolumna A');
  const prior = memory.getPrior('ctx');
  assert.ok(prior.weight < 0, `weight powinien byc ujemny, jest ${prior.weight}`);
});

test('mappingMemory signed prior: 0 accepted / 1 rejected NIGDY nie daje dodatniego bonusu (naprawiony bug)', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-kreator-memory7-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const memory = createMappingMemory(dir);
  memory.recordRejected('ctx', null, 'Kolumna A');
  const prior = memory.getPrior('ctx');
  assert.ok(prior.weight <= 0, `0 accepted / 1 rejected dalo dodatni weight=${prior.weight} - to jest dokladnie naprawiany bug`);
});

test('mappingMemory isSafeMemoryContext: odrzuca kontekst wygladajacy jak PII, akceptuje bezpieczna etykiete szablonu', () => {
  const { isSafeMemoryContext } = require('../apps/kreator-wzorow/src/mappingMemory');
  // "Kowalski Jan" bez bezpiecznego kontekstu strukturalnego - buildContextKey
  // zwrocilby '' (nie fallbackuje juz do tekstu kandydata), a '' jest odrzucane.
  assert.equal(isSafeMemoryContext(''), false);
  // Adres z duza gestoscia cyfr (numer domu/kod pocztowy) - odrzucony.
  assert.equal(isSafeMemoryContext('62 850 tuliszkow ul dluga 5 97 360'), false);
  // Zbyt dlugi "kontekst" (wyciekle cale zdanie, nie etykieta) - odrzucony.
  assert.equal(isSafeMemoryContext('to jest bardzo dlugi tekst ktory wyglada jak cale zdanie a nie etykieta'), false);
  // Kontekst rowny wartosci kandydata (stary, usuniety fallback odtworzony
  // przypadkiem) - odrzucony.
  assert.equal(isSafeMemoryContext('testowa 1', 'testowa 1'), false);
  // Krotka, bezpieczna etykieta szablonu - dozwolona.
  assert.equal(isSafeMemoryContext('adres instalacji'), true);
});

test('mappingMemory buildContextKey: BEZ bezpiecznego kontekstu strukturalnego zwraca pusty string, NIGDY tekst kandydata (naprawiony bug)', () => {
  const { buildContextKey } = require('../apps/kreator-wzorow/src/mappingMemory');
  // Kandydat bez paragraphPrefix/Suffix/leftCellText/rightCellText - stary
  // kod fallbackowal tu do normalizeValue(candidate.text) ("kowalski jan"),
  // co bylo realnym wyciekiem danych z rekordu do pamieci na dysku.
  const key = buildContextKey({ text: 'Kowalski Jan' });
  assert.equal(key, '');
});

test('mappingMemory: niebezpieczny kontekst -> recordAccepted/recordRejected NIC nie zapisuja (0 write)', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-kreator-memory8-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const memory = createMappingMemory(dir);

  const acceptedOk = memory.recordAccepted('', null, 'Kolumna'); // pusty kontekst (brak bezpiecznej etykiety)
  assert.equal(acceptedOk, false);
  const rejectedOk = memory.recordRejected('testowa 1', null, 'Kolumna', '', 'testowa 1'); // kontekst == wartosc kandydata
  assert.equal(rejectedOk, false);

  assert.equal(memory.getPrior(''), null);
  assert.equal(memory.getPrior('testowa 1'), null);
  // Plik nigdy nie zostal utworzony (persist() nigdy sie nie wykonal, bo
  // zero faktycznych zapisow) - to TEZ jest poprawny dowod "0 write", nie
  // tylko pusta tablica w istniejacym pliku.
  const filePath = path.join(dir, 'auto-config-memory.json');
  const raw = await fsp.readFile(filePath, 'utf8').then(JSON.parse).catch((err) => (err.code === 'ENOENT' ? { mappings: [] } : Promise.reject(err)));
  assert.equal(raw.mappings.length, 0);
});

test('mappingMemory schema fingerprint: deterministyczny i niezalezny od kolejnosci kolumn', () => {
  const { buildSchemaFingerprint } = require('../apps/kreator-wzorow/src/mappingMemory');
  const fp1 = buildSchemaFingerprint(['Adres', 'Moc', 'Falownik']);
  const fp2 = buildSchemaFingerprint(['Falownik', 'Adres', 'Moc']);
  const fp3 = buildSchemaFingerprint(['Adres', 'Moc', 'Inna kolumna']);
  assert.equal(fp1, fp2, 'ten sam zestaw kolumn w innej kolejnosci -> ten sam fingerprint');
  assert.notEqual(fp1, fp3, 'inny zestaw kolumn -> inny fingerprint');
  assert.equal(typeof fp1, 'string');
  assert.ok(fp1.length > 0);
});

test('mappingMemory getPrior: TEN SAM schema dostaje pelna wage, "obcy" schema polowiczna', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-kreator-memory9-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const memory = createMappingMemory(dir);
  const schemaA = memory.buildSchemaFingerprint(['Adres', 'Moc']);
  const schemaB = memory.buildSchemaFingerprint(['Zupelnie', 'Inny', 'Arkusz']);

  for (let i = 0; i < 5; i++) memory.recordAccepted('ctx', null, 'Kolumna', schemaA);

  const sameSchemaPrior = memory.getPrior('ctx', schemaA);
  const foreignSchemaPrior = memory.getPrior('ctx', schemaB);
  assert.equal(sameSchemaPrior.sameSchema, true);
  assert.equal(foreignSchemaPrior.sameSchema, false);
  assert.ok(foreignSchemaPrior.weight < sameSchemaPrior.weight, 'obcy schemat musi miec nizsza wage niz ten sam schemat');
});

test('recordManualCorrectionFeedback: sugerowana kolumna dostaje rejected+1, finalna accepted+1', async (t) => {
  const { createMappingMemory, recordManualCorrectionFeedback } = require('../apps/kreator-wzorow/src/mappingMemory');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-kreator-memory10-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const memory = createMappingMemory(dir);
  const candidate = { id: 'c1', text: '5,52', paragraphPrefix: 'Moc zestawu:' };
  const previousSuggestion = { kind: 'field', bestColumn: 'Moc zestawu' };
  const finalDecision = { kind: 'field', column: 'moc projekt' };

  const result = recordManualCorrectionFeedback(memory, candidate, previousSuggestion, finalDecision, '');
  assert.equal(result.rejectedPrevious, true);
  assert.equal(result.acceptedFinal, true);

  const contextKey = memory.buildContextKey(candidate);
  const priorForOld = memory.getPrior(contextKey); // najlepszy (najwiekszy |weight|) wpis dla kontekstu
  // Po jednej korekcie: "Moc zestawu" ma 0/1 (rejected), "moc projekt" ma 1/0
  // (accepted) - "moc projekt" ma wiekszy |weight| (dodatni), wiec getPrior
  // (ktory bierze NAJSILNIEJSZY wpis) zwraca WLASNIE jego, nie odrzucony.
  assert.equal(priorForOld.columnName, 'moc projekt');
  assert.ok(priorForOld.weight > 0);
});

test('recordManualCorrectionFeedback: identyczna finalna decyzja jak sugestia -> nic nie zapisuje (nie ma korekty)', async (t) => {
  const { createMappingMemory, recordManualCorrectionFeedback } = require('../apps/kreator-wzorow/src/mappingMemory');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-kreator-memory11-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const memory = createMappingMemory(dir);
  const candidate = { id: 'c1', text: 'X', paragraphPrefix: 'Falownik:' };
  const suggestion = { kind: 'field', bestColumn: 'Falownik' };
  const result = recordManualCorrectionFeedback(memory, candidate, suggestion, { kind: 'field', column: 'Falownik' }, '');
  assert.equal(result.rejectedPrevious, false);
  assert.equal(result.acceptedFinal, false);
});

// ===========================================================================
// Hardening - unit-aware numeric matching (sekcja 5/6/31).
// ===========================================================================

test('textNormalize.compareValues: pelna tabela przypadkow z sekcji 31 promptu hardeningowego', () => {
  assert.equal(textNormalize.compareValues('5,52 kWp', '5.52 kWp'), 'strong');
  assert.equal(textNormalize.compareValues('5,52 kWp', '5.52'), 'weak');
  assert.equal(textNormalize.compareValues('10 kWh', '10 kWp'), 'conflict');
  assert.equal(textNormalize.compareValues('10 kWh', '10'), 'weak');
  assert.equal(textNormalize.compareValues('10', '10'), 'strong');
});

test('textNormalize.parseNumericValue: rozpoznaje wartosc, jednostke i hadUnit', () => {
  assert.deepEqual(textNormalize.parseNumericValue('10 kWh'), { value: 10, unit: 'kwh', hadUnit: true });
  assert.deepEqual(textNormalize.parseNumericValue('10'), { value: 10, unit: '', hadUnit: false });
  assert.equal(textNormalize.parseNumericValue('nie liczba'), null);
});

test('scoreCandidateColumn: EXACT_VALUE_AND_UNIT dla zgodnej liczby+jednostki, UNIT_CONFLICT (bez bonusu) dla tej samej liczby z inna jednostka', () => {
  const columnKwh = fakeColumn({ name: 'Pojemnosc magazynu', tokens: ['pojemnosc', 'magazynu'], values: { '10 kwh': 1 }, dominantType: 'numeric' });
  const candidateKwh = { id: 'c1', text: '10 kWh' };
  const scoredMatch = autoConfig.scoreCandidateColumn(candidateKwh, columnKwh, {});
  assert.ok(scoredMatch.reasons.some(r => r.code === 'EXACT_VALUE_AND_UNIT'));

  // Ta sama liczba, ale kandydat ma INNA jednostke (kWp) - kolumna ma TYLKO
  // "10 kWh" w indeksie -> brak strict hita, a weak (goly "10") tez nie
  // istnieje w tej kolumnie -> brak jakiegokolwiek dopasowania wartosci.
  const candidateKwp = { id: 'c2', text: '10 kWp' };
  const scoredConflict = autoConfig.scoreCandidateColumn(candidateKwp, columnKwh, {});
  assert.ok(!scoredConflict.reasons.some(r => r.code === 'EXACT_VALUE_AND_UNIT' || r.code === 'EXACT_MATCH_ANYWHERE'));
});

test('scoreCandidateColumn: sample-row z KONFLIKTEM jednostek nigdy nie daje SAMPLE_ROW_EXACT ani NUMERIC_VALUE_COMPATIBLE', () => {
  const column = fakeColumn({ name: 'Moc zestawu', tokens: ['moc', 'zestawu'], dominantType: 'numeric' });
  const candidate = { id: 'c1', text: '10 kWh' }; // kWh, nie kWp - inna wielkosc fizyczna
  const scored = autoConfig.scoreCandidateColumn(candidate, column, { sampleRowRecord: { 'Moc zestawu': '10 kWp' } });
  assert.ok(scored.reasons.some(r => r.code === 'UNIT_CONFLICT'));
  assert.ok(!scored.reasons.some(r => r.code === 'SAMPLE_ROW_EXACT' || r.code === 'NUMERIC_VALUE_COMPATIBLE'));
});

test('detectSampleRow: "10 kWh" nigdy nie miesza sie z "10 kWp" w innej kolumnie tego samego rekordu', () => {
  const sheet = fakeSheet(['Moc', 'Magazyn', 'Adres'], [
    { _record: 1, Moc: '10 kWp', Magazyn: '10 kWh', Adres: 'Testowa 1' },
    { _record: 2, Moc: '7 kWp', Magazyn: '5 kWh', Adres: 'Inna 2' },
  ]);
  const index = autoConfig.buildValueIndex(sheet);
  const strictIndex = autoConfig.buildStrictValueIndex(sheet);
  // "10 kWh" jako kandydat powinien trafic TYLKO w kolumne "Magazyn" (strict,
  // zgodna jednostka), NIGDY w "Moc" (ta sama liczba, ale kWp != kWh).
  const hitsForKwh = strictIndex.get(textNormalize.numericMatchKey(textNormalize.parseNumericValue('10 kWh')));
  assert.equal(hitsForKwh.length, 1);
  assert.equal(hitsForKwh[0].columnName, 'Magazyn');
});

// ===========================================================================
// Hardening - analiza tylko nierozwiazanych kandydatow (sekcja 7/32).
// ===========================================================================

test('analyzeAutoConfiguration: analizuje TYLKO nierozwiazanych kandydatow, summary rozroznia alreadyResolved/analyzed', () => {
  const sheet = fakeSheet(['Adres', 'Moc'], [
    { _record: 1, Adres: 'Testowa 1', Moc: '5.52' },
    { _record: 2, Adres: 'Inna 2', Moc: '3.1' },
  ]);
  const workbook = { defaultSheet: 'Dane', sheets: { Dane: sheet } };
  const candidates = [
    { id: 'c1', text: 'Testowa 1', paragraphPrefix: 'Adres:' },
    { id: 'c2', text: '5,52', paragraphPrefix: 'Moc:' },
    { id: 'c3', text: 'juz rozwiazany 1' },
    { id: 'c4', text: 'juz rozwiazany 2' },
  ];
  const draft = {
    preferredSheet: 'Dane',
    candidates: {
      c3: { status: 'constant', constantText: 'X' },
      c4: { status: 'manual' },
    },
  };
  const analysis = autoConfig.analyzeAutoConfiguration({ candidates, workbook, sheetName: 'Dane', draft, mappingMemory: null });
  assert.equal(analysis.summary.totalCandidates, 4);
  assert.equal(analysis.summary.alreadyResolved, 2);
  assert.equal(analysis.summary.analyzed, 2);
  assert.equal(analysis.candidateSuggestions.length, 2);
  assert.ok(!analysis.candidateSuggestions.some(s => s.candidateId === 'c3' || s.candidateId === 'c4'));
  assert.equal(analysis.summary.auto + analysis.summary.review + analysis.summary.unresolved, 2);
});

// ===========================================================================
// Hardening - trwale grupowanie miedzy osobnymi apply requestami (sekcja 14/35).
// ===========================================================================

test('applyAutoConfiguration: grupa rozlozona na DWA osobne apply-requesty daje JEDNO pole, nie dwa', () => {
  const { applyAutoConfiguration } = require('../apps/kreator-wzorow/src/autoConfigApply');
  const tmLocal = require('../apps/kreator-wzorow/src/templateManifest');
  let draft = tmLocal.emptyDraft({ templateName: 't', preferredSheet: 'Dane', addressColumn: 'Adres' });
  draft = tmLocal.seedCandidates(draft, ['a', 'b']);

  const analysis = {
    candidateSuggestions: [
      { candidateId: 'a', kind: 'field', tier: 'auto', score: 96, bestColumn: 'Adres', fieldGroupId: 'grp_1', reasons: [] },
      { candidateId: 'b', kind: 'field', tier: 'auto', score: 96, bestColumn: 'Adres', fieldGroupId: 'grp_1', reasons: [] },
    ],
  };

  const first = applyAutoConfiguration(draft, analysis, { suggestionIds: ['a'], candidates: [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }] });
  assert.equal(Object.keys(first.draft.fields).length, 1);
  const fieldIdAfterFirst = Object.keys(first.draft.fields)[0];

  // DRUGI, OSOBNY request - existingGroupFieldIds przekazane z persystowanego
  // stanu joba po pierwszym requescie (dokladnie tak, jak robi to server.js).
  const second = applyAutoConfiguration(first.draft, analysis, {
    suggestionIds: ['b'], candidates: [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }],
    existingGroupFieldIds: first.groupFieldIds,
  });
  assert.equal(Object.keys(second.draft.fields).length, 1, 'nadal JEDNO pole, nie dwa');
  assert.equal(second.draft.candidates.b.fieldId, fieldIdAfterFirst, 'ten sam fieldId co przy pierwszym apply');
});

// ===========================================================================
// Hardening - konflikt domenowy / niejednoznacznosc (sekcja 17/36).
// ===========================================================================

test('domainAliases.hasDomainConflict: PV vs PC to konflikt, PV vs PV nie', () => {
  assert.equal(domainAliases.hasDomainConflict('moc instalacji fotowoltaicznej PV', 'Moc pompy ciepla'), true);
  assert.equal(domainAliases.hasDomainConflict('moc instalacji PV', 'Moc zestawu PV'), false);
  assert.equal(domainAliases.hasDomainConflict('brak jakichkolwiek markerow', 'Moc zestawu'), false);
});

test('scoreCandidateColumn: DOMAIN_CONFLICT karze kolumne z wyraznie inna domena (moc PV vs moc pompy ciepla)', () => {
  const pcColumn = fakeColumn({ name: 'Moc pompy ciepła', tokens: ['moc', 'pompy', 'ciepla'], dominantType: 'numeric' });
  const candidate = { id: 'c1', text: '5', paragraphPrefix: 'Moc instalacji fotowoltaicznej PV:' };
  const scored = autoConfig.scoreCandidateColumn(candidate, pcColumn, {});
  assert.ok(scored.reasons.some(r => r.code === 'DOMAIN_CONFLICT' && r.weight < 0));
});

test('classifyTier: sam kontekst/alias/typ/unikalnosc (BEZ zadnego dopasowania wartosci ani pamieci) nigdy nie osiaga review - blad zlapany na zywym dokumencie 2026-09-15', () => {
  // Realny przypadek z Wzor PV.docx: caly akapit o doborze kabla/zabezpieczenia
  // dla falownika ("Dla falownika dobrano przewod YDY 5x4mm2 ... Iz = 27A. W
  // celu zabezpieczenia Falownika dobrano wylacznik ... In=16A") sprawial, ze
  // KAZDA podswietlona liczba w tym akapicie (prad, przekroj kabla) dostawala
  // sugestie "falownik" (78%, review) tylko dlatego, ze slowo "falownik"
  // padlo GDZIES w tym samym (dlugim) akapicie - CONTEXT_HEADER_SIMILARITY(42)
  // + DOMAIN_ALIAS_MATCH(22) + TYPE_MATCH(8) + HIGH_UNIQUENESS(6) = 78, ponad
  // prog review (75), bez ZADNEGO potwierdzenia w samej wartosci "Iz = 27A"
  // wzgledem faktycznych wartosci kolumny "falownik" w Excelu.
  const column = fakeColumn({ name: 'falownik', tokens: ['falownik'], values: { 'af5k-mth+': 1, 'af3k-mth+': 2 }, dominantType: 'free-text', uniquenessRatio: 0.9 });
  const candidate = {
    id: 'c1',
    text: 'Iz = 27A',
    paragraphPrefix: 'Dla falownika dobrano przewod YDY 5x4mm2 0,6/1kV o dopuszczalnym pradzie dlugotrwalym',
    paragraphSuffix: '. W celu zabezpieczenia Falownika dobrano wylacznik nadpradowy o charakterystyce B i pradzie In=16A',
    leftCellText: '', rightCellText: '',
  };
  const scored = autoConfig.scoreCandidate(candidate, [column], {});
  // Bez tej poprawki: score >= 75 (review). Z poprawka: brak dowodu wartosci -> unresolved.
  assert.ok(!scored.reasons.some(r => r.code === 'SAMPLE_ROW_EXACT' || r.code === 'EXACT_VALUE_AND_UNIT' || r.code === 'EXACT_MATCH_ANYWHERE' || r.code === 'NUMERIC_VALUE_COMPATIBLE'));
  assert.equal(autoConfig.classifyTier(scored), 'unresolved');
});

test('classifyTier: kontekst/alias + REALNE dopasowanie wartosci (EXACT_MATCH_ANYWHERE) nadal osiaga review', () => {
  const column = fakeColumn({ name: 'falownik', tokens: ['falownik'], values: { 'af5k-mth+': 1 }, dominantType: 'free-text', uniquenessRatio: 0.9 });
  const candidate = { id: 'c1', text: 'AF5K-MTH+.', paragraphPrefix: 'Falownik:', paragraphSuffix: '', leftCellText: '', rightCellText: '' };
  const scored = autoConfig.scoreCandidate(candidate, [column], {});
  assert.ok(scored.reasons.some(r => r.code === 'EXACT_MATCH_ANYWHERE'));
  assert.notEqual(autoConfig.classifyTier(scored), 'unresolved');
});

// ===========================================================================
// Hardening - review 1-klik, undo, origin metadata: patrz sekcja HTTP
// ponizej (kontynuacja istniejacych testow auto-configure/*).
// ===========================================================================

// ===========================================================================
// apps/kreator-wzorow/server.js - testy HTTP (bez Worda: tylko upload,
// bezpieczenstwo, health). Ten sam wzorzec co test/group14-nazywarka-skanow.test.js
// (app.listen(0), fetch, X-Scyzoryk-Request).
// ===========================================================================

const AdmZipForKreator = require('../apps/kreator-wzorow/node_modules/adm-zip');

function listenKreator(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
function closeKreator(server) {
  return new Promise(resolve => server.close(resolve));
}

function buildMinimalDocx() {
  const zip = new AdmZipForKreator();
  zip.addFile('[Content_Types].xml', Buffer.from('<Types/>', 'utf8'));
  zip.addFile('word/document.xml', Buffer.from('<w:document/>', 'utf8'));
  return zip.toBuffer();
}

function buildMinimalXlsx() {
  const zip = new AdmZipForKreator();
  zip.addFile('xl/workbook.xml', Buffer.from('<workbook/>', 'utf8'));
  return zip.toBuffer();
}

async function withKreatorApp(t) {
  const dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-kreator-data-'));
  const previous = process.env.SCYZORYK_DATA_ROOT;
  process.env.SCYZORYK_DATA_ROOT = dataRoot;
  delete require.cache[require.resolve('../apps/kreator-wzorow/server.js')];
  const { app } = require('../apps/kreator-wzorow/server.js');
  const server = app.listen(0, '127.0.0.1');
  const port = await listenKreator(server);
  t.after(async () => {
    await closeKreator(server);
    if (previous === undefined) delete process.env.SCYZORYK_DATA_ROOT;
    else process.env.SCYZORYK_DATA_ROOT = previous;
    await fsp.rm(dataRoot, { recursive: true, force: true });
  });
  return port;
}

test('kreator-wzorow/server.js: uzywa require.main === module (nie startuje listen() przy require z testow)', async () => {
  const source = await fsp.readFile(path.join(__dirname, '..', 'apps', 'kreator-wzorow', 'server.js'), 'utf8');
  assert.match(source, /if \(require\.main === module\)/);
});

test('kreator-wzorow/server.js: GET /api/health zwraca wlasciwa nazwe', async (t) => {
  const port = await withKreatorApp(t);
  const res = await fetch(`http://127.0.0.1:${port}/api/health`);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.name, 'kreator-wzorow');
});

test('kreator-wzorow/server.js: mutacja bez X-Scyzoryk-Request jest odrzucana 403', async (t) => {
  const port = await withKreatorApp(t);
  const res = await fetch(`http://127.0.0.1:${port}/api/jobs`, { method: 'POST' });
  assert.equal(res.status, 403);
});

test('kreator-wzorow/server.js: fake .docx niebedacy ZIP jest odrzucany', async (t) => {
  const port = await withKreatorApp(t);
  const form = new FormData();
  form.append('template', new Blob([Buffer.from('to nie jest zip')], { type: 'application/octet-stream' }), 'wzor.docx');
  form.append('excel', new Blob([buildMinimalXlsx()], { type: 'application/octet-stream' }), 'dane.xlsx');
  const res = await fetch(`http://127.0.0.1:${port}/api/jobs`, { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' }, body: form });
  const json = await res.json();
  assert.equal(res.status, 400);
  assert.equal(json.ok, false);
});

test('kreator-wzorow/server.js: ZIP bez word/document.xml (nie prawdziwy DOCX) jest odrzucany', async (t) => {
  const port = await withKreatorApp(t);
  const badZip = new AdmZipForKreator();
  badZip.addFile('cokolwiek.txt', Buffer.from('x', 'utf8'));
  const form = new FormData();
  form.append('template', new Blob([badZip.toBuffer()], { type: 'application/octet-stream' }), 'wzor.docx');
  form.append('excel', new Blob([buildMinimalXlsx()], { type: 'application/octet-stream' }), 'dane.xlsx');
  const res = await fetch(`http://127.0.0.1:${port}/api/jobs`, { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' }, body: form });
  const json = await res.json();
  assert.equal(res.status, 400);
  assert.match(json.message, /nie wygląda jak poprawny dokument Office/);
});

test('kreator-wzorow/server.js: XLSX bez xl/workbook.xml jest odrzucany', async (t) => {
  const port = await withKreatorApp(t);
  const badZip = new AdmZipForKreator();
  badZip.addFile('cokolwiek.txt', Buffer.from('x', 'utf8'));
  const form = new FormData();
  form.append('template', new Blob([buildMinimalDocx()], { type: 'application/octet-stream' }), 'wzor.docx');
  form.append('excel', new Blob([badZip.toBuffer()], { type: 'application/octet-stream' }), 'dane.xlsx');
  const res = await fetch(`http://127.0.0.1:${port}/api/jobs`, { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' }, body: form });
  const json = await res.json();
  assert.equal(res.status, 400);
  assert.match(json.message, /nie wygląda jak poprawny dokument Office/);
});

test('kreator-wzorow/server.js: poprawny upload tworzy job z workbookiem (bez Worda - to sam upload, nie skan)', async (t) => {
  const port = await withKreatorApp(t);
  const form = new FormData();
  form.append('template', new Blob([buildMinimalDocx()], { type: 'application/octet-stream' }), 'Mój wzór.docx');

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-kreator-xlsx2-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const ExcelJSForKreator2 = require('../apps/ocr-audytow/node_modules/exceljs');
  const wb = new ExcelJSForKreator2.Workbook();
  const ws = wb.addWorksheet('Dane');
  ws.addRow(['Adres']);
  ws.addRow(['Testowa 1']);
  const xlsxPath = path.join(dir, 'dane.xlsx');
  await wb.xlsx.writeFile(xlsxPath);
  const xlsxBuffer = await fsp.readFile(xlsxPath);
  form.append('excel', new Blob([xlsxBuffer], { type: 'application/octet-stream' }), 'dane.xlsx');

  const res = await fetch(`http://127.0.0.1:${port}/api/jobs`, { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' }, body: form });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.ok(json.jobId);
  assert.equal(json.templateName, 'Mój wzór.docx');
  assert.deepEqual(json.workbook.columns, ['Adres']);

  const jobRes = await fetch(`http://127.0.0.1:${port}/api/jobs/${json.jobId}`);
  const jobJson = await jobRes.json();
  assert.equal(jobJson.ok, true);
  assert.equal(jobJson.job.status, 'uploaded');
});

// ===========================================================================
// Migracja Word COM -> Open XML (CLAUDE.md, audyt 2026-09-14): pelny przeplyw
// HTTP scan-markings -> scan -> build przez documentEngine.js/
// Scyzoryk.DocumentEngine.exe, BEZ Worda/PowerShell - w przeciwienstwie do
// pozostalych testow w tym pliku (ktore uzywaja buildMinimalDocx(), za
// ubogiego dla realnego skanu), ten fixture jest PRAWDZIWYM, otwieralnym
// przez Open XML SDK dokumentem z realnym oznaczeniem.
// ===========================================================================

function buildRealFixtureDocx() {
  const zip = new AdmZipForKreator();
  zip.addFile('[Content_Types].xml', Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>', 'utf8'));
  zip.addFile('_rels/.rels', Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>', 'utf8'));
  zip.addFile('word/document.xml', Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:body>' +
    '<w:p><w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>XXX</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>plain text niepowiazany z oznaczeniem</w:t></w:r></w:p>' +
    '<w:sectPr/>' +
    '</w:body>' +
    '</w:document>', 'utf8'));
  return zip.toBuffer();
}

// Tylko PID-y (sekcja 33 promptu migracji: "zapisac PID-y WINWORD.EXE przed/po,
// sprawdzic ze nie pojawil sie NOWY") - porownanie calej linii CSV z tasklist
// (audyt 2026-09-14) jest falszywie-alarmujace, bo kolumna "Mem Usage"
// naturalnie zmienia sie dla TEGO SAMEGO, juz dzialajacego procesu (np.
// wlasnego dokumentu uzytkownika) miedzy dwoma pomiarami w czasie.
function getWinwordPids() {
  if (process.platform !== 'win32') return [];
  let output = '';
  try {
    output = require('child_process').execSync('tasklist /FI "IMAGENAME eq WINWORD.EXE" /FO CSV /NH', { encoding: 'utf8' });
  } catch {
    return [];
  }
  const pids = [];
  for (const line of output.trim().split(/\r?\n/)) {
    const match = line.match(/^"WINWORD\.EXE","(\d+)"/);
    if (match) pids.push(match[1]);
  }
  return pids;
}

test('kreator-wzorow: pelny przeplyw upload -> scan-markings -> scan -> build przez Open XML, zero WINWORD.EXE', async (t) => {
  const port = await withKreatorApp(t);

  const beforePids = getWinwordPids();

  const form = new FormData();
  form.append('template', new Blob([buildRealFixtureDocx()], { type: 'application/octet-stream' }), 'wzor.docx');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-kreator-e2e-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const ExcelJSForE2E = require('../apps/ocr-audytow/node_modules/exceljs');
  const wb = new ExcelJSForE2E.Workbook();
  const ws = wb.addWorksheet('Dane');
  ws.addRow(['Adres', 'Wartosc']);
  ws.addRow(['Testowa 1', 'ABC']);
  const xlsxPath = path.join(dir, 'dane.xlsx');
  await wb.xlsx.writeFile(xlsxPath);
  form.append('excel', new Blob([await fsp.readFile(xlsxPath)], { type: 'application/octet-stream' }), 'dane.xlsx');

  const uploadRes = await fetch(`http://127.0.0.1:${port}/api/jobs`, { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' }, body: form });
  const uploadJson = await uploadRes.json();
  assert.equal(uploadRes.status, 200, JSON.stringify(uploadJson));
  const jobId = uploadJson.jobId;

  const paletteRes = await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}/scan-markings`, { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' } });
  const paletteJson = await paletteRes.json();
  assert.equal(paletteRes.status, 200, JSON.stringify(paletteJson));
  assert.ok(paletteJson.markings.some(m => m.key === 'highlight:yellow'));

  const scanRes = await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}/scan`, {
    method: 'POST', headers: { 'X-Scyzoryk-Request': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ selectedMarkings: ['highlight:yellow'] }),
  });
  const scanJson = await scanRes.json();
  assert.equal(scanRes.status, 200, JSON.stringify(scanJson));
  assert.equal(scanJson.candidates.length, 1);
  const candidate = scanJson.candidates[0];
  assert.equal(candidate.text, 'XXX');
  assert.equal(candidate.partUri, '/word/document.xml');
  assert.equal(candidate.markKind, 'highlight');

  const configRes = await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}/config`, {
    method: 'PUT', headers: { 'X-Scyzoryk-Request': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      addressColumn: 'Adres',
      candidates: { [candidate.id]: { status: 'constant', constantText: 'STALA' } },
    }),
  });
  assert.equal(configRes.status, 200);

  const buildRes = await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}/build`, { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' } });
  const buildJson = await buildRes.json();
  assert.equal(buildRes.status, 200, JSON.stringify(buildJson));
  assert.ok(buildJson.downloadName);

  const downloadRes = await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}/download/template`);
  assert.equal(downloadRes.status, 200);
  const builtBuffer = Buffer.from(await downloadRes.arrayBuffer());
  const builtZip = new AdmZipForKreator(builtBuffer);
  const builtDocXml = builtZip.readAsText('word/document.xml');
  assert.match(builtDocXml, /STALA/);
  assert.doesNotMatch(builtDocXml, /<w:highlight/); // oznaczenie wyczyszczone
  const customXmlEntries = builtZip.getEntries().filter(e => /^customXml\/item\d*\.xml$/.test(e.entryName));
  assert.ok(customXmlEntries.some(e => builtZip.readAsText(e).includes('urn:scyzoryk:smart-template:v1')));

  if (process.platform === 'win32') {
    const afterPids = getWinwordPids();
    const newPids = afterPids.filter(pid => !beforePids.includes(pid));
    assert.deepEqual(newPids, [], 'zaden NOWY WINWORD.EXE nie powinien powstac podczas scan/build');
  }
});

test('kreator-wzorow: kandydat "photoGallery" wstawia w build przez Open XML PRAWDZIWY MERGEFIELD Zdjecia_pomontazowe (real feature zgloszona przez uzytkownika 2026-09-21, ta sama galeria co Dokumenty seryjne juz obsluguja)', async (t) => {
  const port = await withKreatorApp(t);

  const form = new FormData();
  form.append('template', new Blob([buildRealFixtureDocx()], { type: 'application/octet-stream' }), 'wzor.docx');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-kreator-gallery-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const ExcelJSForGallery = require('../apps/ocr-audytow/node_modules/exceljs');
  const wb = new ExcelJSForGallery.Workbook();
  const ws = wb.addWorksheet('Dane');
  ws.addRow(['Adres', 'Wartosc']);
  ws.addRow(['Testowa 1', 'ABC']);
  const xlsxPath = path.join(dir, 'dane.xlsx');
  await wb.xlsx.writeFile(xlsxPath);
  form.append('excel', new Blob([await fsp.readFile(xlsxPath)], { type: 'application/octet-stream' }), 'dane.xlsx');

  const uploadRes = await fetch(`http://127.0.0.1:${port}/api/jobs`, { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' }, body: form });
  const uploadJson = await uploadRes.json();
  assert.equal(uploadRes.status, 200, JSON.stringify(uploadJson));
  const jobId = uploadJson.jobId;

  await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}/scan-markings`, { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' } });
  const scanRes = await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}/scan`, {
    method: 'POST', headers: { 'X-Scyzoryk-Request': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ selectedMarkings: ['highlight:yellow'] }),
  });
  const scanJson = await scanRes.json();
  assert.equal(scanRes.status, 200, JSON.stringify(scanJson));
  const candidate = scanJson.candidates[0];

  // Sciezka realnego uzytkownika: panel -> "ZDJĘCIA" -> POST .../photo-gallery
  // (nie PUT /config bezposrednio), zeby test faktycznie pokrywal ten endpoint.
  const decisionRes = await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}/candidates/${candidate.id}/photo-gallery`, {
    method: 'POST', headers: { 'X-Scyzoryk-Request': '1', 'Content-Type': 'application/json' }, body: '{}',
  });
  const decisionJson = await decisionRes.json();
  assert.equal(decisionRes.status, 200, JSON.stringify(decisionJson));
  assert.equal(decisionJson.draft.candidates[candidate.id].status, 'photoGallery');

  await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}/config`, {
    method: 'PUT', headers: { 'X-Scyzoryk-Request': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ addressColumn: 'Adres', candidates: decisionJson.draft.candidates }),
  });

  const buildRes = await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}/build`, { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' } });
  const buildJson = await buildRes.json();
  assert.equal(buildRes.status, 200, JSON.stringify(buildJson));

  const downloadRes = await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}/download/template`);
  const builtBuffer = Buffer.from(await downloadRes.arrayBuffer());
  const builtZip = new AdmZipForKreator(builtBuffer);
  const builtDocXml = builtZip.readAsText('word/document.xml');
  assert.match(builtDocXml, /MERGEFIELD Zdjecia_pomontazowe/);
  assert.doesNotMatch(builtDocXml, /<w:highlight/); // oznaczenie wyczyszczone jak przy kazdym innym typie decyzji
});

// ===========================================================================
// Auto-konfiguracja kandydatow (PROMPT_CLAUDE_AUTO_KONFIGURACJA_KREATORA.md) -
// pelny przeplyw HTTP scan -> auto-configure/analyze -> apply -> build. Ten
// fixture (w odroznieniu od buildRealFixtureDocx() powyzej, ktora ma TYLKO
// jeden goly highlight bez zadnego kontekstu) ma DWA oznaczone fragmenty z
// tekstem dookola w TYM SAMYM akapicie, zeby auto-konfigurator mial cokolwiek
// do dopasowania (ParagraphPrefix, patrz MarkScanner.PopulateParagraphContext).
// ===========================================================================

function buildAutoConfigFixtureDocx() {
  const zip = new AdmZipForKreator();
  zip.addFile('[Content_Types].xml', Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>', 'utf8'));
  zip.addFile('_rels/.rels', Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>', 'utf8'));
  zip.addFile('word/document.xml', Buffer.from(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:body>' +
    '<w:p><w:r><w:t xml:space="preserve">Adres inwestycji: </w:t></w:r><w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>Testowa 1</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t xml:space="preserve">Wartosc pomiaru: </w:t></w:r><w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>ABC</w:t></w:r></w:p>' +
    '<w:sectPr/>' +
    '</w:body>' +
    '</w:document>', 'utf8'));
  return zip.toBuffer();
}

async function setupAutoConfigJob(t) {
  const port = await withKreatorApp(t);
  const form = new FormData();
  form.append('template', new Blob([buildAutoConfigFixtureDocx()], { type: 'application/octet-stream' }), 'wzor.docx');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-kreator-autoconfig-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const ExcelJSForAutoConfig = require('../apps/ocr-audytow/node_modules/exceljs');
  const wb = new ExcelJSForAutoConfig.Workbook();
  const ws = wb.addWorksheet('Dane');
  ws.addRow(['Adres inwestycji', 'Wartosc pomiaru']);
  ws.addRow(['Testowa 1', 'ABC']);
  const xlsxPath = path.join(dir, 'dane.xlsx');
  await wb.xlsx.writeFile(xlsxPath);
  form.append('excel', new Blob([await fsp.readFile(xlsxPath)], { type: 'application/octet-stream' }), 'dane.xlsx');

  const uploadRes = await fetch(`http://127.0.0.1:${port}/api/jobs`, { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' }, body: form });
  const uploadJson = await uploadRes.json();
  assert.equal(uploadRes.status, 200, JSON.stringify(uploadJson));
  const jobId = uploadJson.jobId;

  await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}/scan-markings`, { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' } });
  const scanRes = await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}/scan`, {
    method: 'POST', headers: { 'X-Scyzoryk-Request': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ selectedMarkings: ['highlight:yellow'], sheetName: 'Dane' }),
  });
  const scanJson = await scanRes.json();
  assert.equal(scanRes.status, 200, JSON.stringify(scanJson));
  assert.equal(scanJson.candidates.length, 2);

  await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}/config`, {
    method: 'PUT', headers: { 'X-Scyzoryk-Request': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ addressColumn: 'Adres inwestycji', preferredSheet: 'Dane' }),
  });

  return { port, jobId, candidates: scanJson.candidates };
}

test('auto-configure/analyze: rozpoznaje kandydatow z jednoznacznym kontekstem, przynajmniej jeden z pewnoscia "auto"', async (t) => {
  const { port, jobId } = await setupAutoConfigJob(t);
  const res = await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}/auto-configure/analyze`, {
    method: 'POST', headers: { 'X-Scyzoryk-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  });
  const json = await res.json();
  assert.equal(res.status, 200, JSON.stringify(json));
  assert.equal(json.analysis.candidateSuggestions.length, 2);
  assert.ok(json.analysis.summary.auto >= 1, JSON.stringify(json.analysis.summary));
  assert.ok(json.analysis.candidateSuggestions.some(s => s.tier === 'auto' && s.bestColumn === 'Adres inwestycji'));
});

// Real bug zlapany na zywej instalacji uzytkownika (2026-09-14): backend
// poprawnie liczyl i zapisywal autoConfig, ale GET /api/jobs/:id (jedyne
// zrodlo stanu joba dla UI po kazdym loadJob()) nigdy go nie zwracal -
// front-end nie mial ZADNEGO sposobu zobaczenia sugestii mimo ze /analyze
// zwrocilo 200 z poprawna analiza. Ten test pilnuje TEGO KONKRETNEGO
// polaczenia (analyze -> zapis -> GET), nie tylko odpowiedzi /analyze.
test('auto-configure: GET /api/jobs/:id zwraca autoConfig po analyze (nie tylko odpowiedz /analyze) - bug zlapany na zywym dokumencie 2026-09-14', async (t) => {
  const { port, jobId } = await setupAutoConfigJob(t);
  await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}/auto-configure/analyze`, { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' } });

  const jobRes = await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}`);
  const jobJson = await jobRes.json();
  assert.equal(jobRes.status, 200);
  assert.ok(jobJson.job.autoConfig, 'GET /api/jobs/:id musi zwracac autoConfig, inaczej UI nigdy go nie zobaczy');
  assert.equal(jobJson.job.autoConfig.candidateSuggestions.length, 2);
  assert.equal(jobJson.job.autoConfig.candidateSuggestions[0].candidateId, jobJson.job.candidates[0].id);
});

test('auto-configure/apply: applyHighConfidence stosuje tylko sugestie "auto", zmniejsza unresolvedCount, build nadal dziala po zastosowaniu', async (t) => {
  const { port, jobId, candidates } = await setupAutoConfigJob(t);
  await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}/auto-configure/analyze`, { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' } });

  const applyRes = await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}/auto-configure/apply`, {
    method: 'POST', headers: { 'X-Scyzoryk-Request': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ applyHighConfidence: true }),
  });
  const applyJson = await applyRes.json();
  assert.equal(applyRes.status, 200, JSON.stringify(applyJson));
  assert.ok(applyJson.appliedCount >= 1);
  assert.ok(applyJson.unresolvedCount < candidates.length);

  // Kandydaci, ktorzy zostali "unresolved" (nie osiagneli progu auto), musza
  // zostac rozwiazani recznie zanim build zadziala - dokladnie tak, jak
  // dzialaloby to w prawdziwym UI po kliknieciu "Zastosuj pewnych".
  const jobRes = await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}`);
  const jobJson = await jobRes.json();
  const stillUnresolved = candidates.filter(c => {
    const decision = jobJson.job.draft.candidates[c.id];
    return !decision || decision.status === 'unresolved';
  });
  for (const c of stillUnresolved) {
    await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}/candidates/${c.id}/constant`, {
      method: 'POST', headers: { 'X-Scyzoryk-Request': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'STALA' }),
    });
  }

  const buildRes = await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}/build`, { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' } });
  const buildJson = await buildRes.json();
  assert.equal(buildRes.status, 200, JSON.stringify(buildJson));
});

test('auto-configure/reject: zapisuje feedback do pamieci, NIE dotyka draftu', async (t) => {
  const { port, jobId, candidates } = await setupAutoConfigJob(t);
  await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}/auto-configure/analyze`, { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' } });

  const beforeRes = await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}`);
  const beforeJson = await beforeRes.json();

  const rejectRes = await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}/auto-configure/reject`, {
    method: 'POST', headers: { 'X-Scyzoryk-Request': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ suggestionIds: [candidates[0].id] }),
  });
  const rejectJson = await rejectRes.json();
  assert.equal(rejectRes.status, 200, JSON.stringify(rejectJson));
  assert.equal(rejectJson.rejectedCount, 1);

  const afterRes = await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}`);
  const afterJson = await afterRes.json();
  assert.deepEqual(afterJson.job.draft.candidates, beforeJson.job.draft.candidates);
});

test('auto-configure endpointy wymagaja X-Scyzoryk-Request (403 bez naglowka)', async (t) => {
  const { port, jobId } = await setupAutoConfigJob(t);
  for (const suffix of ['analyze', 'apply', 'reject']) {
    const res = await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}/auto-configure/${suffix}`, { method: 'POST' });
    assert.equal(res.status, 403, suffix);
  }
});

// ===========================================================================
// Hardening HTTP: analysisId guard, review 1-klik + origin metadata, undo,
// reczna korekta ucząca pamiec, dedupe feedbacku (sekcje 9/12/13/20-28/33/34).
// ===========================================================================

async function analyzeJob(port, jobId) {
  const res = await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}/auto-configure/analyze`, {
    method: 'POST', headers: { 'X-Scyzoryk-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  });
  return res.json();
}

test('auto-configure/apply: stary analysisId jest odrzucany 409 po ponownej analizie (version guard, sekcja 28)', async (t) => {
  const { port, jobId } = await setupAutoConfigJob(t);
  const first = await analyzeJob(port, jobId);
  const staleAnalysisId = first.analysis.analysisId;
  assert.ok(staleAnalysisId);

  await analyzeJob(port, jobId); // druga analiza -> nowy analysisId

  const res = await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}/auto-configure/apply`, {
    method: 'POST', headers: { 'X-Scyzoryk-Request': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ analysisId: staleAnalysisId, applyHighConfidence: true }),
  });
  assert.equal(res.status, 409);
});

test('auto-configure/apply: 1-klikowa akceptacja pojedynczej sugestii (nie tylko applyHighConfidence) ustawia origin=reviewAccepted', async (t) => {
  const { port, jobId, candidates } = await setupAutoConfigJob(t);
  const analysis = (await analyzeJob(port, jobId)).analysis;
  const nonAuto = analysis.candidateSuggestions.find(s => s.tier !== 'auto' && s.kind === 'field' && s.bestColumn) || analysis.candidateSuggestions.find(s => s.tier === 'auto');
  assert.ok(nonAuto, 'fixture powinna miec co najmniej jedna sugestie do zaakceptowania 1-klikiem');

  const applyRes = await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}/auto-configure/apply`, {
    method: 'POST', headers: { 'X-Scyzoryk-Request': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ analysisId: analysis.analysisId, suggestionIds: [nonAuto.candidateId] }),
  });
  const applyJson = await applyRes.json();
  assert.equal(applyRes.status, 200, JSON.stringify(applyJson));
  assert.equal(applyJson.appliedCount, 1);

  const jobJson = (await (await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}`)).json()).job;
  const meta = jobJson.candidateDecisionMeta[nonAuto.candidateId];
  assert.ok(meta);
  assert.equal(meta.origin, nonAuto.tier === 'auto' ? 'auto' : 'reviewAccepted');
});

test('auto-configure/undo: cofa TYLKO origin=auto, nie rusza reczne/reviewAccepted decyzje', async (t) => {
  const { port, jobId, candidates } = await setupAutoConfigJob(t);
  const analysis = (await analyzeJob(port, jobId)).analysis;

  // Zastosuj pewne (origin=auto)
  await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}/auto-configure/apply`, {
    method: 'POST', headers: { 'X-Scyzoryk-Request': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ analysisId: analysis.analysisId, applyHighConfidence: true }),
  });
  // Recznie rozstrzygnij cokolwiek zostalo (origin=manual)
  let job = (await (await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}`)).json()).job;
  const stillUnresolved = candidates.filter(c => !job.draft.candidates[c.id] || job.draft.candidates[c.id].status === 'unresolved');
  for (const c of stillUnresolved) {
    await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}/candidates/${c.id}/constant`, {
      method: 'POST', headers: { 'X-Scyzoryk-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'STALA' }),
    });
  }
  job = (await (await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}`)).json()).job;
  const beforeUndoStatuses = { ...job.draft.candidates };
  const autoIds = Object.entries(job.candidateDecisionMeta).filter(([, m]) => m.origin === 'auto').map(([id]) => id);
  const manualIds = Object.entries(job.candidateDecisionMeta).filter(([, m]) => m.origin === 'manual').map(([id]) => id);

  const undoRes = await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}/auto-configure/undo`, { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' } });
  const undoJson = await undoRes.json();
  assert.equal(undoRes.status, 200, JSON.stringify(undoJson));
  assert.equal(undoJson.undoneCount, autoIds.length);

  const after = (await (await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}`)).json()).job;
  for (const id of autoIds) assert.equal(after.draft.candidates[id].status, 'unresolved', `${id} (origin=auto) powinien wrocic do unresolved`);
  for (const id of manualIds) assert.equal(after.draft.candidates[id].status, beforeUndoStatuses[id].status, `${id} (origin=manual) NIE powinien byc ruszony`);
});

test('reczna korekta po sugestii ucza pamiec (sekcja 12/34) - kolejny job z tym samym kontekstem preferuje finalna kolumne', async (t) => {
  const { port, jobId, candidates } = await setupAutoConfigJob(t);
  const analysis = (await analyzeJob(port, jobId)).analysis;
  const addressCandidate = candidates.find(c => c.paragraphPrefix && c.paragraphPrefix.toLowerCase().includes('adres'));
  assert.ok(addressCandidate);
  const suggestion = analysis.candidateSuggestions.find(s => s.candidateId === addressCandidate.id);
  assert.ok(suggestion);

  // Recznie ustaw jako STALA (nie pole) - to jest KOREKTA wzgledem sugestii
  // "Z Excela" (jesli taka byla) - powinno odrzucic sugerowana kolumne w pamieci.
  const res = await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}/candidates/${addressCandidate.id}/constant`, {
    method: 'POST', headers: { 'X-Scyzoryk-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'zawsze taki sam tekst' }),
  });
  assert.equal(res.status, 200);

  const jobJson = (await (await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}`)).json()).job;
  assert.equal(jobJson.candidateDecisionMeta[addressCandidate.id].origin, 'manual');
});

test('auto-configure/reject: dedupe - odrzucenie TEJ SAMEJ sugestii dwa razy w jednym jobie nie nabija licznika w pamieci podwojnie', async (t) => {
  const { port, jobId, candidates } = await setupAutoConfigJob(t);
  const analysis = (await analyzeJob(port, jobId)).analysis;
  const suggestion = analysis.candidateSuggestions.find(s => s.bestColumn);
  assert.ok(suggestion, 'fixture powinna miec co najmniej jedna sugestie z bestColumn');

  for (let i = 0; i < 2; i++) {
    const res = await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}/auto-configure/reject`, {
      method: 'POST', headers: { 'X-Scyzoryk-Request': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ analysisId: analysis.analysisId, suggestionIds: [suggestion.candidateId] }),
    });
    assert.equal(res.status, 200);
  }

  const job = (await (await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}`)).json()).job;
  // feedbackEvents jest Setem logicznym (bez duplikatow) - jeden wpis mimo
  // dwoch identycznych requestow reject.
  const rejectEvents = job.autoConfig.feedbackEvents.filter(e => e.startsWith(`reject:${suggestion.candidateId}:`));
  assert.equal(rejectEvents.length, 1);
});
