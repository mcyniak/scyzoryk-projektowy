const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const jsFiles = [];
const psFiles = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // 'bin'/'obj' to wyjscie dotnet build/publish w launcher\ (Scyzoryk.exe, C#) -
    // nigdy nie zawieraja .js/.ps1, wiec pomijanie ich to tylko wydajnosc, nie
    // poprawnosc (filtr rozszerzen nizej i tak by je odrzucil).
    if (['node_modules', 'uploads', 'output', 'tmp', 'data', 'logs', 'bin', 'obj'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() && entry.name.endsWith('.js')) jsFiles.push(full);
    else if (entry.isFile() && entry.name.endsWith('.ps1')) psFiles.push(full);
  }
}

function rel(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

walk(ROOT);
let failed = 0;

for (const file of jsFiles) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status === 0) console.log('OK  JS ' + rel(file));
  else {
    failed += 1;
    console.error('ERR JS ' + rel(file));
    if (result.stderr) console.error(result.stderr.trim());
  }
}

const psExe = process.env.POWERSHELL_EXE || (process.platform === 'win32' ? 'powershell.exe' : 'pwsh');
for (const file of psFiles) {
  // Parser.ParseFile wymaga prawdziwych zmiennych przekazanych przez [ref].
  // [ref]$null w Windows PowerShell 5.1 powoduje blad:
  // "[ref] cannot be applied to a variable that does not exist".
  const command = [
    `$ErrorActionPreference='Stop'`,
    `$target=${JSON.stringify(file)}`,
    `$tokens=$null`,
    `$parseErrors=$null`,
    `[System.Management.Automation.Language.Parser]::ParseFile($target, [ref]$tokens, [ref]$parseErrors) | Out-Null`,
    `if ($null -ne $parseErrors -and $parseErrors.Count -gt 0) {`,
    `  $parseErrors | ForEach-Object { Write-Error ($_.Message + ' at line ' + $_.Extent.StartLineNumber + ', column ' + $_.Extent.StartColumnNumber) }`,
    `  exit 1`,
    `}`
  ].join('; ');
  const result = spawnSync(psExe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { encoding: 'utf8' });
  if (result.error && ['ENOENT', 'EACCES', 'EPERM'].includes(result.error.code)) {
    console.log('SKIP PS PowerShell niedostepny lub brak uprawnien: ' + rel(file));
    continue;
  }
  if (result.status === 0) console.log('OK  PS ' + rel(file));
  else {
    failed += 1;
    console.error('ERR PS ' + rel(file));
    if (result.stderr) console.error(result.stderr.trim());
    if (result.stdout) console.error(result.stdout.trim());
  }
}

if (failed) {
  console.error('\nWykryto bledy skladni: ' + failed);
  process.exit(1);
}

console.log(`\nSprawdzono JS: ${jsFiles.length}, PS: ${psFiles.length}`);
