'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const {
  normalizeAddress,
  buildManifestFromDisk,
  resolveImagesForAddress,
  detectImageMergeFields,
  summarizeImages,
} = require('./src/imageMatching.js');

function makeManifest(files) {
  return { root: '/tmp/images', files };
}

// Normalizacja adresów
assert.strictEqual(normalizeAddress('Kraszkowice 14'), 'kraszkowice 14');
assert.strictEqual(normalizeAddress('Krążkowice 14A'), 'krazkowice 14a');
assert.strictEqual(normalizeAddress('  Działka 1/2 '), 'dzialka 1 2');

// Direct match po nazwie pola
const directManifest = makeManifest([
  { relativePath: 'A/1.jpg', addressFolder: 'A', storedPath: '/tmp/A/1.jpg', originalName: '1.jpg' },
  { relativePath: 'A/Zdjecie_2.png', addressFolder: 'A', storedPath: '/tmp/A/Zdjecie_2.png', originalName: 'Zdjecie_2.png' },
]);
const direct = resolveImagesForAddress('A', ['Zdjecie_1', 'Zdjecie_2'], directManifest);
assert.strictEqual(direct.status, 'complete');
assert.strictEqual(direct.matches.Zdjecie_1.originalName, '1.jpg');
assert.strictEqual(direct.matches.Zdjecie_2.originalName, 'Zdjecie_2.png');

// Count-based fallback gdy brak nazwanych plików
const countManifest = makeManifest([
  { relativePath: 'A/foo.jpg', addressFolder: 'A', storedPath: '/tmp/A/foo.jpg', originalName: 'foo.jpg' },
  { relativePath: 'A/bar.png', addressFolder: 'A', storedPath: '/tmp/A/bar.png', originalName: 'bar.png' },
]);
const count = resolveImagesForAddress('A', ['Zdjecie_1', 'Zdjecie_2'], countManifest);
assert.strictEqual(count.status, 'complete');
assert.ok(count.matches.Zdjecie_1);
assert.ok(count.matches.Zdjecie_2);

// Brak zdjęć
const missing = resolveImagesForAddress('A', ['Zdjecie_1'], makeManifest([]));
assert.strictEqual(missing.status, 'missing');

// Za dużo plików bez dopasowania
const ambiguous = resolveImagesForAddress('A', ['Zdjecie_1'], makeManifest([
  { relativePath: 'A/a.jpg', addressFolder: 'A', storedPath: '/tmp/A/a.jpg', originalName: 'a.jpg' },
  { relativePath: 'A/b.jpg', addressFolder: 'A', storedPath: '/tmp/A/b.jpg', originalName: 'b.jpg' },
]));
assert.strictEqual(ambiguous.status, 'ambiguous');

// Brak pól obrazkowych i brak plików = complete
const none = resolveImagesForAddress('A', [], makeManifest([]));
assert.strictEqual(none.status, 'complete');

// Manifest z dysku
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'img-match-'));
try {
  const addrDir = path.join(tmp, 'Kraszkowice 14');
  fs.mkdirSync(addrDir, { recursive: true });
  fs.writeFileSync(path.join(addrDir, '1.jpg'), Buffer.from([0xFF, 0xD8, 0xFF]));
  fs.writeFileSync(path.join(addrDir, '2.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47]));
  const diskManifest = buildManifestFromDisk(tmp);
  assert.strictEqual(diskManifest.files.length, 2);
  const diskResolved = resolveImagesForAddress('Kraszkowice 14', ['Zdjecie_1', 'Zdjecie_2'], diskManifest);
  assert.strictEqual(diskResolved.status, 'complete');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// Wykrywanie pól obrazkowych w DOCX
const docxTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-'));
try {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:r><w:instrText xml:space="preserve"> MERGEFIELD Zdjecie_1 </w:instrText></w:r>
    </w:p>
    <w:p>
      <w:r><w:instrText xml:space="preserve"> MERGEFIELD Zdjecie_Fasada </w:instrText></w:r>
    </w:p>
    <w:p>
      <w:r><w:instrText xml:space="preserve"> MERGEFIELD Adres </w:instrText></w:r>
    </w:p>
  </w:body>
</w:document>`;
  zip.addFile('word/document.xml', Buffer.from(documentXml, 'utf8'));
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>', 'utf8'));
  const docxPath = path.join(docxTmp, 'template.docx');
  zip.writeZip(docxPath);
  const fields = detectImageMergeFields(docxPath);
  assert.deepStrictEqual(fields.sort(), ['Zdjecie_1', 'Zdjecie_Fasada']);
} finally {
  fs.rmSync(docxTmp, { recursive: true, force: true });
}

// summarizeImages
const summaryManifest = makeManifest([
  { relativePath: 'A/1.jpg', addressFolder: 'A', storedPath: '/tmp/A/1.jpg', originalName: '1.jpg' },
  { relativePath: 'B/1.jpg', addressFolder: 'B', storedPath: '/tmp/B/1.jpg', originalName: '1.jpg' },
]);
const summary = summarizeImages(['A', 'B', 'C'], ['Zdjecie_1'], summaryManifest);
assert.strictEqual(summary.status, 'missing');
assert.strictEqual(summary.complete, 2);
assert.strictEqual(summary.missing, 1);

console.log('Wszystkie testy imageMatching.js przeszły.');
