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

// =====================================================================
// Standard UI aplikacji (2026-08-28, "standaryzacja wszystkich apek"):
// kazda apka w apps/ ma identyczna strukture strony glownej i Pomocy.
// Test wymusza standard, zeby kolejne apki nie odjezdzaly stylistycznie.
// =====================================================================
const APPS_DIR = path.join(ROOT, 'apps');

function readText(p) { return fs.readFileSync(p, 'utf8'); }

test('standard UI: kazda apka - index.html z shared CSS, headerem (Pomoc -> pomoc.html, Panel glowny), hero (kicker/h1/lead)', () => {
  const apps = fs.readdirSync(APPS_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  assert.ok(apps.length >= 10, `oczekiwano co najmniej 10 apek, znaleziono ${apps.length}`);
  const problems = [];
  for (const app of apps) {
    const pub = path.join(APPS_DIR, app, 'public');
    const idx = path.join(pub, 'index.html');
    if (!fs.existsSync(idx)) { problems.push(`${app}: brak public/index.html`); continue; }
    const c = readText(idx);
    for (const needle of [
      '/shared/tokens.css',
      '/shared/components.css',
      'href="app.css"',
      '/shared/theme.js',
      'href="pomoc.html"',
      'data-main-link',
      'data-theme-toggle',
      'class="kicker"',
      '<h1',
      'class="lead"'
    ]) {
      if (!c.includes(needle)) problems.push(`${app}: index.html brak "${needle}"`);
    }
    const pomoc = path.join(pub, 'pomoc.html');
    if (!fs.existsSync(pomoc)) { problems.push(`${app}: brak public/pomoc.html`); continue; }
    const p = readText(pomoc);
    for (const needle of ['/shared/help.css', 'help-tagline', 'Krok po kroku', 'help-callout', 'href="index.html"']) {
      if (!p.includes(needle)) problems.push(`${app}: pomoc.html brak "${needle}"`);
    }
  }
  assert.deepEqual(problems, [], `apki odstajace od standardu:\n${problems.join('\n')}`);
});

test('standard UI: zero legacy CSS (base.css/styles.css) i zero martwych stron (folder.html/folder.js) w public apek', () => {
  const bad = [];
  for (const app of fs.readdirSync(APPS_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)) {
    const pub = path.join(APPS_DIR, app, 'public');
    if (!fs.existsSync(pub)) continue;
    for (const f of fs.readdirSync(pub)) {
      if (/^(base|styles)\.css$/i.test(f) || /^folder\.(html|js)$/i.test(f)) bad.push(`${app}/public/${f}`);
    }
  }
  assert.deepEqual(bad, [], `zbedne pliki w public apek: ${bad.join(', ')}`);
});
