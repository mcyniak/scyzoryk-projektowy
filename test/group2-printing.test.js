const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const test = require('node:test');

const printing = require('../lib/printing');
const {
  PrintLeaseBusyError,
  readLock,
  withPrintLease
} = require('../lib/printCoordinator');

function withDataRoot(tempRoot, body) {
  const previous = process.env.SCYZORYK_DATA_ROOT;
  process.env.SCYZORYK_DATA_ROOT = tempRoot;
  return Promise.resolve()
    .then(body)
    .finally(() => {
      if (previous === undefined) delete process.env.SCYZORYK_DATA_ROOT;
      else process.env.SCYZORYK_DATA_ROOT = previous;
    });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function request(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/', timeout: 3000 }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function waitForLockRelease(timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await readLock()) === null) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(await readLock(), null, 'Globalna blokada drukowania nie zostala zwolniona na czas.');
}

test('globalny lease odrzuca konkurencyjny druk i przejmuje martwy lock', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scyzoryk-print-lock-'));
  try {
    await withDataRoot(tempRoot, async () => {
      let releaseFirst;
      let enteredFirst;
      const entered = new Promise(resolve => { enteredFirst = resolve; });
      const hold = new Promise(resolve => { releaseFirst = resolve; });
      const first = withPrintLease({ app: 'drukarka' }, async () => {
        enteredFirst();
        await hold;
      });
      await entered;

      await assert.rejects(
        withPrintLease({ app: 'drukarka-projekty' }, async () => {}),
        error => error instanceof PrintLeaseBusyError && error.ownerMeta.app === 'drukarka'
      );
      releaseFirst();
      await first;
      assert.equal(await readLock(), null);

      const lockDir = path.join(tempRoot, 'runtime', 'printing');
      fs.mkdirSync(lockDir, { recursive: true });
      fs.writeFileSync(path.join(lockDir, 'active.lock'), JSON.stringify({
        pid: 2147483647,
        token: 'martwy',
        app: 'stary-proces'
      }), 'utf8');
      await withPrintLease({ app: 'drukarka-projekty' }, async () => {});
      assert.equal(await readLock(), null);
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('drugi endpoint drukowania dostaje HTTP 409 podczas aktywnego lease', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scyzoryk-print-http-'));
  let releaseFirst;
  const hold = new Promise(resolve => { releaseFirst = resolve; });

  function createPrintServer(appName, shouldHold) {
    return http.createServer(async (req, res) => {
      try {
        await withPrintLease({ app: appName }, async () => {
          if (shouldHold) await hold;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
      } catch (error) {
        if (error instanceof PrintLeaseBusyError) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, code: error.code, owner: error.ownerMeta }));
          return;
        }
        res.writeHead(500);
        res.end();
      }
    });
  }

  try {
    await withDataRoot(tempRoot, async () => {
      const firstServer = createPrintServer('drukarka', true);
      const secondServer = createPrintServer('drukarka-projekty', false);
      const firstPort = await listen(firstServer);
      const secondPort = await listen(secondServer);

      try {
        const firstRequest = request(firstPort);
        while ((await readLock())?.app !== 'drukarka') {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        const secondResponse = await request(secondPort);
        assert.equal(secondResponse.statusCode, 409);
        assert.equal(JSON.parse(secondResponse.body).code, 'PRINT_LOCK_BUSY');

        releaseFirst();
        assert.equal((await firstRequest).statusCode, 200);
      } finally {
        releaseFirst();
        await Promise.all([close(firstServer), close(secondServer)]);
        await waitForLockRelease();
      }
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('duplex jest przywracany w finally po bledzie serii', async () => {
  const commands = [];
  const runPowerShell = async (scriptPath, args) => {
    const command = args[1];
    commands.push(command);
    if (commands.length === 1) {
      return { stdout: 'Drukarka testowa|jednostronnie|TwoSidedShortEdge\r\n' };
    }
    return { stdout: 'OK\r\n' };
  };

  await assert.rejects(
    printing.withPrinterSides('one-sided', 'Drukarka testowa', async setup => {
      assert.equal(setup.previousDuplexingMode, 'TwoSidedShortEdge');
      throw new Error('blad serii');
    }, { platform: 'win32', runPowerShell }),
    /blad serii/
  );

  assert.equal(commands.length, 2);
  assert.match(commands[0], /Get-PrintConfiguration/);
  assert.match(commands[1], /TwoSidedShortEdge/);
  assert.match(commands[1], /Set-PrintConfiguration/);
});

test('print-file.ps1: brak cichego fallbacku na drukarke domyslna i wymog potwierdzenia kolejki (audyt v1.0.4, P0-1/P1-10)', () => {
  const root = path.resolve(__dirname, '..');
  const script = fs.readFileSync(path.join(root, 'lib', 'printing', 'print-file.ps1'), 'utf8');
  // Audyt 2026-08-14: silnik druku (Invoke-PrintWith*, Wait-ForPrintJobProgress)
  // zostal wydzielony do PrintEngine.psm1, zeby Pester (test/print-engine.Tests.ps1)
  // mogl go testowac w izolacji - czesc asercji ponizej sprawdza wiec ten
  // modul zamiast/oprocz samego print-file.ps1.
  const engineModule = fs.readFileSync(path.join(root, 'lib', 'printing', 'PrintEngine.psm1'), 'utf8');

  // P0-1a: gdy druk PDF-a zawiedzie (Sumatra i Ghostscript obie), skrypt MUSI
  // przerwac z bledem - nie wolno mu przechodzic na Invoke-PrintWithShell
  // (Start-Process -Verb Print), ktora zalezy od skojarzenia pliku z
  // aplikacja w Windows i rzuca InvalidOperationException na maszynach bez
  // zarejestrowanego domyslnego czytnika PDF. Audyt 2026-08-13: funkcja ta
  // zostala usunieta calkowicie (byla martwym kodem - jedyne jej wywolanie,
  // uzywane wczesniej TYLKO gdy nie wskazano jawnie drukarki, zostalo
  // zastapione uzyciem Sumatry/Ghostscriptu z realnie wyliczona drukarka
  // domyslna, patrz $printerName wyzej w skrypcie).
  assert.match(script, /PRINT_TARGETED_FAILED/);
  // Funkcja zostala usunieta calkowicie, ale jej nazwa (i "-Verb Print")
  // zostaja w komentarzach audytowych jako uzasadnienie usuniecia - sprawdzamy
  // wiec brak DEFINICJI, nie kazde wystapienie samej nazwy w tekscie.
  assert.doesNotMatch(script, /function Invoke-PrintWithShell/);
  assert.doesNotMatch(engineModule, /function Invoke-PrintWithShell/);
  const targetedBlockMatch = script.match(/if \(\$isPdf\) \{[\s\S]*?\n\}/);
  assert.ok(targetedBlockMatch, 'nie znaleziono bloku if ($isPdf)');
  assert.match(targetedBlockMatch[0], /Invoke-PrintWithSumatra/);
  assert.match(targetedBlockMatch[0], /Invoke-PrintWithGhostscript/);

  // P0-1b: "OK" na koncu skryptu nie moze juz byc bezwarunkowe, gdy sledzenie
  // kolejki bylo dostepne, a zadne nowe zadanie sie nie pojawilo.
  assert.match(script, /PRINT_NOT_CONFIRMED/);
  assert.match(script, /\$trackingAvailable -and -not \$jobConfirmed/);

  // P1-10: petla oczekiwania na Word COM ma teraz limit czasu (wczesniej byla
  // nieskonczona - zawieszony sterownik/spooler blokowalby caly proces na
  // zawsze). Ta petla mieszka teraz w PrintEngine.psm1 (Invoke-PrintWithWordCom).
  assert.match(engineModule, /\$printWaitDeadline = \(Get-Date\)\.AddSeconds\(60\)/);
  const wordWaitMatch = engineModule.match(/while \(\$word\.BackgroundPrintingStatus -ne 0\) \{[\s\S]*?\n    \}/);
  assert.ok(wordWaitMatch, 'nie znaleziono petli oczekiwania BackgroundPrintingStatus');
  assert.match(wordWaitMatch[0], /printWaitDeadline/);
});

test('skrypt nie dotyka cudzych okien i drukuje DOCX przez wlasny Word COM', () => {
  const root = path.resolve(__dirname, '..');
  const script = fs.readFileSync(path.join(root, 'lib', 'printing', 'print-file.ps1'), 'utf8');
  const engineModule = fs.readFileSync(path.join(root, 'lib', 'printing', 'PrintEngine.psm1'), 'utf8');
  assert.doesNotMatch(script, /Set-PrintAppWindowsMinimized/);
  assert.doesNotMatch(engineModule, /Set-PrintAppWindowsMinimized/);
  assert.doesNotMatch(script, /Get-Process\s+-Name\s+(?:Acrobat|AcroRd32|WINWORD)/i);
  assert.doesNotMatch(engineModule, /Get-Process\s+-Name\s+(?:Acrobat|AcroRd32|WINWORD)/i);
  assert.match(engineModule, /New-Object -ComObject Word\.Application/);
  assert.match(engineModule, /\$word\.ActivePrinter = \$PrinterName/);

  for (const file of ['apps/drukarka/server.js', 'apps/drukarka-projekty/server.js']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(source, /withPrintLease/);
    assert.match(source, /PRINT_LOCK_BUSY/);
    assert.doesNotMatch(source, /closePdfAppsAfterBatch/);
  }
});

test('print-file.ps1: Ghostscript zastapil Acrobata jako zapasowy silnik druku (audyt 2026-08-13)', () => {
  const root = path.resolve(__dirname, '..');
  const script = fs.readFileSync(path.join(root, 'lib', 'printing', 'print-file.ps1'), 'utf8');
  const engineModule = fs.readFileSync(path.join(root, 'lib', 'printing', 'PrintEngine.psm1'), 'utf8');
  const combined = script + '\n' + engineModule;

  // Acrobat usuniety jako silnik druku - nie da sie go legalnie dolaczyc do
  // instalatora (komentarze WYJASNIAJACE dlaczego moga nadal wspominac nazwe
  // historycznie, wiec sprawdzamy brak faktycznego KODU, nie brak slowa).
  assert.doesNotMatch(combined, /\$AcrobatPath/);
  assert.doesNotMatch(combined, /Invoke-PrintWithAcrobat/);
  assert.doesNotMatch(combined, /Close-AcrobatIfUsed/);
  assert.doesNotMatch(combined, /Acrobat\.exe|AcroRd32\.exe/);

  // Ghostscript jako zapasowy silnik, wskazujacy na wendorowana binarke
  // (patrz PrintEngine.psm1 - $script:GhostscriptPath).
  assert.match(engineModule, /\$script:GhostscriptPath = Join-Path \$PSScriptRoot "ghostscript\\bin\\gswin64c\.exe"/);
  assert.match(combined, /Invoke-PrintWithGhostscript/);
  assert.match(combined, /-sDEVICE=mswinpr2/);

  // -dNoCancel chowa wbudowany pasek postepu mswinpr2 (Devices.rst) - bez
  // niego Ghostscript pokazuje wlasne male okienko przy kazdym druku
  // (zlapane live 2026-08-13).
  assert.match(combined, /-dNoCancel/);

  // SAFER musi pozostac aktywne (domyslne od gs 9.50) - nigdy nie wylaczamy
  // go blankietowo dla tresci PDF-ow pochodzacych od uzytkownikow. Wolno
  // przyznac WYLACZNIE zgode na wybor urzadzenia druku. Sprawdzamy faktyczna
  // tablice argumentow gs (New-GhostscriptPrintArgs w PrintEngine.psm1), nie
  // caly plik - komentarz wyjasniajacy decyzje legalnie wspomina "-dNOSAFER"
  // jako to, czego swiadomie NIE uzywamy.
  const gsArgsMatch = engineModule.match(/return @\(([\s\S]*?)\)\r?\n\}/);
  assert.ok(gsArgsMatch, 'nie znaleziono tablicy argumentow w New-GhostscriptPrintArgs');
  assert.doesNotMatch(gsArgsMatch[1], /-dNOSAFER/);
  assert.match(combined, /--permit-devices=mswinpr2/);

  // Dispatch: Sumatra pozostaje pierwsza probą, Ghostscript zastepuje Acrobata
  // jako druga (i ostatnia) - bez trzeciej linii.
  assert.match(script, /Invoke-PrintWithSumatra[\s\S]*?Invoke-PrintWithGhostscript/);
  assert.match(script, /PRINT_TARGETED_FAILED.*Sumatra i Ghostscript zawiodly/);
});

test('print-file.ps1: silnik druku wydzielony do PrintEngine.psm1 pod testy Pester (audyt 2026-08-14)', () => {
  const root = path.resolve(__dirname, '..');
  const script = fs.readFileSync(path.join(root, 'lib', 'printing', 'print-file.ps1'), 'utf8');
  const engineModule = fs.readFileSync(path.join(root, 'lib', 'printing', 'PrintEngine.psm1'), 'utf8');

  assert.match(script, /Import-Module \(Join-Path \$PSScriptRoot "PrintEngine\.psm1"\) -Force/);
  assert.match(engineModule, /function New-SumatraPrintArgs/);
  assert.match(engineModule, /function New-GhostscriptPrintArgs/);
  assert.match(engineModule, /function Wait-ForPrintJobProgress/);
  // Cudzyslowowanie argumentow (audyt 2026-08-13, glowna przyczyna awarii
  // druku tej nocy) - obie funkcje budujace argumenty musza recznie
  // doklejac cudzyslowy wokol nazwy drukarki I sciezki pliku, nie polegac na
  // automatycznym cytowaniu przez Start-Process -ArgumentList (ktore w tym
  // srodowisku zawodzi dla argumentow ze spacjami - patrz
  // test/print-engine.Tests.ps1 dla behawioralnego dowodu).
  assert.match(engineModule, /"`"\$targetPrinter`""/);
  assert.match(engineModule, /"`"\$path`""/);
  assert.ok(fs.existsSync(path.join(root, 'test', 'print-engine.Tests.ps1')), 'brak test/print-engine.Tests.ps1');
});

test('lib/printing/ghostscript: wendorowany runtime jest kompletny i ma dolaczona licencje AGPL', () => {
  const root = path.resolve(__dirname, '..');
  const gsDir = path.join(root, 'lib', 'printing', 'ghostscript');
  for (const rel of [
    'bin/gswin64c.exe',
    'bin/gsdll64.dll',
    'Resource/Init/gs_init.ps',
    'COPYING',
    'README.md'
  ]) {
    assert.ok(fs.existsSync(path.join(gsDir, rel)), `Brakuje wendorowanego pliku Ghostscript: ${rel}`);
  }
  // gswin64.exe (wariant z oknem GUI) i doc/examples nie sa potrzebne w
  // uzyciu wylacznie jako biblioteka druku - swiadomie pominiete przy
  // wendorowaniu, zeby nie rozdmuchiwac instalatora.
  assert.equal(fs.existsSync(path.join(gsDir, 'bin', 'gswin64.exe')), false);
  assert.equal(fs.existsSync(path.join(gsDir, 'doc')), false);
  assert.equal(fs.existsSync(path.join(gsDir, 'examples')), false);

  const copying = fs.readFileSync(path.join(gsDir, 'COPYING'), 'utf8');
  assert.match(copying, /GNU AFFERO GENERAL PUBLIC LICENSE/);
});

// convertDocxBatchToPdf zostalo wyciagniete z apps/drukarka-projekty/server.js
// do lib/printing.js (2026-08-19), zeby apps/drukarka mogla tez zaoferowac
// wlasna opcje "Zapisz jako PDF" bez trzymania drugiej, driftujacej kopii
// konwersji DOCX->PDF (patrz analogiczny test w
// test/group13-drukarka-projekty-powykonawcza.test.js, ktory sprawdza ze
// drukarka-projekty faktycznie deleguje do TEJ funkcji, nie wlasnej kopii).
test('lib/printing: convertDocxBatchToPdf istnieje, uzywa skryptu z lib/printing/, i nie-detached spawn (bezpieczny wobec bledu Windows/Node: detached:true zawsze zglasza kod wyjscia 0)', () => {
  assert.equal(typeof printing.convertDocxBatchToPdf, 'function');
  assert.ok(fs.existsSync(printing.DOCX_TO_PDF_SCRIPT), 'lib/printing/docx-to-pdf.ps1 powinien istniec');
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'lib', 'printing.js'), 'utf8');
  const spawnMatch = src.match(/spawn\('powershell\.exe'[\s\S]{0,400}\}\);/);
  assert.ok(spawnMatch, 'nie znaleziono wywolania powershell.exe dla docx-to-pdf w lib/printing.js');
  assert.doesNotMatch(spawnMatch[0], /detached:\s*true/);
});

// Audyt rozdz. 10/11, P0: scalanie sasiadujacych PDF-ow przy druku
// dwustronnym nie moze pozwolic, zeby pierwsza strona kolejnego dokumentu
// wyladowala na odwrocie ostatniej strony poprzedniego.
{
  const { PDFDocument } = require('../apps/drukarka/node_modules/pdf-lib');

  async function makeTempDir() {
    return fs.promises.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-merge-'));
  }

  async function createPdf(filePath, pageCount, size = [400, 600]) {
    const document = await PDFDocument.create();
    for (let i = 0; i < pageCount; i += 1) document.addPage(size);
    await fs.promises.writeFile(filePath, await document.save());
  }

  test('drukarka pdfMerge.mergePdfs: bez padOddPagesExceptLast zero regresji (stare zachowanie)', async (t) => {
    const { mergePdfs } = require('../apps/drukarka/src/pdfMerge');
    const dir = await makeTempDir();
    t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));

    const a = path.join(dir, 'a.pdf');
    const b = path.join(dir, 'b.pdf');
    await createPdf(a, 3);
    await createPdf(b, 2);

    const out = path.join(dir, 'out.pdf');
    await mergePdfs([a, b], out);
    const merged = await PDFDocument.load(await fs.promises.readFile(out));
    assert.equal(merged.getPageCount(), 5, 'bez flagi laczenie dziala jak wczesniej - brak pustych stron');
  });

  test('drukarka pdfMerge.mergePdfs: padOddPagesExceptLast wstawia pusta strone po nieparzystostronicowym pliku, ale nie na koncu (audyt rozdz. 10, P0)', async (t) => {
    const { mergePdfs } = require('../apps/drukarka/src/pdfMerge');
    const dir = await makeTempDir();
    t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));

    const a = path.join(dir, 'a.pdf');
    const b = path.join(dir, 'b.pdf');
    await createPdf(a, 3, [300, 500]);
    await createPdf(b, 2, [400, 600]);

    const out = path.join(dir, 'out.pdf');
    await mergePdfs([a, b], out, { padOddPagesExceptLast: true });
    const merged = await PDFDocument.load(await fs.promises.readFile(out));
    assert.equal(merged.getPageCount(), 6, 'plik "a" ma nieparzysta liczbe stron (3) i nie jest ostatni - dostaje jedna pusta strone');

    const blankPage = merged.getPage(3);
    assert.deepEqual([blankPage.getWidth(), blankPage.getHeight()], [300, 500], 'pusta strona ma rozmiar ostatniej strony poprzedniego pliku');
  });

  test('drukarka pdfMerge.mergePdfs: padOddPagesExceptLast NIE dodaje pustej strony po ostatnim pliku w run, nawet jesli ma nieparzysta liczbe stron', async (t) => {
    const { mergePdfs } = require('../apps/drukarka/src/pdfMerge');
    const dir = await makeTempDir();
    t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));

    const a = path.join(dir, 'a.pdf');
    const b = path.join(dir, 'b.pdf');
    await createPdf(a, 2);
    await createPdf(b, 3);

    const out = path.join(dir, 'out.pdf');
    await mergePdfs([a, b], out, { padOddPagesExceptLast: true });
    const merged = await PDFDocument.load(await fs.promises.readFile(out));
    assert.equal(merged.getPageCount(), 5, 'ostatni plik w run nigdy nie dostaje doklejonej pustej strony na koncu');
  });

  test('drukarka-projekty pdfMerge.mergePdfs: wstawia pusta strone bezwarunkowo (sideMode nieznany na etapie budowania kolejki - domyslnie dwustronnie w UI) (audyt rozdz. 11, P1)', async (t) => {
    const { mergePdfs } = require('../apps/drukarka-projekty/src/pdfMerge');
    const dir = await makeTempDir();
    t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));

    const a = path.join(dir, 'a.pdf');
    const b = path.join(dir, 'b.pdf');
    await createPdf(a, 3);
    await createPdf(b, 2);

    const out = path.join(dir, 'out.pdf');
    await mergePdfs([a, b], out);
    const merged = await PDFDocument.load(await fs.promises.readFile(out));
    assert.equal(merged.getPageCount(), 6);
  });

  // "Zapisz jako PDF" (2026-08-19) - druga sciezka /api/print, printerName ===
  // sentinel "__SAVE_AS_PDF__", ktora NIGDY nie dotyka fizycznej drukarki
  // (patrz analogiczny test dla apps/drukarka-projekty). Sprawdza pelny
  // przeplyw: upload -> print(sentinel) -> status.savedFolder -> plik na
  // dysku - nie tylko ze kod istnieje, ale ze faktycznie dziala.
  test('drukarka: "Zapisz jako PDF" (printerName __SAVE_AS_PDF__) laczy sasiadujace PDF-y i zapisuje TRWALE pliki bez dotykania fizycznej drukarki', async (t) => {
    const dir = await makeTempDir();
    t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scyzoryk-drukarka-data-'));
    const previousDataRoot = process.env.SCYZORYK_DATA_ROOT;
    process.env.SCYZORYK_DATA_ROOT = dataRoot;
    t.after(() => {
      if (previousDataRoot === undefined) delete process.env.SCYZORYK_DATA_ROOT;
      else process.env.SCYZORYK_DATA_ROOT = previousDataRoot;
      fs.rmSync(dataRoot, { recursive: true, force: true });
    });

    delete require.cache[require.resolve('../apps/drukarka/server.js')];
    const { app } = require('../apps/drukarka/server.js');
    const server = app.listen(0, '127.0.0.1');
    const port = await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.once('listening', () => resolve(server.address().port));
    });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${port}`;

    const a = path.join(dir, 'a.pdf');
    const b = path.join(dir, 'b.pdf');
    await createPdf(a, 2);
    await createPdf(b, 3);

    const form = new FormData();
    form.append('files', new Blob([await fs.promises.readFile(a)], { type: 'application/pdf' }), 'a.pdf');
    form.append('files', new Blob([await fs.promises.readFile(b)], { type: 'application/pdf' }), 'b.pdf');
    const uploadRes = await fetch(`${base}/api/upload`, { method: 'POST', headers: { 'X-Scyzoryk-Request': '1' }, body: form });
    const uploadData = await uploadRes.json();
    assert.equal(uploadRes.status, 200, JSON.stringify(uploadData));

    const printRes = await fetch(`${base}/api/print`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Scyzoryk-Request': '1' },
      body: JSON.stringify({ printerName: '__SAVE_AS_PDF__', mergeFiles: true, order: uploadData.queue.map(x => x.id) })
    });
    assert.equal(printRes.status, 200);

    let status = {};
    for (let i = 0; i < 50; i++) {
      status = await (await fetch(`${base}/api/status`)).json();
      if (!status.printing && (status.done || status.error)) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.equal(status.error, null, JSON.stringify(status));
    assert.equal(status.done, true);
    assert.ok(status.savedFolder, 'savedFolder powinien byc ustawiony po udanym zapisie');

    const savedFiles = await fs.promises.readdir(status.savedFolder);
    assert.equal(savedFiles.length, 1, 'dwa sasiadujace PDF-y z mergeFiles:true musza dac JEDEN plik wyjsciowy, tak jak przy druku');
    const merged = await PDFDocument.load(await fs.promises.readFile(path.join(status.savedFolder, savedFiles[0])));
    assert.equal(merged.getPageCount(), 5);

    const queueAfter = await (await fetch(`${base}/api/status`)).json();
    assert.equal(queueAfter.printing, false, 'kolejka i stan drukowania musza byc wyczyszczone po zapisie, tak samo jak po druku');
  });
}
