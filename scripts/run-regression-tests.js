const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TEST_DIR = path.join(ROOT, 'test');

// Audyt rozdz. 9 (P1): ta lista kiedys byla trzymana recznie i rozjechala
// sie z package.json - nowe grupy (10-15) istnialy jako pliki i skrypty
// test:groupN, ale ten runner (a wiec i zainstalowana wersja, ktora go
// wywoluje) nigdy ich nie uruchamial. Zamiast pielegnowac druga, latwo
// przestarzala liste - wykrywamy wszystkie test/group*.test.js automatycznie,
// posortowane numerycznie po numerze grupy, zeby kolejnosc byla stabilna i
// czytelna w logach.
function discoverGroupTestFiles() {
  const entries = fs.readdirSync(TEST_DIR).filter(name => /^group\d+.*\.test\.js$/.test(name));
  entries.sort((a, b) => {
    const numA = parseInt(a.match(/^group(\d+)/)[1], 10);
    const numB = parseInt(b.match(/^group(\d+)/)[1], 10);
    if (numA !== numB) return numA - numB;
    return a.localeCompare(b);
  });
  if (!entries.length) {
    throw new Error(`Brak plikow test/group*.test.js w ${TEST_DIR} - runner nie znalazl niczego do uruchomienia.`);
  }
  return entries.map(name => path.join('test', name));
}

const tests = [
  [process.execPath, ['--test', ...discoverGroupTestFiles()]],
  [process.execPath, ['apps/drukarka-projekty/test-sorting-regression.js']],
  // Audyt 2026-08-14: testy Pester dla lib/printing/PrintEngine.psm1 (glowna
  // przyczyna dzisiejszych awarii druku - cudzyslowowanie -ArgumentList -
  // nigdy nie byla pokryta prawdziwym testem behawioralnym, tylko wzorcami
  // tekstowymi). powershell.exe (nie pwsh) - Pester 3.4.0 jest wbudowany w
  // Windows PowerShell 5.1, ten sam runtime co print-file.ps1 na produkcji i
  // co windows-latest w CI (ten sam wzorzec exe co lib/hardening.js#runPowerShell).
  ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    'Invoke-Pester -Path test/print-engine.Tests.ps1 -EnableExit']]
];

for (const [exe, args] of tests) {
  const result = spawnSync(exe, args, { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log('Wszystkie testy regresji przeszly.');
