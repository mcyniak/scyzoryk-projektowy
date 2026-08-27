'use strict';

// Testy imageMatching.js w modelu "folder adresu z dowolna liczba zdjec"
// (plan PLAN_dokumenty_seryjne_tylko_zdjecia.md, sect. 5/10/21/27).

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const {
  normalizeAddress,
  isGalleryFieldName,
  buildManifestFromDisk,
  findPhotosForAddress,
  detectImageMergeFields,
  summarizeImages,
} = require('./src/imageMatching.js');

function makeManifest(files) {
  return { root: '/tmp/images', files };
}

function photo(folder, name) {
  return { relativePath: folder + '/' + name, addressFolder: folder, storedPath: '/tmp/' + folder + '/' + name, originalName: name };
}

// ---- Normalizacja adresow (plan sect. 5) -----------------------------------

// "Łaszew 5A" == "laszew 5a" == " LASZEW   5A "
assert.strictEqual(normalizeAddress('Łaszew 5A'), normalizeAddress('laszew 5a'));
assert.strictEqual(normalizeAddress('Łaszew 5A'), normalizeAddress(' ŁASZEW   5A '));
// "Łaszew 5" != "Łaszew 5A"
assert.notStrictEqual(normalizeAddress('Łaszew 5'), normalizeAddress('Łaszew 5A'));
assert.strictEqual(normalizeAddress('Kraszkowice 14'), 'kraszkowice 14');

// ---- Rozpoznawanie pola galerii (plan sect. 11) ----------------------------

assert.ok(isGalleryFieldName('Zdjecia_pomontazowe'));
assert.ok(isGalleryFieldName('Zdjęcia pomontażowe')); // diakrytyki/spacje - ten sam klucz
assert.ok(!isGalleryFieldName('Adres'));
assert.ok(!isGalleryFieldName('Zdjecie_1'));

// ---- findPhotosForAddress --------------------------------------------------

// Folder z wieloma zdjeciami -> wszystkie, posortowane naturalnie 1,2,10
const multi = findPhotosForAddress('Kraszkowice 14', makeManifest([
  photo('Kraszkowice 14', '10.jpg'),
  photo('Kraszkowice 14', '1.jpg'),
  photo('Kraszkowice 14', '2.jpg'),
]));
assert.strictEqual(multi.status, 'ok');
assert.deepStrictEqual(multi.photos.map(p => p.originalName), ['1.jpg', '2.jpg', '10.jpg']);

// IMG_xxx tez zachowuje kolejnosc
const imgNames = findPhotosForAddress('Wierzchlas 23', makeManifest([
  photo('Wierzchlas 23', 'IMG_1003.jpg'),
  photo('Wierzchlas 23', 'IMG_1001.jpg'),
  photo('Wierzchlas 23', 'IMG_1002.jpg'),
]));
assert.deepStrictEqual(imgNames.photos.map(p => p.originalName), ['IMG_1001.jpg', 'IMG_1002.jpg', 'IMG_1003.jpg']);

// Brak folderu adresu -> ok z zerem zdjec (plan sect. 2)
const missingFolder = findPhotosForAddress('Laszew 5A', makeManifest([
  photo('Inny Adres 1', 'x.jpg'),
]));
assert.strictEqual(missingFolder.status, 'ok');
assert.strictEqual(missingFolder.photos.length, 0);

// Pusty folder adresu -> ok z zerem zdjec (plan sect. 2)
const emptyFolder = findPhotosForAddress('Laszew 5A', makeManifest([]));
assert.strictEqual(emptyFolder.status, 'ok');
assert.strictEqual(emptyFolder.photos.length, 0);

// Normalizacja case/odstepow: "laszew 5a" pasuje do folderu "Laszew 5A"
const caseInsensitive = findPhotosForAddress('laszew  5a', makeManifest([
  photo('Laszew 5A', 'IMG_0001.jpg'),
]));
assert.strictEqual(caseInsensitive.status, 'ok');
assert.strictEqual(caseInsensitive.photos.length, 1);

// Dwa rozne fizyczne foldery o tym samym znormalizowanym adresie -> ambiguous,
// zero zdjec (nigdy nie uzywamy zdjec innego adresu; plan sect. 21)
const ambiguous = findPhotosForAddress('Laszew 5A', makeManifest([
  photo('Laszew 5A', 'a.jpg'),
  photo('Łaszew 5A', 'b.jpg'),
]));
assert.strictEqual(ambiguous.status, 'ambiguous');
assert.strictEqual(ambiguous.photos.length, 0);
assert.strictEqual(ambiguous.folders.length, 2);

// Rozne adresy NIE kradna sobie zdjec ("Laszew 5" vs "Laszew 5A")
const notOther = findPhotosForAddress('Laszew 5', makeManifest([
  photo('Laszew 5A', 'a.jpg'),
]));
assert.strictEqual(notOther.status, 'ok');
assert.strictEqual(notOther.photos.length, 0);

// Manifest z dysku (struktura root/adres/zdjecie)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'img-match-'));
try {
  const addrDir = path.join(tmp, 'Kraszkowice 14');
  fs.mkdirSync(addrDir, { recursive: true });
  fs.writeFileSync(path.join(addrDir, '1.jpg'), Buffer.from([0xFF, 0xD8, 0xFF]));
  fs.writeFileSync(path.join(addrDir, '2.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47]));
  fs.writeFileSync(path.join(addrDir, 'notatka.txt'), 'ignorowany');
  const diskManifest = buildManifestFromDisk(tmp);
  assert.strictEqual(diskManifest.files.length, 2);
  const resolved = findPhotosForAddress('Kraszkowice 14', diskManifest);
  assert.strictEqual(resolved.status, 'ok');
  assert.deepStrictEqual(resolved.photos.map(p => p.originalName), ['1.jpg', '2.png']);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---- Wykrywanie pola galerii w DOCX (tylko Zdjecia_pomontazowe) ------------

const docxTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-'));
try {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:r><w:instrText xml:space="preserve"> MERGEFIELD Zdjecia_pomontazowe </w:instrText></w:r>
    </w:p>
    <w:p>
      <w:r><w:instrText xml:space="preserve"> MERGEFIELD Zdjecie_1 </w:instrText></w:r>
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
  // Stare pole per-pozycyjne (Zdjecie_1) NIE jest galeria (plan sect. 11).
  assert.deepStrictEqual(detectImageMergeFields(docxPath), ['Zdjecia_pomontazowe']);
} finally {
  fs.rmSync(docxTmp, { recursive: true, force: true });
}

// Szablon bez pola galerii -> pusta lista (multi-template, plan sect. 23)
const docxTmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-'));
try {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  const documentXml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:instrText xml:space="preserve"> MERGEFIELD Adres </w:instrText></w:r></w:p></w:body></w:document>`;
  zip.addFile('word/document.xml', Buffer.from(documentXml, 'utf8'));
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>', 'utf8'));
  const docxPath = path.join(docxTmp2, 'bioz.docx');
  zip.writeZip(docxPath);
  assert.deepStrictEqual(detectImageMergeFields(docxPath), []);
} finally {
  fs.rmSync(docxTmp2, { recursive: true, force: true });
}

// ---- summarizeImages: liczniki informacyjne, bez statusu bledu (sect. 20) --

const summaryManifest = makeManifest([
  photo('Adres A', '1.jpg'),
  photo('Adres A', '2.jpg'),
  photo('Adres A', '3.jpg'),
  // "Adres B" - folder istnieje ale pusty = brak wpisow
]);
const summary = summarizeImages(['Adres A', 'Adres B', 'Adres C'], summaryManifest);
assert.strictEqual(summary.total, 3);
assert.strictEqual(summary.withImages, 1);   // Adres A: 3 zdjecia
assert.strictEqual(summary.withoutImages, 2); // B i C: zero zdjec, ale OK
assert.strictEqual(summary.ambiguous, 0);

const ambiguousSummary = summarizeImages(['Łaszew 5A'], makeManifest([
  photo('Laszew 5A', 'a.jpg'),
  photo('Łaszew 5A', 'b.jpg'),
]));
assert.strictEqual(ambiguousSummary.withImages, 0);
assert.strictEqual(ambiguousSummary.ambiguous, 1);
assert.strictEqual(ambiguousSummary.rows[0].status, 'ambiguous');

console.log('Wszystkie testy imageMatching.js przeszły.');
