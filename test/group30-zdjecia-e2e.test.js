// Zdjecia end-to-end z prawdziwym silnikiem: Kreator buduje wzor z galeria
// Zdjecia_pomontazowe -> Dokumenty seryjne wgrywaja Excel + folder zdjec
// (realistyczne nazwy folderow) -> podsumowanie dopasowania -> generowanie
// -> w kazdym DOCX sa dokladnie zdjecia z folderu SWOJEGO adresu.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const documentEngine = require('../lib/documentEngine');
const AdmZip = require('../apps/kreator-wzorow/node_modules/adm-zip');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
// Maly, prawdziwy PNG w jednym kolorze - kolor rozroznia zdjecia w wyniku.
function png(w, h, [r, g, b]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([r, g, b], y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function run(text, highlight) {
  const rPr = highlight ? `<w:rPr><w:highlight w:val="${highlight}"/></w:rPr>` : '';
  return `<w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r>`;
}
function fixtureDocx() {
  const body = [
    `<w:p>${run('Adres inwestycji: ')}${run('Kamion 5', 'yellow')}</w:p>`,
    `<w:p>${run('Dokumentacja fotograficzna:')}</w:p>`,
    `<w:p>${run('[ZDJĘCIA]', 'green')}</w:p>`,
    `<w:p>${run('Koniec.')}</w:p>`,
  ].join('');
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>', 'utf8'));
  zip.addFile('_rels/.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>', 'utf8'));
  zip.addFile('word/document.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`, 'utf8'));
  return zip.toBuffer();
}
async function fixtureXlsx(dir) {
  const ExcelJS = require('../apps/ocr-audytow/node_modules/exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Dane');
  ws.addRow(['LP', 'Adres', 'Imię i nazwisko']);
  ws.addRow([1, 'Kamion 5', 'Maria Wiśniewska']);
  ws.addRow([2, 'Wierzchlas 12', 'Jan Kowalski']);
  ws.addRow([3, 'Łążek 7', 'Zofia Żółkiewska']);
  ws.addRow([4, 'Kamion 15', 'Adam Nowak']);
  const file = path.join(dir, 'dane.xlsx');
  await wb.xlsx.writeFile(file);
  return fsp.readFile(file);
}

async function startApp(modulePath, t) {
  delete require.cache[require.resolve(modulePath)];
  const { app } = require(modulePath);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
const H = { 'X-Scyzoryk-Request': '1' };
function apiFor(base) {
  return async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: body ? { ...H, 'Content-Type': 'application/json' } : H, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json();
    assert.ok(res.ok && json.ok !== false, `${method} ${url}: ${JSON.stringify(json)}`);
    return json;
  };
}

const canRunEngine = process.platform === 'win32' && documentEngine.isEngineAvailable() && Boolean(documentEngine.resolveOnlyOfficeDir());

test('e2e zdjecia: Kreator (galeria) -> Dokumenty seryjne z folderem zdjec -> kazdy dokument ma zdjecia swojego adresu', { skip: !canRunEngine && 'brak silnika/x2t', timeout: 5 * 60 * 1000 }, async (t) => {
  const dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'scyzoryk-zdjecia-'));
  const previous = process.env.SCYZORYK_DATA_ROOT;
  process.env.SCYZORYK_DATA_ROOT = dataRoot;
  t.after(async () => {
    if (previous === undefined) delete process.env.SCYZORYK_DATA_ROOT; else process.env.SCYZORYK_DATA_ROOT = previous;
    await fsp.rm(dataRoot, { recursive: true, force: true }).catch(() => {});
  });
  const xlsx = await fixtureXlsx(dataRoot);

  // 1. Kreator: pole Adres + galeria zdjec.
  const kBase = await startApp('../apps/kreator-wzorow/server.js', t);
  const k = apiFor(kBase);
  const form = new FormData();
  form.append('template', new Blob([fixtureDocx()]), 'Dokumentacja zdjęciowa.docx');
  form.append('excel', new Blob([xlsx]), 'dane.xlsx');
  const up = await (await fetch(`${kBase}/api/jobs`, { method: 'POST', headers: H, body: form })).json();
  assert.ok(up.ok, JSON.stringify(up));
  const job = `/api/jobs/${up.jobId}`;
  const palette = (await k('POST', `${job}/scan-markings`, {})).markings;
  const scan = await k('POST', `${job}/scan`, { sheetName: 'Dane', selectedMarkings: palette.map(m => m.key) });
  const adres = scan.candidates.find(c => /Kamion 5/.test(c.text));
  const zdj = scan.candidates.find(c => /ZDJ/.test(c.text));
  assert.ok(adres && zdj, JSON.stringify(scan.candidates.map(c => c.text)));
  let state = (await k('GET', job)).job;
  await k('PUT', `${job}/config`, { ...state.draft, addressColumn: 'Adres', preferredSheet: 'Dane' });
  await k('POST', `${job}/fields`, { candidateId: adres.id, label: 'Adres', valueSpec: { type: 'column', column: 'Adres' } });
  await k('POST', `${job}/candidates/${zdj.id}/photo-gallery`, {});
  const build = await k('POST', `${job}/build`, { sheetName: 'Dane', templateName: 'Dokumentacja zdjęciowa' });
  const templateBuf = Buffer.from(await (await fetch(`${kBase}${job}/download/template`)).arrayBuffer());
  assert.match(new AdmZip(templateBuf).readAsText('word/document.xml'), /MERGEFIELD\s+Zdjecia_pomontazowe/);
  assert.ok(build.downloadName);

  // 2. Dokumenty seryjne.
  const dBase = await startApp('../apps/dokumenty-seryjne/server.js', t);
  const d = apiFor(dBase);
  const f2 = new FormData();
  f2.append('templates', new Blob([templateBuf]), build.downloadName);
  f2.append('excel', new Blob([xlsx]), 'dane.xlsx');
  const up2 = await (await fetch(`${dBase}/api/upload`, { method: 'POST', headers: H, body: f2 })).json();
  assert.ok(up2.ok, JSON.stringify(up2));
  assert.ok(up2.smartTemplate, 'rozpoznany jako wzor z Kreatora');

  const RED = [220, 30, 30], GREEN = [30, 180, 30], BLUE = [30, 30, 220], GRAY = [128, 128, 128];
  const photos = [
    ['Zdjęcia/Kamion 5/IMG_10.png', png(40, 30, RED)],
    ['Zdjęcia/Kamion 5/IMG_2.png', png(30, 40, RED)],
    ['Zdjęcia/2.Wierzchlas 12/1.png', png(40, 30, GREEN)],     // prefiks LP jak w "Tworzeniu folderow"
    ['Zdjęcia/ŁĄŻEK 7/a.png', png(40, 30, BLUE)],              // wielkosc liter / diakrytyki
    ['Zdjęcia/Stary folder/x.png', png(20, 20, GRAY)],         // folder bez adresu w Excelu
  ];
  // Dwie paczki (jak frontend przy duzym folderze): druga z ?append=1.
  for (const [i, batch] of [photos.slice(0, 3), photos.slice(3)].entries()) {
    const fd = new FormData();
    for (const [rel, buf] of batch) fd.append('images', new Blob([buf]), path.basename(rel));
    fd.append('imagePaths', JSON.stringify(batch.map(([rel]) => encodeURIComponent(rel))));
    const img = await (await fetch(`${dBase}/api/images/${up2.jobId}${i ? '?append=1' : ''}`, { method: 'POST', headers: H, body: fd })).json();
    assert.ok(img.ok, JSON.stringify(img));
    assert.equal(img.count, i ? photos.length : 3);
  }

  let summary = await d('POST', `/api/images/${up2.jobId}/summary`, { sheetName: 'Dane' });
  assert.equal(summary.hasGalleryField, true);
  assert.equal(summary.addressColumn, 'Adres');
  const byAddress = Object.fromEntries(summary.rows.map(r => [r.address, r]));
  assert.equal(byAddress['Kamion 5'].photoCount, 2);
  assert.equal(byAddress['Kamion 5'].status, 'ok');
  assert.equal(byAddress['Wierzchlas 12'].photoCount, 1, 'folder "2.Wierzchlas 12" (LP.adres) dopasowany');
  assert.equal(byAddress['Wierzchlas 12'].status, 'check');
  assert.equal(byAddress['Łążek 7'].photoCount, 1);
  assert.equal(byAddress['Kamion 15'].photoCount, 0, '"Kamion 5" nie moze trafic do "Kamion 15"');
  const stary = summary.folders.find(f => f.folder === 'Stary folder');
  assert.equal(stary.status, 'unassigned', 'folder bez adresu jest pokazany');

  // Reczne przypisanie folderu bez pary.
  await d('POST', `/api/images/${up2.jobId}/assign`, { folder: 'Stary folder', address: 'Kamion 15' });
  summary = await d('POST', `/api/images/${up2.jobId}/summary`, { sheetName: 'Dane' });
  assert.equal(summary.rows.find(r => r.address === 'Kamion 15').photoCount, 1);
  assert.equal(summary.counts.unassignedFolders, 0);

  await d('POST', `/api/generate/${up2.jobId}`, { sheetName: 'Dane', saveWord: true });
  let jobState;
  for (let i = 0; i < 240; i++) {
    jobState = await d('GET', `/api/job/${up2.jobId}`);
    if (!['queued', 'running'].includes(jobState.status)) break;
    await new Promise(r => setTimeout(r, 500));
  }
  assert.equal(jobState.status, 'done', JSON.stringify(jobState.result));
  const docs = {};
  for (const item of jobState.result.created.filter(c => /\.docx$/i.test(c.file))) {
    const zip = new AdmZip(item.path);
    const xml = zip.readAsText('word/document.xml');
    const pdf = await fsp.readFile(item.path.replace(/\.docx$/i, '.pdf'));
    docs[item.address] = {
      media: zip.getEntries().filter(e => /(^|\/)media\//.test(e.entryName)).length,
      extents: [...xml.matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"/g)].map(m => Number(m[1]) > Number(m[2]) ? 'poziome' : 'pionowe'),
      pdfBytes: pdf.length,
      text: xml.replace(/<[^>]+>/g, ''),
    };
  }
  if (process.env.SCYZORYK_E2E_KEEP) {
    await fsp.writeFile(path.join(process.env.SCYZORYK_E2E_KEEP, 'wzor_seryjny.docx'), templateBuf);
    await fsp.writeFile(path.join(process.env.SCYZORYK_E2E_KEEP, 'dane.xlsx'), xlsx);
    for (const item of jobState.result.created) await fsp.copyFile(item.path, path.join(process.env.SCYZORYK_E2E_KEEP, item.file));
  }
  t.diagnostic(JSON.stringify(Object.fromEntries(Object.entries(docs).map(([k, v]) => [k, { media: v.media, extents: v.extents }]))));
  assert.equal(docs['Kamion 5'].media, 2);
  assert.deepEqual(docs['Kamion 5'].extents, ['pionowe', 'poziome'], 'kolejnosc naturalna: IMG_2 (pionowe) przed IMG_10 (poziome)');
  assert.equal(docs['Wierzchlas 12'].media, 1);
  assert.equal(docs['Łążek 7'].media, 1);
  assert.equal(docs['Kamion 15'].media, 1, 'folder przypisany recznie');
  for (const [address, doc] of Object.entries(docs)) {
    assert.match(doc.text, new RegExp(`Adres inwestycji: ${address}`));
    assert.doesNotMatch(doc.text, /\[ZDJĘCIA\]|Zdjecia_pomontazowe/, 'pole galerii nie zostaje w dokumencie');
    assert.ok(doc.pdfBytes > 1000, `PDF dla ${address}`);
  }
});
