import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
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
  const tempPath = `${pdfPath}.first-${limit}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempPath, outputBytes);
  const verifyDoc = await PDFDocument.load(await fs.readFile(tempPath), { ignoreEncryption: true });
  const actualPageCount = verifyDoc.getPageCount();
  const expectedPageCount = Math.min(limit, pageCount);
  if (actualPageCount !== expectedPageCount) {
    await fs.unlink(tempPath).catch(() => {});
    throw new Error(`Przyciety PDF ma ${actualPageCount} stron, oczekiwano ${expectedPageCount}.`);
  }

  const backupPath = `${pdfPath}.backup-${Date.now()}`;
  let backupCreated = false;
  try {
    await fs.copyFile(pdfPath, backupPath);
    backupCreated = true;
    await fs.rename(tempPath, pdfPath).catch(async () => {
      await fs.copyFile(tempPath, pdfPath);
    });
    await fs.unlink(backupPath).catch(() => {});
  } catch (error) {
    if (backupCreated) {
      await fs.copyFile(backupPath, pdfPath).catch(() => {});
      await fs.unlink(backupPath).catch(() => {});
    }
    throw error;
  } finally {
    await fs.unlink(tempPath).catch(() => {});
  }

  return { ok: true, trimmed: actualPageCount < pageCount, pageCount: actualPageCount, keptPages: actualPageCount, pdfPath };
}
