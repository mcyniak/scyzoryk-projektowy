const fs = require("fs");
const path = require("path");
const { PDFDocument } = require("pdf-lib");

// Audyt rozdz. 10, P0: przy druku dwustronnym scalenie plikow bez pustej
// strony miedzy nimi moglo wydrukowac pierwsza strone kolejnego dokumentu na
// odwrocie ostatniej strony poprzedniego - ryzyko pomieszania dokumentacji
// roznych klientow/adresow. Gdy padOddPagesExceptLast=true, po kazdym pliku
// (poza ostatnim w run), ktory ma nieparzysta liczbe stron, dodajemy jedna
// pusta strone o rozmiarze/orientacji jego ostatniej strony, zeby kolejny
// plik zawsze zaczynal sie na nowym arkuszu.
async function mergePdfs(filePaths, outputPath, options = {}) {
  const { padOddPagesExceptLast = false } = options;
  const merged = await PDFDocument.create();
  for (let i = 0; i < filePaths.length; i++) {
    const bytes = fs.readFileSync(filePaths[i]);
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pages = await merged.copyPages(src, src.getPageIndices());
    pages.forEach(p => merged.addPage(p));

    const isLast = i === filePaths.length - 1;
    if (padOddPagesExceptLast && !isLast && pages.length % 2 === 1) {
      const lastPage = pages[pages.length - 1];
      const { width, height } = lastPage.getSize();
      const blank = merged.addPage([width, height]);
      blank.setRotation(lastPage.getRotation());
    }
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, await merged.save());
  return outputPath;
}

module.exports = { mergePdfs };
