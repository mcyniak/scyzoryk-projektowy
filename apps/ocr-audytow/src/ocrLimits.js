function validateOcrBatchInspections(entries, options = {}) {
  const maxTotalPages = Number(options.maxTotalPages || 300);
  const maxPagesPerFile = Number(options.maxPagesPerFile || 60);
  let totalPages = 0;

  for (const entry of entries) {
    const pageCount = Number(entry.inspection?.pageCount || 0);
    if (pageCount > maxPagesPerFile) {
      throw new Error(`Plik ${entry.originalName} ma ${pageCount} stron. Limit jednego pliku to ${maxPagesPerFile} stron.`);
    }
    totalPages += pageCount;
  }

  if (totalPages > maxTotalPages) {
    throw new Error(`Wgrana paczka ma ${totalPages} stron. Limit paczki to ${maxTotalPages} stron.`);
  }
  return { totalPages };
}

module.exports = { validateOcrBatchInspections };
