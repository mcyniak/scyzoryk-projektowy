// Tworzy minimalny, poprawny jednostronicowy plik PDF - uzywane WYLACZNIE przez workflow
// testu czystej instalacji (.github/workflows/clean-install-test.yml) jako przykladowy
// plik wejsciowy dla smoke testow (Pieczatki PDF, Drukarka). Zero zaleznosci npm - dziala
// nawet zanim jakikolwiek node_modules zostanie zainstalowany.
//
// Uzycie: node scripts/ci/create-sample-pdf.js <sciezka-wyjsciowa.pdf>
const fs = require('fs');
const path = require('path');

const outPath = process.argv[2];
if (!outPath) {
  console.error('Uzycie: node create-sample-pdf.js <sciezka-wyjsciowa.pdf>');
  process.exit(1);
}

const objects = [
  '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n',
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n',
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<<>>>>endobj\n'
];

let body = '%PDF-1.4\n';
const offsets = [0];
for (const obj of objects) {
  offsets.push(Buffer.byteLength(body, 'latin1'));
  body += obj;
}
const xrefStart = Buffer.byteLength(body, 'latin1');

let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (let i = 1; i <= objects.length; i++) {
  xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
}
body += xref;
body += `trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF`;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, body, 'latin1');
console.log(`Utworzono przykladowy PDF: ${outPath} (${Buffer.byteLength(body, 'latin1')} B)`);
