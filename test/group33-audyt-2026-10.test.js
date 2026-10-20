// Audyt calego programu 2026-10-20 - testy regresji dla znalezionych bledow.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('isAllowedHost: petla zwrotna i *.localhost przechodza, obca domena (DNS rebinding) nie', () => {
  const { isAllowedHost } = require('../lib/localRequestSecurity');
  for (const ok of ['127.0.0.1:3004', '127.0.0.1', 'localhost:3000', 'scyzoryk.localhost:3000', 'SCYZORYK.localhost', '[::1]:3016', '']) {
    assert.equal(isAllowedHost(ok), true, ok);
  }
  for (const bad of ['evil.example:3004', 'evil.example', '192.168.1.10:3000', 'localhost.evil.example', '127.0.0.1.nip.io:3000']) {
    assert.equal(isAllowedHost(bad), false, bad);
  }
});

test('applySecurityHeaders: zadanie z obcym naglowkiem Host dostaje 403, zwykle 200 (kazda apka uzywa tej warstwy)', async () => {
  const express = require(path.join(ROOT, 'apps/dokumenty-seryjne/node_modules/express'));
  const { applySecurityHeaders } = require('../lib/localRequestSecurity');
  const app = express();
  applySecurityHeaders(app, "default-src 'self'");
  app.get('/x', (req, res) => res.send('ok'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const port = server.address().port;
  const status = host => new Promise(resolve => {
    http.get({ hostname: '127.0.0.1', port, path: '/x', headers: { Host: host } }, res => { res.resume(); resolve(res.statusCode); });
  });
  try {
    assert.equal(await status(`127.0.0.1:${port}`), 200);
    assert.equal(await status(`scyzoryk.localhost:${port}`), 200);
    assert.equal(await status(`evil.example:${port}`), 403);
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('panel glowny (server.js) sprawdza naglowek Host przed obsluga zadania', () => {
  const src = read('server.js');
  assert.match(src, /if \(!isAllowedHost\(req\.headers\.host\)\) return send\(res, 403/);
});

test('kreator-wzorow: GET-y poza limitem zadan (dawny warunek "/api/jobs/..." nigdy nie pasowal do req.path pod app.use("/api"))', () => {
  const src = read('apps/kreator-wzorow/server.js');
  const limiter = src.slice(src.indexOf('const apiLimiter = rateLimit'), src.indexOf('});', src.indexOf('const apiLimiter = rateLimit')));
  assert.match(limiter, /skip: req => req\.method === 'GET',/);
  assert.doesNotMatch(limiter, /\\\/api\\\/jobs/);
  assert.match(limiter, /KREATOR_API_RATE_LIMIT \|\| 600/);
});

test('dokumenty-seryjne: paczki zdjec maja osobny limit (nie zjadaja limitu generowania), GET-y poza limitem', () => {
  const src = read('apps/dokumenty-seryjne/server.js');
  assert.match(src, /app\.post\('\/api\/images\/:jobId', imageBatchLimiter,/);
  assert.match(src, /SERYJNE_IMAGE_BATCH_RATE_LIMIT \|\| 300/);
  assert.match(src, /SERYJNE_HEAVY_RATE_LIMIT \|\| 30/);
  const limiter = src.slice(src.indexOf('const apiLimiter = rateLimit'), src.indexOf('});', src.indexOf('const apiLimiter = rateLimit')));
  assert.match(limiter, /skip: \(req\) => req\.method === 'GET',/);
});

test('dokumenty-seryjne: po "Przerwij"/limicie czasu wynik zawiera pliki juz gotowe (eventy export-done), nie "0 plikow"', () => {
  const src = read('apps/dokumenty-seryjne/server.js');
  assert.match(src, /job\.liveCreated = \[\];/);
  assert.match(src, /job\.liveCreated\.push\(/);
  assert.match(src, /const partial = \(job\.liveCreated \|\| \[\]\)/);
  assert.match(src, /created: partial,/);
  // limit czasu skalowany liczba rekordow (sztywne 60 min ucinalo 377 adresow)
  assert.match(src, /Math\.max\(60 \* 60 \* 1000, rowsForMerge\.length \* 60 \* 1000\)/);
});

test('pipeline: nie da sie usunac trwajacego przebiegu (409), "Wyczysc historie" go pomija', () => {
  const src = read('apps/pipeline/server.js');
  assert.match(src, /const isRunActive = run => Boolean\(run\) && run\.status === 'running';/);
  assert.match(src, /res\.status\(409\)/);
});

test('pipeline: przebieg z krokiem "blad" konczy sie statusem "skonczony-z-bledami", UI zna ten status', () => {
  const runs = read('apps/pipeline/src/runs.js');
  assert.match(runs, /function statusZakonczenia\(run\)/);
  assert.match(runs, /'skonczony-z-bledami' : 'skonczony'/);
  const ui = read('apps/pipeline/public/app.js');
  assert.match(ui, /'skonczony-z-bledami': 'skończony z błędami'/);
  assert.match(ui, /STATUSY_ZAKONCZONE = \['skonczony', 'skonczony-z-bledami'/);
});

test('kazda strona pomocy, ktora laduje pomoc.js, ma ten plik obok (OCR go nie mial - martwy link do panelu)', () => {
  for (const app of fs.readdirSync(path.join(ROOT, 'apps'))) {
    const pomoc = path.join(ROOT, 'apps', app, 'public', 'pomoc.html');
    if (!fs.existsSync(pomoc)) continue;
    const html = fs.readFileSync(pomoc, 'utf8');
    for (const m of html.matchAll(/<script src="([^"/]+\.js)"/g)) {
      assert.ok(fs.existsSync(path.join(ROOT, 'apps', app, 'public', m[1])), `${app}/public/${m[1]} (z pomoc.html) nie istnieje`);
    }
  }
});

test('drukarka: nazwa polaczonego PDF w poprawnej odmianie ("2 pliki", nie "2 plików")', () => {
  const src = read('apps/drukarka/server.js');
  const body = src.slice(src.indexOf('function plikiOdmiana(n)'), src.indexOf('}', src.indexOf('function plikiOdmiana(n)') + 200) + 1);
  // eslint-disable-next-line no-new-func
  const plikiOdmiana = new Function(`${body}; return plikiOdmiana;`)();
  assert.equal(plikiOdmiana(2), 'pliki');
  assert.equal(plikiOdmiana(4), 'pliki');
  assert.equal(plikiOdmiana(5), 'plików');
  assert.equal(plikiOdmiana(12), 'plików');
  assert.equal(plikiOdmiana(22), 'pliki');
});

test('launcher: kazda galaz kasujaca znacznik pending-update.json zostawia wpis w logu', () => {
  const src = read('launcher/Scyzoryk.Launcher/LauncherApp.cs');
  const fn = src.slice(src.indexOf('private async Task<bool> ApplyPendingUpdateIfAnyAsync'), src.indexOf('private void TryDeletePendingUpdateMarker'));
  const deletes = fn.split('TryDeletePendingUpdateMarker(pendingPath);').length - 1;
  const logs = (fn.match(/_logger\.Log\(/g) || []).length;
  assert.ok(logs >= deletes, `logow ${logs} < kasowan ${deletes}`);
  assert.match(fn, /Niekompletny znacznik oczekujacej aktualizacji/);
});

test('runner regresji: limit czasu na test i na caly krok (zawieszenie nie blokuje CI w nieskonczonosc)', () => {
  const src = read('scripts/run-regression-tests.js');
  assert.match(src, /--test-timeout=/);
  assert.match(src, /timeout: RUN_TIMEOUT_MS/);
  assert.doesNotMatch(src, /'--test-force-exit'/, 'na Windows wywraca Node (UV_HANDLE_CLOSING)');
});

test('pliki testow dotykajace druku / "Zapisz jako PDF" izoluja katalog danych (nie pisza do prawdziwego %LOCALAPPDATA%)', () => {
  for (const f of ['test/group2-printing.test.js', 'test/group17-drukarka-projekty-save-as-pdf.test.js', 'test/group27-document-engine.test.js', 'test/group32-poprawki-ux.test.js']) {
    assert.match(read(f), /SCYZORYK_DATA_ROOT/, `${f} nie ustawia SCYZORYK_DATA_ROOT`);
  }
});

test('smoke test bezpieczenstwa obejmuje wszystkie narzedzia z rejestru panelu', () => {
  const smoke = read('scripts/security-smoke-test.js');
  const server = read('server.js');
  const slugs = [...server.matchAll(/\{ slug: '([a-z0-9-]+)', name:/g)].map(m => m[1]);
  assert.ok(slugs.length >= 14, `rejestr: ${slugs.length}`);
  for (const slug of slugs) assert.match(smoke, new RegExp(`name: '${slug}'`), `brak ${slug} w security-smoke-test.js`);
  assert.match(smoke, /odrzuca obcy naglowek Host/);
});

test('ocr-audytow: pomoc.js identyczny ze wspolnym (linki do panelu i zrzuty)', async () => {
  const a = await fsp.readFile(path.join(ROOT, 'apps/ocr-audytow/public/pomoc.js'), 'utf8');
  const b = await fsp.readFile(path.join(ROOT, 'apps/drukarka/public/pomoc.js'), 'utf8');
  assert.equal(a, b);
});

test('kazda apka, ktorej pomoc.html laduje zrzuty z panelu (data-main-asset), ma panel w CSP img-src', () => {
  for (const app of fs.readdirSync(path.join(ROOT, 'apps'))) {
    const pomoc = path.join(ROOT, 'apps', app, 'public', 'pomoc.html');
    if (!fs.existsSync(pomoc) || !/data-main-asset/.test(fs.readFileSync(pomoc, 'utf8'))) continue;
    const server = read(`apps/${app}/server.js`);
    assert.match(server, /img-src[^;"]*http:\/\/127\.0\.0\.1:3000/, `${app}: CSP img-src bez panelu - zrzuty w pomocy sa blokowane`);
  }
});
