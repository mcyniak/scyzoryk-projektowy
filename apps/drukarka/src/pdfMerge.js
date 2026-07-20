const fs = require("fs");
const path = require("path");
const { PDFDocument } = require("pdf-lib");

async function mergePdfs(filePaths, outputPath) {
  const merged = await PDFDocument.create();
  for (const fp of filePaths) {
    const bytes = fs.readFileSync(fp);
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pages = await merged.copyPages(src, src.getPageIndices());
    pages.forEach(p => merged.addPage(p));
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, await merged.save());
  return outputPath;
}

module.exports = { mergePdfs };
