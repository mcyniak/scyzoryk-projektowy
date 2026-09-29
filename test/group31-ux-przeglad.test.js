// Przeglad UX calego programu (2026-09-29): wspolne pomocniki w
// shared-styles/theme.js, polskie komunikaty bledow i najwazniejsze poprawki
// bezpieczenstwa zgloszen/druku, ktorych nie widac w innych testach.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

function loadThemeJs(cookie = '') {
  const listeners = {};
  const attrs = {};
  const sandbox = {
    window: { addEventListener: (type, fn) => { listeners[type] = fn; }, matchMedia: () => ({ matches: false }) },
    document: {
      cookie,
      documentElement: { setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: k => { delete attrs[k]; } },
      addEventListener: () => {},
      querySelectorAll: () => [],
    },
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  vm.runInNewContext(read('shared-styles', 'theme.js'), sandbox);
  return { ui: sandbox.window.ScyzorykUI, attrs, listeners };
}

test('theme.js: motyw z ciasteczka (wspolny dla wszystkich portow) i pomocniki UI', () => {
  const { ui, attrs, listeners } = loadThemeJs('foo=1; scyzorykTheme=dark');
  assert.equal(attrs['data-theme'], 'dark');
  assert.equal(ui.plural(1, 'plik', 'pliki', 'plików'), '1 plik');
  assert.equal(ui.plural(3, 'plik', 'pliki', 'plików'), '3 pliki');
  assert.equal(ui.plural(5, 'plik', 'pliki', 'plików'), '5 plików');
  assert.equal(ui.plural(12, 'plik', 'pliki', 'plików'), '12 plików');
  assert.equal(ui.plural(22, 'plik', 'pliki', 'plików'), '22 pliki');
  assert.match(ui.friendlyError(new TypeError('Failed to fetch')), /Brak połączenia/);
  assert.match(ui.friendlyError("EBUSY: resource busy or locked, open 'x.xlsx'"), /otwarty w innym programie/);
  assert.equal(ui.friendlyError('Zwykły polski komunikat.'), 'Zwykły polski komunikat.');
  assert.equal(ui.escapeHtml('<a&b>'), '&lt;a&amp;b&gt;');
  // Upuszczenie pliku poza strefa nie moze otworzyc pliku zamiast narzedzia.
  let prevented = false;
  listeners.drop({ defaultPrevented: false, dataTransfer: { types: ['Files'] }, target: { tagName: 'DIV' }, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  prevented = false;
  listeners.drop({ defaultPrevented: false, dataTransfer: { types: ['Files'] }, target: { tagName: 'INPUT', type: 'file' }, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false, 'natywne <input type=file> dziala dalej');
});

test('lib/uploadErrors: kody multer i systemu plikow po polsku', () => {
  const { polishErrorMessage } = require('../lib/uploadErrors');
  assert.match(polishErrorMessage({ code: 'LIMIT_FILE_COUNT', message: 'Too many files' }), /Za dużo plików/);
  assert.match(polishErrorMessage({ code: 'EBUSY', message: 'EBUSY: resource busy' }), /otwarty w innym programie/);
  assert.equal(polishErrorMessage(new Error('Coś innego.')), 'Coś innego.');
});

test('Varmero: dane inwestycji nie sa pamietane, jedno zglaszanie naraz, podglad poza limitem', () => {
  const ui = read('apps', 'formularze-varmero', 'public', 'inline-1.js');
  const save = ui.match(/function saveSettings\(\) \{[\s\S]*?\n\}/)[0];
  for (const key of ['gminaName', 'postalCode', 'zone', 'investmentName']) assert.doesNotMatch(save, new RegExp(`${key}:`), `${key} nie moze byc zapamietywany`);
  assert.match(ui, /resumeRunningJob/);
  assert.match(ui, /row\.cancelled/);
  assert.doesNotMatch(ui, /^(?!\s*\/\/).*\balert\(/m, 'bez blokujacych alert() (poza komentarzami)');
  const server = read('apps', 'formularze-varmero', 'server.js');
  assert.match(server, /ACTIVE_JOB_STATUSES/);
  assert.match(server, /status\(409\)[\s\S]{0,80}activeJobId/);
  assert.match(server, /app\.post\('\/api\/batch\/preview', \(req, res, next\)/);
});

test('Ecodan: zmiana pliku czysci liste adresow, start bez sprawdzenia zablokowany, podglad poza limitem', () => {
  const ui = read('apps', 'formularze-ecodan', 'public', 'inline-1.js');
  assert.match(ui, /invalidateAddressPreview\('Wybrano inny plik/);
  assert.match(ui, /Najpierw kliknij „Sprawdź adresy”/);
  assert.doesNotMatch(ui, /raportów dla WSZYSTKICH/);
  assert.match(read('apps', 'formularze-ecodan', 'server.js'), /app\.post\('\/api\/batch\/preview', \(req, res, next\)/);
});

test('Drukarka projektow: zmiana po zatwierdzeniu blokuje druk do ponownego zatwierdzenia', () => {
  const ui = read('apps', 'drukarka-projekty', 'public', 'app.js');
  assert.match(ui, /function markQueueStale/);
  assert.ok((ui.match(/markQueueStale\("(orderError|wmError)"\)/g) || []).length >= 5);
  assert.match(ui, /state\.confirmedQueue/);
});

test('Drukarka: blad druku/zapisu zostawia niewyslane pliki w kolejce', () => {
  const server = read('apps', 'drukarka', 'server.js');
  assert.match(server, /queue = keepForRetry;/);
  assert.match(server, /Pliki zostały w kolejce - możesz spróbować ponownie/);
});

test('Pipeline: zaznaczony krok bez folderu jest odrzucany (klient i serwer), przyczyna awarii widoczna', () => {
  assert.match(read('apps', 'pipeline', 'public', 'app.js'), /function brakujaceSciezki/);
  assert.match(read('apps', 'pipeline', 'public', 'app.js'), /run\.bladOgolny/);
  assert.match(read('apps', 'pipeline', 'server.js'), /WYMAGANE_SCIEZKI/);
});

test('Panel: powod awarii narzedzia po polsku (np. zajety port)', () => {
  const server = read('server.js');
  assert.match(server, /function describeChildProblem/);
  assert.match(server, /EADDRINUSE/);
  assert.match(read('public', 'inline-1.js'), /lastApp\?\.child\?\.problem/);
});
