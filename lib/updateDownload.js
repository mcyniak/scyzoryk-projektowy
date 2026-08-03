// Pobieranie plikow aktualizacji (instalator EXE + suma .sha256) i
// weryfikacja kryptograficzna. Wylacznie wbudowane moduly Node.js.
const fs = require('fs');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { URL } = require('url');
const { USER_AGENT, isAllowedProtocol } = require('./updateGithub');

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_INSTALLER_BYTES = 400 * 1024 * 1024; // 400 MB - hojny margines nad realny rozmiar instalatora
const DEFAULT_MAX_TEXT_BYTES = 8 * 1024; // plik .sha256 to jedna linia tekstu

function followableGet(urlString, redirectsLeft, timeoutMs) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlString);
    } catch (_) {
      return reject(new Error(`Nieprawidlowy adres URL: ${urlString}`));
    }
    if (!isAllowedProtocol(parsed)) {
      return reject(new Error(`Zablokowano polaczenie inne niz HTTPS: ${urlString}`));
    }
    // Patrz analogiczny komentarz w updateGithub.js - modul `https` odrzuca
    // URL-e http: sam z siebie, wiec transport wybieramy PO wlasnej
    // walidacji protokolu.
    const client = parsed.protocol === 'https:' ? https : http;

    const req = client.get(parsed, { headers: { 'User-Agent': USER_AGENT }, timeout: timeoutMs }, res => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('Przekroczono limit przekierowan HTTPS.'));
        let nextUrl;
        try {
          nextUrl = new URL(res.headers.location, parsed).toString();
        } catch (_) {
          return reject(new Error('Nieprawidlowy adres przekierowania.'));
        }
        return resolve(followableGet(nextUrl, redirectsLeft - 1, timeoutMs));
      }
      if (status < 200 || status >= 300) {
        res.resume();
        return reject(new Error(`Pobieranie nie powiodlo sie - serwer odpowiedzial kodem ${status}.`));
      }
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error('Przekroczono limit czasu pobierania.')));
    req.on('error', reject);
  });
}

// Pobiera maly plik tekstowy (suma .sha256) w calosci do pamieci - nigdy nie
// jest to duzy plik, wiec streamowanie na dysk byloby niepotrzebne.
async function downloadText(urlString, options = {}) {
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const maxBytes = Number(options.maxBytes || DEFAULT_MAX_TEXT_BYTES);
  const maxRedirects = Number.isInteger(options.maxRedirects) ? options.maxRedirects : DEFAULT_MAX_REDIRECTS;
  const res = await followableGet(urlString, maxRedirects, timeoutMs);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    res.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        res.destroy(new Error('Plik jest wiekszy niz oczekiwano dla sumy kontrolnej.'));
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  });
}

// Pobiera duzy plik binarny (instalator) strumieniowo do "<dest>.partial",
// liczac SHA-256 w trakcie pobierania (bez drugiego przejscia po pliku).
// Zwraca { bytes, sha256, partialPath }. NIE zmienia nazwy na finalna -
// to robi wywolujacy (updateService) dopiero PO potwierdzeniu sumy kontrolnej,
// zeby nigdy nie zostawic na dysku pliku z finalna nazwa, ktory nie przeszedl
// weryfikacji.
async function downloadToPartialFile(urlString, destPath, options = {}) {
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const maxBytes = Number(options.maxBytes || DEFAULT_MAX_INSTALLER_BYTES);
  const maxRedirects = Number.isInteger(options.maxRedirects) ? options.maxRedirects : DEFAULT_MAX_REDIRECTS;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};

  const partialPath = `${destPath}.partial`;
  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  const res = await followableGet(urlString, maxRedirects, timeoutMs);
  const declaredLength = Number(res.headers['content-length'] || 0) || null;
  if (declaredLength && declaredLength > maxBytes) {
    res.destroy();
    throw new Error(`Deklarowany rozmiar pliku (${declaredLength} B) przekracza dozwolony limit.`);
  }

  const hash = crypto.createHash('sha256');
  let total = 0;
  const out = fs.createWriteStream(partialPath);

  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const fail = err => { if (!settled) { settled = true; reject(err); } };

      res.on('data', chunk => {
        total += chunk.length;
        if (total > maxBytes) {
          res.destroy();
          out.destroy();
          return fail(new Error('Pobierany plik przekroczyl maksymalny dozwolony rozmiar.'));
        }
        hash.update(chunk);
        onProgress({ downloadedBytes: total, totalBytes: declaredLength || total });
      });
      res.on('error', fail);
      out.on('error', fail);
      out.on('finish', () => { if (!settled) { settled = true; resolve(); } });
      res.pipe(out);
    });
  } catch (err) {
    try { fs.unlinkSync(partialPath); } catch (_) {}
    throw err;
  }

  return { bytes: total, sha256: hash.digest('hex'), partialPath };
}

// Parsuje format `sha256sum` ("HEX  nazwapliku" albo "HEX *nazwapliku",
// dopuszczalne wiodace/koncowe biale znaki) i zwraca hex hash MALYMI
// literami. Rzuca blad przy dowolnym innym formacie albo gdy nazwa pliku w
// srodku nie zgadza sie z oczekiwana - nie akceptujemy "prawie dobrej" sumy.
function parseSha256File(text, expectedFileName) {
  const line = String(text || '').trim().split(/\r?\n/)[0] || '';
  const match = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
  if (!match) throw new Error('Plik .sha256 ma nieprawidlowy format.');
  const [, hex, fileName] = match;
  if (fileName.trim() !== expectedFileName) {
    throw new Error(`Plik .sha256 wskazuje na inny plik ("${fileName.trim()}"), oczekiwano "${expectedFileName}".`);
  }
  return hex.toLowerCase();
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

module.exports = {
  downloadText,
  downloadToPartialFile,
  parseSha256File,
  sha256File,
  DEFAULT_MAX_INSTALLER_BYTES,
  DEFAULT_MAX_TEXT_BYTES
};
