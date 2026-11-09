// Druk 2026-11-09: przycisk "Przerwij drukowanie" (apps/drukarka,
// apps/drukarka-projekty) oraz jawny format papieru dla Sumatry/Ghostscripta
// (bizhub C258: "Scyzoryk pokazuje wyslano, a z drukarki nic nie wychodzi").
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { spawnSync } = require('child_process');

// Izolacja danych (patrz CLAUDE.md) - zanim cokolwiek z lib/ sie zaladuje.
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scyzoryk-group34-'));
process.env.SCYZORYK_DATA_ROOT = dataRoot;
test.after(() => { try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch (_) {} });

const printing = require('../lib/printing');
const { runPowerShell } = require('../lib/hardening');

const root = path.resolve(__dirname, '..');
const drukarkaDir = path.join(root, 'apps', 'drukarka');
const hasPdfLib = fs.existsSync(path.join(drukarkaDir, 'node_modules', 'pdf-lib'));

test('paperKindForPageSize: Letter, Legal, A5 i "prawie A4" ida na A4; A3 i wieksze na A3', () => {
  const cases = [
    [[595.28, 841.89], 'A4'],
    [[841.89, 595.28], 'A4'], // A4 poziomo
    [[612, 792], 'A4'], // Letter - na bizhubie czekal na papier Letter
    [[612, 1008], 'A4'], // Legal
    [[419.53, 595.28], 'A4'], // A5
    [[594, 842.5], 'A4'], // skan "prawie A4" - Sumatra dawala tu format niestandardowy
    [[841.89, 1190.55], 'A3'],
    [[1190.55, 841.89], 'A3'], // A3 poziomo
    [[1190.55, 1683.78], 'A3'], // A2 - zmniejszane do A3
    [[0, 0], ''],
  ];
  for (const [[w, h], expected] of cases) {
    assert.equal(printing.paperKindForPageSize(w, h), expected, `${w}x${h}`);
  }
});

test('detectPrintPaper: czyta pierwsza strone prawdziwego PDF-a (pdf-lib z katalogu aplikacji)', { skip: !hasPdfLib && 'brak node_modules w apps/drukarka' }, async () => {
  const { PDFDocument } = require(path.join(drukarkaDir, 'node_modules', 'pdf-lib'));
  const dir = fs.mkdtempSync(path.join(dataRoot, 'pdf-'));
  async function makePdf(name, sizes) {
    const doc = await PDFDocument.create();
    for (const size of sizes) doc.addPage(size);
    const file = path.join(dir, name);
    fs.writeFileSync(file, await doc.save());
    return file;
  }
  const letter = await makePdf('letter.pdf', [[612, 792], [841.89, 1190.55]]);
  const a3 = await makePdf('a3.pdf', [[1190.55, 841.89]]);

  assert.equal(await printing.detectPrintPaper(letter, { cwd: drukarkaDir, paperMode: 'auto' }), 'A4', 'decyduje PIERWSZA strona, jak w Sumatrze');
  assert.equal(await printing.detectPrintPaper(a3, { cwd: drukarkaDir, paperMode: 'auto' }), 'A3');
  assert.equal(await printing.detectPrintPaper(a3, { cwd: drukarkaDir, paperMode: 'off' }), '', 'SCYZORYK_PRINT_PAPER=off przywraca stare zachowanie');
  assert.equal(await printing.detectPrintPaper(a3, { cwd: drukarkaDir, paperMode: 'a4' }), 'A4', 'SCYZORYK_PRINT_PAPER=A4 wymusza A4');

  const broken = path.join(dir, 'zepsuty.pdf');
  fs.writeFileSync(broken, '%PDF-1.7 to nie jest PDF');
  assert.equal(await printing.detectPrintPaper(broken, { cwd: drukarkaDir, paperMode: 'auto' }), '', 'nieczytelny PDF nie blokuje druku');
  assert.equal(await printing.detectPrintPaper(path.join(dir, 'plik.docx'), { cwd: drukarkaDir, paperMode: 'auto' }), '');
});

test('wait z sygnalem: przerwanie konczy odstep miedzy plikami od razu bledem PRINT_CANCELLED', async () => {
  const controller = new AbortController();
  const started = Date.now();
  const pending = printing.wait(60000, controller.signal);
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, err => printing.isPrintCancelled(err));
  assert.ok(Date.now() - started < 5000);
  await assert.rejects(printing.wait(10, controller.signal), err => err.code === 'PRINT_CANCELLED', 'juz przerwany sygnal');
  await printing.wait(5); // bez sygnalu - stare zachowanie
});

test('createPrintRun: usuwa z kolejki tylko zadania, ktorych nie bylo przed seria, i tylko tego uzytkownika', async () => {
  const commands = [];
  const runPowerShellFake = async (scriptPath, args) => {
    commands.push(args[1]);
    if (commands.length === 1) return { stdout: '{"printerName":"Sekretariat","jobIds":[3,7]}\r\n' };
    return { stdout: '["oferta.pdf","umowa.pdf"]\r\n' };
  };
  const run = printing.createPrintRun("Drukarka 'Sekretariat'", { runPowerShell: runPowerShellFake, settleMs: 0 });
  assert.equal(run.cancelled, false);
  run.throwIfCancelled();

  const snapshot = await run.snapshot();
  assert.deepEqual(snapshot, { printerName: 'Sekretariat', jobIds: [3, 7] });
  assert.match(commands[0], /'Drukarka ''Sekretariat'''/, 'apostrof w nazwie drukarki escapowany dla PowerShella');

  run.cancel();
  assert.equal(run.cancelled, true);
  assert.equal(run.signal.aborted, true);
  assert.throws(() => run.throwIfCancelled(), err => err.code === 'PRINT_CANCELLED');

  const cleanup = await run.removeQueuedJobs();
  assert.deepEqual(cleanup, { ok: true, removed: ['oferta.pdf', 'umowa.pdf'] });
  assert.match(commands[1], /\$before = @\(3,7\)/);
  assert.match(commands[1], /\$job\.UserName -ne \$env:USERNAME/);
  assert.match(commands[1], /Remove-PrintJob/);
  assert.match(commands[1], /Get-PrintJob -PrinterName 'Sekretariat'/, 'usuwa z drukarki rozwiazanej przy zdjeciu kolejki');
});

test('createPrintRun: kolejka nieczytelna przy starcie -> po przerwaniu nic nie jest usuwane na slepo', async () => {
  let calls = 0;
  const run = printing.createPrintRun('', {
    runPowerShell: async () => { calls++; throw new Error('Get-PrintJob niedostepne'); },
    settleMs: 0
  });
  assert.equal(await run.snapshot(), null);
  run.cancel();
  assert.deepEqual(await run.removeQueuedJobs(), { ok: false, removed: [] });
  assert.equal(calls, 1, 'bez zdjecia kolejki nie ma drugiego wywolania (Remove-PrintJob)');
});

test('describeCancelledRun: komunikat mowi ile wyslano i co usunieto z kolejki', () => {
  assert.match(printing.describeCancelledRun(2, 5, { ok: true, removed: ['a', 'b'] }), /wysłano 2 z 5.*Usunięto.*: 2\./);
  assert.match(printing.describeCancelledRun(0, 3, { ok: true, removed: [] }), /nie było już zadań/);
  assert.match(printing.describeCancelledRun(1, 3, { ok: false, removed: [] }), /anuluj to w kolejce Windows/);
});

test('runPowerShell z sygnalem: przerwanie zabija cale drzewo procesow (jak Sumatra uruchomiona przez print-file.ps1)', { skip: process.platform !== 'win32' && 'tylko Windows' }, async () => {
  const controller = new AbortController();
  let grandchildPid = null;
  const script = "$p = Start-Process -FilePath ping.exe -ArgumentList '-n','120','127.0.0.1' -WindowStyle Hidden -PassThru; Write-Output ('PID=' + $p.Id); Start-Sleep -Seconds 120";
  const pending = runPowerShell(null, ['-Command', script], {
    timeoutMs: 60000,
    signal: controller.signal,
    onStdout: chunk => {
      const m = /PID=(\d+)/.exec(chunk);
      if (m && !grandchildPid) { grandchildPid = Number(m[1]); controller.abort(); }
    }
  });
  await assert.rejects(pending, err => err.code === 'ABORTED');
  assert.ok(grandchildPid, 'skrypt nie wypisal PID-u procesu potomnego');

  let alive = true;
  for (let i = 0; i < 50 && alive; i++) {
    const out = spawnSync('tasklist.exe', ['/FI', `PID eq ${grandchildPid}`, '/NH'], { encoding: 'utf8', windowsHide: true }).stdout || '';
    alive = out.includes(String(grandchildPid));
    if (alive) await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (alive) spawnSync('taskkill.exe', ['/PID', String(grandchildPid), '/F'], { windowsHide: true });
  assert.equal(alive, false, 'proces wnuk (ping.exe) przezyl przerwanie - child.kill() bez /T');

  await assert.rejects(runPowerShell(null, ['-Command', 'Write-Output 1'], { signal: controller.signal }), err => err.code === 'ABORTED', 'juz przerwany sygnal nie startuje PowerShella');
});

test('print-file.ps1 / PrintEngine.psm1: format papieru przekazywany obu silnikom', () => {
  const script = fs.readFileSync(path.join(root, 'lib', 'printing', 'print-file.ps1'), 'utf8');
  const engine = fs.readFileSync(path.join(root, 'lib', 'printing', 'PrintEngine.psm1'), 'utf8');
  assert.match(script, /\[ValidateSet\("", "A4", "A3"\)\]\[string\]\$PaperKind/);
  assert.match(script, /Invoke-PrintWithSumatra [^\n]*-paperKind \$PaperKind/);
  assert.match(script, /Invoke-PrintWithGhostscript [^\n]*-paperKind \$PaperKind/);
  assert.match(engine, /paperkind=\$\(\$script:DmPaperKinds\[\$paperKind\]\),shrink/);
  assert.match(engine, /-sPAPERSIZE=/);
  const printingJs = fs.readFileSync(path.join(root, 'lib', 'printing.js'), 'utf8');
  assert.match(printingJs, /psArgs\.push\('-PaperKind', paperKind\)/);
});

test('obie drukarki: endpoint /api/print/cancel, sygnal przerwania w petli i przycisk w UI', () => {
  for (const app of ['drukarka', 'drukarka-projekty']) {
    const server = fs.readFileSync(path.join(root, 'apps', app, 'server.js'), 'utf8');
    assert.match(server, /app\.post\("\/api\/print\/cancel"/, `${app}: brak endpointu`);
    assert.match(server, /printService\.createPrintRun\(printerName\)/, `${app}: brak serii z przerwaniem`);
    assert.match(server, /signal: printRun\.signal/, `${app}: printFileWindows bez sygnalu`);
    assert.match(server, /printService\.wait\(delaySeconds \* 1000, printRun\.signal\)/, `${app}: odstep miedzy plikami nieprzerywalny`);
    assert.match(server, /printRun\.removeQueuedJobs\(\)/, `${app}: przerwanie nie czysci kolejki drukarki`);
    assert.match(server, /cancellable: true/, `${app}: UI nie wie, kiedy pokazac przycisk`);

    const html = fs.readFileSync(path.join(root, 'apps', app, 'public', 'index.html'), 'utf8');
    assert.match(html, /id="cancelPrintBtn"[^>]*hidden/, `${app}: brak ukrytego przycisku`);
    const js = fs.readFileSync(path.join(root, 'apps', app, 'public', 'app.js'), 'utf8');
    assert.match(js, /\/api\/print\/cancel/);
    const css = fs.readFileSync(path.join(root, 'apps', app, 'public', 'app.css'), 'utf8');
    assert.match(css, /#cancelPrintBtn\[hidden\] \{ display: none; \}/, `${app}: .btn (inline-flex) przykrywa atrybut hidden`);
  }
});
