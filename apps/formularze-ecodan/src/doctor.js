import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function ok(label, value = '') {
  console.log(`[OK] ${label}${value ? `: ${value}` : ''}`);
}

function warn(label, value = '') {
  console.log(`[WARN] ${label}${value ? `: ${value}` : ''}`);
}

function fail(label, value = '') {
  console.log(`[FAIL] ${label}${value ? `: ${value}` : ''}`);
}

function exists(p) {
  return fs.existsSync(path.resolve(p));
}

function canResolvePackage(pkg) {
  // Dwie strategie, bo rozne pakiety maja rozne "exports" w swoim
  // package.json: niektore (np. archiver: "exports": "./index.js") NIE
  // wystawiaja "./package.json" jako importowalnej sciezki (require.resolve
  // samego "pkg" dziala, ale "pkg/package.json" - falszywy alarm "missing").
  // Inne (np. read-excel-file) w ogole nie maja glownego eksportu "." i
  // trzeba uzyc konkretnej podsciezki jak "read-excel-file/node" w kodzie
  // aplikacji - tam "pkg/package.json" akurat nadal dziala. Probujemy obu,
  // wystarczy ze jedna sie uda.
  try {
    require.resolve(pkg);
    return true;
  } catch {}
  try {
    require.resolve(`${pkg}/package.json`);
    return true;
  } catch {}
  return false;
}

console.log('Ecodan Generator doctor');
console.log('-----------------------');
ok('Node.js', process.version);
ok('Working directory', process.cwd());

if (exists('package.json')) ok('package.json found'); else fail('package.json missing');
if (exists('package-lock.json')) warn('package-lock.json exists', 'delete it if npm tries to use a wrong registry'); else ok('package-lock.json not present');

const requiredPackages = ['express', 'playwright', 'read-excel-file', 'pdf-parse', 'multer', 'sanitize-filename', 'archiver'];
let missingDeps = 0;
for (const pkg of requiredPackages) {
  if (canResolvePackage(pkg)) ok(`dependency ${pkg}`); else { warn(`dependency ${pkg} missing`, 'run install-public.cmd or start.cmd'); missingDeps += 1; }
}

try {
  const { chromium } = await import('playwright');
  const exe = chromium.executablePath();
  if (fs.existsSync(exe)) ok('Playwright Chromium browser', exe);
  else warn('Playwright Chromium browser missing', 'run npm.cmd run install-browsers');
} catch (error) {
  warn('Playwright cannot be loaded', error.message);
}

const dirs = ['output', 'uploads'];
for (const dir of dirs) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.write-test'), 'ok');
    fs.rmSync(path.join(dir, '.write-test'), { force: true });
    ok(`write access to ${dir}`);
  } catch (error) {
    fail(`write access to ${dir}`, error.message);
  }
}

console.log('-----------------------');
if (missingDeps) {
  console.log('Missing dependencies detected. Run: install-public.cmd');
} else {
  console.log('Basic diagnostics finished.');
}
console.log('If npm uses a strange registry, run: npm.cmd config set registry https://registry.npmjs.org/');
