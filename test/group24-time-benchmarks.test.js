const assert = require('assert');
const test = require('node:test');

const {
  BENCHMARKS,
  estimateManualMs,
  estimateSavedMs
} = require('../lib/timeBenchmarks');

test('benchmarki odpowiadaja zaakceptowanym pomiarom recznym', () => {
  assert.equal(estimateManualMs('formularze-ecodan', 84), 84 * 92_000);
  assert.equal(estimateManualMs('dokumenty-seryjne', 300), 300 * 30_000);
  assert.equal(estimateManualMs('wnioski-powykonawcze', 36), 36 * 78_000);
  assert.equal(estimateManualMs('formularze-varmero', 188), 188 * 71_000);
  assert.equal(estimateManualMs('tworzenie-folderow', 100), 100 * 15_000);
  assert.equal(estimateManualMs('nazywarka-skanow', 4), 44_000);

  assert.equal(estimateManualMs('drukarka-projekty', 100, 'stamps'), 100 * 727_000);
  assert.equal(estimateManualMs('drukarka-projekty', 100, 'noStamps'), 100 * 572_000);

  assert.equal(BENCHMARKS['karty-katalogowe'].enabled, false);
  assert.equal(estimateManualMs('karty-katalogowe', 10), null);
});

test('oszczednosc nigdy nie jest ujemna', () => {
  assert.equal(estimateSavedMs('tworzenie-folderow', 100, 3_000), 1_497_000);
  assert.equal(estimateSavedMs('nazywarka-skanow', 4, 23_000), 21_000);
  assert.equal(estimateSavedMs('tworzenie-folderow', 1, 20_000), 0);
});
