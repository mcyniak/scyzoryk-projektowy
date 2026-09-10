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
