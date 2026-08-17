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
  // tekstowymi). powershell.exe (nie pwsh), ten sam wzorzec exe co
  // lib/hardening.js#runPowerShell.
  // Audyt na zywo 2026-08-17: pierwszy prawdziwy przebieg tego kroku przez CI
  // ujawnil, ze dev-machine mial TYLKO wbudowany w Windows PowerShell 5.1
  // Pester 3.4.0, a windows-latest w CI domyslnie rozwiazuje nowszy Pester
  // 5+ (skladnia "Should -X" z myslnikiem, brak parametru -EnableExit -
  // usunietego w Pester 5+). Naprawa: jawnie wymagamy Pester >=5.0.0 (musi
  // byc zainstalowany oddzielnie, patrz README/onboarding dla
  // `Install-Module Pester -Scope CurrentUser`) i uzywamy -PassThru +
  // FailedCount zamiast -EnableExit, bo ta wlasciwosc istnieje identycznie
  // w Pester 3 i 5+ - odporne na to, ktora wersja faktycznie sie zaladuje.
  ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    'Import-Module Pester -MinimumVersion 5.0.0 -Force; $result = Invoke-Pester -Path test/print-engine.Tests.ps1 -PassThru; if ($result.FailedCount -gt 0) { exit 1 }']]
];

for (const [exe, args] of tests) {
  const result = spawnSync(exe, args, { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log('Wszystkie testy regresji przeszly.');
