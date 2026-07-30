function validateOcrBatchInspections(entries, options = {}) {
  const maxTotalPages = Number(options.maxTotalPages || 300);
  const maxPagesPerFile = Number(options.maxPagesPerFile || 60);
  let totalPages = 0;
  let totalOcrPages = 0;

  for (const entry of entries) {
    const pageCount = Number(entry.inspection?.pageCount || 0);
    const ocrPages = (entry.inspection?.pages || []).filter((page) => !page.hasTextLayer).length;
    if (pageCount > maxPagesPerFile) {
      throw new Error(`Plik ${entry.originalName} ma ${pageCount} stron. Limit jednego pliku to ${maxPagesPerFile} stron.`);
    }
    totalPages += pageCount;
    totalOcrPages += ocrPages;
  }

  if (totalPages > maxTotalPages) {
    throw new Error(`Wgrana paczka ma ${totalPages} stron (${totalOcrPages} wymagajacych OCR). Limit paczki to ${maxTotalPages} stron.`);
  }
  return { totalPages, totalOcrPages };
}

module.exports = { validateOcrBatchInspections };
