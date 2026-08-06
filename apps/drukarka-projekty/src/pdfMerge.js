const fs = require("fs");
const path = require("path");
const { PDFDocument } = require("pdf-lib");

// Audyt rozdz. 10/11, P0/P1: scalenie sasiadujacych PDF-ow dzieje sie w
// buildQueueFromGroups, ZANIM uzytkownik na ekranie druku wybierze
// jednostronnie/dwustronnie ("sideMode" w /api/print jest nieznane w tym
// miejscu) - a domyslny wybor UI to dwustronnie. Bez pustej strony po kazdym
// nieparzystostronicowym pliku (poza ostatnim w danej grupie) pierwsza
// strona kolejnego dokumentu moglaby wyladowac na odwrocie poprzedniego -
// ryzyko pomieszania dokumentacji roznych adresow/klientow. Dlatego
// wstawiamy pusta strone BEZWARUNKOWO (nie tylko dla duplexu) - koszt to co
// najwyzej jeden dodatkowy pusty arkusz przy druku jednostronnym.
async function mergePdfs(filePaths, outputPath) {
  const merged = await PDFDocument.create();
  for (let i = 0; i < filePaths.length; i++) {
    const bytes = fs.readFileSync(filePaths[i]);
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pages = await merged.copyPages(src, src.getPageIndices());
    pages.forEach(p => merged.addPage(p));

    const isLast = i === filePaths.length - 1;
    if (!isLast && pages.length % 2 === 1) {
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
