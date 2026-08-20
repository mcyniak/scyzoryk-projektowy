const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// Znajduje kazdy .html w repo (poza node_modules/output/uploads/itd, ten sam
// wzorzec pomijania co scripts/check-project.js) zawierajacy przycisk
// data-theme-toggle - wspolny przelacznik motywu serwowany przez
// shared-styles/theme.js (patrz komentarz w tym pliku).
const SKIP_DIRS = new Set(['node_modules', 'uploads', 'output', 'tmp', 'data', 'logs', '.git', 'bin', 'obj']);

function findHtmlFilesWithThemeToggle(dir, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      findHtmlFilesWithThemeToggle(path.join(dir, entry.name), results);
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      const filePath = path.join(dir, entry.name);
      const content = fs.readFileSync(filePath, 'utf8');
      if (content.includes('data-theme-toggle')) results.push(filePath);
    }
  }
  return results;
}

// Audyt 2026-08-20: przycisk przelacznika motywu mial WYLACZNIE dynamicznie
// (JS, dopiero po DOMContentLoaded) ustawiany aria-label - w statycznym
// zrodle HTML/przy wylaczonym JS byl anonimowym "button" bez dostepnej nazwy
// dla czytnika ekranu. Naprawa: staly aria-label wprost w markupie (theme.js
// i tak go pozniej nadpisuje precyzyjniejszym "Przelacz na jasny/ciemny
// motyw" - patrz shared-styles/theme.js#updateToggleIcon), wiec zachowanie
// dla widzacego uzytkownika sie nie zmienia, a nazwa dostepna jest zawsze
// obecna od pierwszego renderu.
test('kazdy przycisk data-theme-toggle w repo ma staly aria-label w HTML (nie tylko dynamicznie z JS)', () => {
  const files = findHtmlFilesWithThemeToggle(ROOT);
  assert.ok(files.length > 5, `oczekiwano wielu plikow HTML z przelacznikiem motywu, znaleziono ${files.length} - sprawdz czy skanowanie dziala`);
  const bezAriaLabel = [];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    // Wyciagnij kazdy tag <button ...data-theme-toggle...> i sprawdz aria-label W TYM SAMYM tagu.
    const buttonTagPattern = /<button\b[^>]*data-theme-toggle[^>]*>/g;
    const matches = content.match(buttonTagPattern) || [];
    for (const tag of matches) {
      if (!/aria-label=/.test(tag)) bezAriaLabel.push(path.relative(ROOT, file));
    }
  }
  assert.deepEqual(bezAriaLabel, [], `pliki z przyciskiem data-theme-toggle bez statycznego aria-label: ${bezAriaLabel.join(', ')}`);
});
