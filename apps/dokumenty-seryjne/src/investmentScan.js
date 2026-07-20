const fs = require('fs');
const path = require('path');

// Widziane w praktyce nazwy folderow ze wzorami: "wzor", "wzory", "Wzory
// dokumentacji projektowej Pompy ciepla" - zawsze zawieraja "wz[oó]r" jako
// czesc slowa.
const WZORY_FOLDER_RE = /wz[oó]r/i;
const MAX_DEPTH = 6;
const MAX_ENTRIES_TO_DESCEND = 2000;

// Rekurencyjnie znajduje foldery ze wzorami pod danym korzeniem inwestycji.
// Moze byc ich wiecej niz jeden (np. osobno dla PC i dla Kolektorow) - user
// wtedy wybiera, ktorego chce uzyc.
function findWzoryFolders(investmentRoot, depth = 0) {
  if (depth > MAX_DEPTH) return [];
  let entries;
  try {
    entries = fs.readdirSync(investmentRoot, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  if (entries.length > MAX_ENTRIES_TO_DESCEND) return [];

  const found = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(investmentRoot, e.name);
    if (WZORY_FOLDER_RE.test(e.name)) {
      found.push(full);
      continue; // nie szukamy wzorow wewnatrz juz znalezionego folderu wzorow
    }
    found.push(...findWzoryFolders(full, depth + 1));
  }
  return found;
}

// Buduje liste plikow .docx z folderu wzorow DOKLADNIE w tym samym ksztalcie
// {path, originalName, relFolder}, jaki dzis produkuje wgranie folderu przez
// przegladarke (webkitdirectory) - relFolder pusty dla plikow lezacych wprost
// w folderze wzorow (Kolektory - wariant w sufiksie nazwy pliku), relFolder =
// nazwa bezposredniego podfolderu dla plikow w podfolderach (PC - wariant to
// nazwa modelu/podfolderu). Dzieki temu dalej dziala DOKLADNIE ten sam
// groupTemplatesByType, ktory juz obsluguje oba przypadki.
function collectTemplateFilesFromDisk(wzoryFolder) {
  let entries;
  try {
    entries = fs.readdirSync(wzoryFolder, { withFileTypes: true });
  } catch (_) {
    return [];
  }

  const files = [];
  for (const e of entries) {
    const full = path.join(wzoryFolder, e.name);
    if (e.isFile() && /\.docx$/i.test(e.name)) {
      files.push({ path: full, originalName: e.name, relFolder: '' });
    } else if (e.isDirectory()) {
      let subEntries;
      try {
        subEntries = fs.readdirSync(full, { withFileTypes: true });
      } catch (_) {
        continue;
      }
      for (const sub of subEntries) {
        if (sub.isFile() && /\.docx$/i.test(sub.name)) {
          files.push({ path: path.join(full, sub.name), originalName: sub.name, relFolder: e.name });
        }
      }
    }
  }
  return files;
}

module.exports = { findWzoryFolders, collectTemplateFilesFromDisk, WZORY_FOLDER_RE };
