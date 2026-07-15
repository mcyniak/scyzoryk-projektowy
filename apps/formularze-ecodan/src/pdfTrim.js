import fs from 'fs/promises';
import path from 'path';
import { PDFDocument } from 'pdf-lib';

export const ECODAN_MAX_PDF_PAGES = Number(process.env.ECODAN_MAX_PDF_PAGES || 3);

export async function keepFirstPdfPages(pdfPath, maxPages = ECODAN_MAX_PDF_PAGES) {
  const limit = Math.max(1, Math.floor(Number(maxPages || 3)));
  const bytes = await fs.readFile(pdfPath);
  const sourcePdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pageCount = sourcePdf.getPageCount();

  if (pageCount <= limit) {
    return { ok: true, trimmed: false, pageCount, keptPages: pageCount, pdfPath };
  }

  const outputPdf = await PDFDocument.create();
  const indexes = Array.from({ length: limit }, (_, index) => index);
  const copiedPages = await outputPdf.copyPages(sourcePdf, indexes);
  for (const page of copiedPages) outputPdf.addPage(page);

  const outputBytes = await outputPdf.save();
  const tempPath = `${pdfPath}.first-${limit}.tmp`;
  await fs.writeFile(tempPath, outputBytes);
  await fs.rename(tempPath, pdfPath).catch(async () => {
    await fs.copyFile(tempPath, pdfPath);
    await fs.unlink(tempPath).catch(() => {});
  });

  return { ok: true, trimmed: true, pageCount, keptPages: limit, pdfPath };
}
