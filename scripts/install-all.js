const path = require('path');
const { spawnSync } = require('child_process');
const { createRequire } = require('module');
const fs = require('fs');
const { hasDependencies } = require('../lib/dependencyCheck');

const ROOT = path.join(__dirname, '..');
const VERIFY_APP_HEALTH = path.join(ROOT, 'scripts', 'verify-app-health.js');
const isWin = process.platform === 'win32';
const npmCmd = process.env.NPM_CMD || (isWin ? 'npm.cmd' : 'npm');

const apps = [
  { name: 'Drukarka', dir: path.join(ROOT, 'apps', 'drukarka'), deps: ['express', 'multer', 'express-rate-limit', 'pdf-lib'] },
  { name: 'Pieczatki PDF', dir: path.join(ROOT, 'apps', 'pieczatki-pdf'), deps: ['express', 'multer', 'pdf-lib', 'archiver', '@pdf-lib/fontkit', 'pdfjs-dist', 'express-rate-limit'] },
  { name: 'Formularze Ecodan', dir: path.join(ROOT, 'apps', 'formularze-ecodan'), deps: ['express', 'playwright', 'read-excel-file', 'pdf-parse', 'pdf-lib', 'multer', 'sanitize-filename', 'archiver', 'express-rate-limit'], playwright: true },
  { name: 'Dokumenty seryjne PDF', dir: path.join(ROOT, 'apps', 'dokumenty-seryjne'), deps: ['express', 'multer', 'read-excel-file', 'sanitize-filename', 'archiver', 'express-rate-limit'] },
  { name: 'Wnioski powykonawcze PDF', dir: path.join(ROOT, 'apps', 'wnioski-powykonawcze'), deps: ['express', 'multer', 'sanitize-filename', 'archiver', 'express-rate-limit'] },
  { name: 'Karty katalogowe', dir: path.join(ROOT, 'apps', 'karty-katalogowe'), deps: ['express', 'multer', 'read-excel-file', 'sanitize-filename', 'express-rate-limit'] },
  { name: 'Drukarka projekty', dir: path.join(ROOT, 'apps', 'drukarka-projekty'), deps: ['express', 'multer', 'express-rate-limit', 'xlsx', 'mammoth', 'pdf-parse', 'pdf-lib', 'sanitize-filename'] },
  { name: 'OCR audytów', dir: path.join(ROOT, 'apps', 'ocr-audytow'), deps: ['express', 'multer', 'express-rate-limit', 'pdf-lib', '@pdf-lib/fontkit', 'pdf-parse', 'jimp', 'sanitize-filename', 'xlsx', '@google-cloud/documentai', 'exceljs'] }
];

function quoteCmdArg(value) {
  const text = String(value);
  if (!/[\s"&()^|<>]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function lockfileUsesInternalRegistry(appDir) {
  const lockPath = path.join(appDir, 'package-lock.json');
  if (!fs.existsSync(lockPath)) return false;
  try {
    const text = fs.readFileSync(lockPath, 'utf8');
    return /applied-caas|artifactory|internal\.api\.openai/i.test(text);
  } catch (_) {
    return false;
  }
}

function runOnce(command, args, cwd) {
  const env = {
    ...process.env,
    npm_config_registry: 'https://registry.npmjs.org/',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_fetch_retries: '5',
    npm_config_fetch_retry_factor: '2',
    npm_config_fetch_retry_mintimeout: '10000',
    npm_config_fetch_retry_maxtimeout: '120000',
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || '0'
  };

  if (isWin && /\.cmd$/i.test(command)) {
    const line = ['call', quoteCmdArg(command), ...args.map(quoteCmdArg)].join(' ');
    return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', line], { cwd, stdio: 'inherit', env, windowsHide: true });
  }
  return spawnSync(command, args, { cwd, stdio: 'inherit', env });
}

function run(command, args, cwd, options = {}) {
  const attempts = Number(options.attempts || 3);
  let last = null;
  for (let i = 1; i <= attempts; i += 1) {
    if (i > 1) console.log(`Ponawiam probe ${i}/${attempts}...`);
    last = runOnce(command, args, cwd);
    if (!last.error && last.status === 0) return;
    const msg = last.error ? last.error.message : `kod ${last.status}`;
    if (i < attempts) console.warn(`Komenda nie powiodla sie (${msg}). Czekam chwile i probuje ponownie.`);
  }
  if (last?.error) {
    console.error(`Nie udalo sie uruchomic: ${command}`);
    console.error(last.error.message);
  } else {
    console.error(`Komenda zakonczyla sie bledem: ${command} ${args.join(' ')}`);
  }
  console.error('Jesli problem dotyczy sieci npm, uruchom ponownie node scripts/install-all.js albo sprawdz polaczenie/proxy.');
  process.exit(last?.status || 1);
}

function hasDeps(app) {
  return hasDependencies(app.dir, app.deps);
}

function hasChromium(app) {
  try {
    const requireFromApp = createRequire(path.join(app.dir, 'server.js'));
    const { chromium } = requireFromApp('playwright');
    return fs.existsSync(chromium.executablePath());
  } catch (_) {
    return false;
  }
}

for (const app of apps) {
  console.log(`\n=== ${app.name} ===`);
  if (hasDeps(app)) {
    console.log('Zaleznosci OK - pomijam npm install.');
  } else {
    console.log('Instaluje zaleznosci...');
    const lockPath = path.join(app.dir, 'package-lock.json');
    const hasLock = fs.existsSync(lockPath) && !lockfileUsesInternalRegistry(app.dir);
    if (fs.existsSync(lockPath) && !hasLock) {
      console.warn('Wykryto lockfile z wewnetrznym registry. Uzywam npm install zamiast npm ci.');
    }
    const installArgs = hasLock
      ? ['ci', '--fund=false', '--registry=https://registry.npmjs.org/']
      : ['install', '--fund=false', '--registry=https://registry.npmjs.org/'];
    run(npmCmd, installArgs, app.dir, { attempts: 3 });
  }

  if (app.playwright) {
    if (hasChromium(app)) {
      console.log('Playwright Chromium OK.');
    } else {
      console.log('Instaluje Chromium dla Playwright...');
      run(npmCmd, ['run', 'install-browsers'], app.dir, { attempts: 2 });
    }
  }

  console.log('Sprawdzam endpoint /api/health...');
  run(process.execPath, [VERIFY_APP_HEALTH, app.dir, path.basename(app.dir)], ROOT, { attempts: 1 });
}

console.log('\nGotowe. Mozesz uruchomic: node server.js albo start.cmd');
