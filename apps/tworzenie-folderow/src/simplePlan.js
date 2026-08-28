// Drugi tryb tworzenie-folderow ("same foldery z adresow"): czysta logika -
// lista adresow z arkusza -> lista nazw folderow do utworzenia w wskazanym
// PUSTYM folderze docelowym. Zero I/O (ten sam wzorzec co folderPlan.js).
// Nazwy folderow = adres po sanityzacji safeSegment (dane z Excela = dane od
// klienta, moga zawierac "../" czy znaki zakazane w Windows), deduplikacja
// case-insensitive z zachowaniem kolejnosci pierwszego wystapienia.
const { safeSegment } = require('./folderPlan.js');

function buildSimpleFolderNames(addresses) {
  const folders = [];
  const seen = new Set();
  let skippedEmpty = 0;
  let duplicates = 0;

  for (const raw of (addresses || [])) {
    const text = String(raw == null ? '' : raw).trim();
    if (!text) { skippedEmpty++; continue; }
    const name = safeSegment(text);
    const key = name.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) { duplicates++; continue; }
    seen.add(key);
    folders.push(name);
  }

  return { folders, skippedEmpty, duplicates };
}

module.exports = { buildSimpleFolderNames };
