import fs from 'fs/promises';
import path from 'path';
import sanitize from 'sanitize-filename';
import pdfParse from 'pdf-parse';
import { getOutputRoot } from './debug.js';
import {
  expectedProductParts,
  extractSelectedProductFromText,
  normalizeProductToken,
  buildProductMismatchMessage
} from './automation/product.js';

export async function validatePdfProduct(pdfPath, result) {
  const { outdoorModel, indoorUnit } = expectedProductParts(result);
  if (!outdoorModel || !indoorUnit) return { ok: true, skipped: true };

  const buffer = await fs.readFile(pdfPath);
  const parsed = await pdfParse(buffer);
  const text = String(parsed?.text || '');

  // Bardzo ważne: w dalszych stronach raportu my-ecodan potrafi dołączać
  // katalogowe tabele innych rodzin urządzeń, np. PUZ-WZ / ERPT / EHPT.
  // Dlatego NIE wolno walidować całego tekstu PDF pod kątem zakazanych rodzin.
  // Źródłem prawdy jest wyłącznie pole na początku raportu: "Wybrany produkt".
  const selectedProduct = extractSelectedProductFromText(text);
  const selectedNorm = normalizeProductToken(selectedProduct);
  const outdoorNorm = normalizeProductToken(outdoorModel);
  const indoorNorm = normalizeProductToken(indoorUnit);

  const hasOutdoor = outdoorNorm && selectedNorm.includes(outdoorNorm);
  const hasIndoor = indoorNorm && selectedNorm.includes(indoorNorm);

  const forbidden = ['PUZWZ', 'ERPT', 'EHPT', 'ERPX'];
  const selectedHasForbiddenFamily = forbidden.some(token => selectedNorm.includes(token));

  if (!selectedProduct || !hasOutdoor || !hasIndoor || selectedHasForbiddenFamily) {
    throw new Error(buildProductMismatchMessage(text, result));
  }

  return {
    ok: true,
    expected: `${outdoorModel} + ${indoorUnit}`,
    found: selectedProduct,
    hasOutdoor,
    hasIndoor
  };
}

export async function quarantineInvalidPdf(pdfPath, reason = '', outputRoot = getOutputRoot()) {
  if (!pdfPath) return null;
  const invalidDir = path.join(outputRoot, 'debug', 'invalid-pdf');
  await fs.mkdir(invalidDir, { recursive: true }).catch(() => {});
  const base = sanitize(`${new Date().toISOString().replace(/[:.]/g, '-')}-${path.basename(pdfPath)}`);
  const target = path.join(invalidDir, base);
  // Gdy obie proby przeniesienia zawioda, NIE wolno zwrocic `target` jakby
  // kwarantanna sie udala - wolajacy dostalby sciezke nieistniejacego pliku,
  // a bledny PDF zostalby w folderze wyjsciowym (przy skipExisting uznany za
  // gotowy). Zwracamy wtedy null, a wolajacy musi to obsluzyc jawnie.
  let moved = false;
  try {
    await fs.rename(pdfPath, target);
    moved = true;
  } catch {
    try {
      await fs.copyFile(pdfPath, target);
      await fs.unlink(pdfPath).catch(() => {});
      moved = true;
    } catch {}
  }
  if (!moved) return null;
  if (reason) {
    await fs.writeFile(`${target}.txt`, reason, 'utf8').catch(() => {});
  }
  return target;
}
