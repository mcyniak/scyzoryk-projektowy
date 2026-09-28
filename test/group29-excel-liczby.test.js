// Liczby z Excela w dokumentach: przecinek dziesietny, bez szumu float.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { excelCellText } = require('../lib/excelCellText');
const { parseSmartNumber } = require('../lib/smartTemplateRules');

test('excelCellText: ulamki z przecinkiem, calkowite bez zmian', () => {
  assert.equal(excelCellText(4.32), '4,32');
  assert.equal(excelCellText(0.1 + 0.2), '0,3');
  assert.equal(excelCellText(-12.5), '-12,5');
  assert.equal(excelCellText(6), '6');
  assert.equal(excelCellText(5260012345), '5260012345');
  assert.equal(excelCellText(0.0000001), '0,0000001');
  assert.equal(excelCellText(new Date(2026, 8, 28)), '28.09.2026');
  assert.equal(excelCellText('  4.32 kWp '), '4.32 kWp');
  assert.equal(excelCellText(null), '');
  assert.equal(excelCellText(true), 'true');
});

test('warunki blokow nadal rozumieja liczbe z przecinkiem', () => {
  assert.equal(parseSmartNumber(excelCellText(4.32)).value, 4.32);
});

test('Dokumenty seryjne i Kreator uzywaja wspolnego formatu', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  assert.match(fs.readFileSync(path.join(root, 'apps/dokumenty-seryjne/server.js'), 'utf8'), /require\('..\/..\/lib\/excelCellText'\)/);
  assert.match(fs.readFileSync(path.join(root, 'apps/kreator-wzorow/src/excelWorkbook.js'), 'utf8'), /lib\/excelCellText/);
});
