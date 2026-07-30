const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PDFDocument } = require('../apps/formularze-ecodan/node_modules/pdf-lib');

async function createPdf(filePath, pageCount) {
  const document = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) document.addPage([300, 400]);
  await fsp.writeFile(filePath, await document.save());
}

test('Ecodan zachowuje najwyżej pierwsze trzy strony', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-ecodan-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const { keepFirstPdfPages } = await import('../apps/formularze-ecodan/src/pdfTrim.js');

  for (const inputPages of [1, 2, 3, 4, 5, 10]) {
    const filePath = path.join(dir, `${inputPages}.pdf`);
    await createPdf(filePath, inputPages);
    const result = await keepFirstPdfPages(filePath);
    const written = await PDFDocument.load(await fsp.readFile(filePath));
    assert.equal(written.getPageCount(), Math.min(inputPages, 3));
    assert.equal(result.keptPages, Math.min(inputPages, 3));
  }
  assert.deepEqual((await fsp.readdir(dir)).filter((name) => name.includes('.backup-')), []);
});

test('wynik pominiętego istniejącego raportu ujawnia przycięcie', async () => {
  const source = await fsp.readFile(path.join(__dirname, '..', 'apps', 'formularze-ecodan', 'src', 'jobs.js'), 'utf8');
  assert.match(source, /skippedExisting: true,\s*trimmedExisting: pdfTrim\.trimmed/);
});

test('indeks zadań i frontend obsługują restart oraz ostrzeżenie ścieżki', async () => {
  const jobsSource = await fsp.readFile(path.join(__dirname, '..', 'apps', 'formularze-ecodan', 'src', 'jobs.js'), 'utf8');
  const uiSource = await fsp.readFile(path.join(__dirname, '..', 'apps', 'formularze-ecodan', 'public', 'inline-1.js'), 'utf8');
  assert.match(jobsSource, /status: interrupted \? 'interrupted'/);
  assert.match(jobsSource, /interruptedReason: interrupted \? 'process-restarted'/);
  assert.match(jobsSource, /crypto\.randomUUID\(\)\}\.tmp/);
  assert.match(uiSource, /res\.status === 404/);
  assert.match(uiSource, /job\.status === 'interrupted'/);
  assert.match(uiSource, /job\.outputPathWarning/);
});
