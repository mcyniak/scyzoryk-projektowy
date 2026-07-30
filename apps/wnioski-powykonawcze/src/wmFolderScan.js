const fsp = require('fs/promises');
const path = require('path');

// Jedyny staly sygnal "to jest kategoria WM" - plik zaczynajacy sie od "WM"
// (np. "WM Pompa ciepla split.docx"). Numeracja/glebokosc folderow NIE jest
// stala miedzy inwestycjami, wiec nie mozna sie na niej opierac przy
// wykrywaniu kategorii. Ten sam wzorzec co apps/drukarka-projekty/src/wmFolder.js
// (skopiowany, nie dzielony - patrz CLAUDE.md o vendorowaniu drobnych modulow
// zamiast przedwczesnej abstrakcji miedzy apkami).
const WM_TITLE_RE = /^WM\b/i;
// Wariant juz powykonawczy - zawsze ma "dok.pod" (czasem z kropka po "dok",
// czasem bez) zaraz po "WM".
const WM_DOKPOD_RE = /^WM\s*dok\.?\s*pod\b/i;

// Zabezpieczenie przed patologiczna struktura folderow (np. symlink-petla) -
// w praktyce kategorie WM widziane do tej pory sa maks. 2 poziomy glebokie.
const MAX_DEPTH = 6;

function parseLeadingNumber(name) {
  const m = String(name || '').match(/^(\d+)[.\-_ ]+/);
  return m ? Number(m[1]) : null;
}

// Rekurencyjnie znajduje KAZDY folder, ktory bezposrednio zawiera plik "WM ...".
// fs.readdirSync blokowaloby caly proces (Node ma jeden watek) na czas
// przejscia calego drzewa folderow - dla wiekszej inwestycji na dysku
// sieciowym/Dysku Google to wystarczalo, zeby health-check z panelu glownego
// oberwal timeoutem i apka przez chwile wygladala jak "uruchamianie sie",
// mimo ze proces zyl i po prostu skanowal foldery.
async function findCategoryFolders(rootPath, depth = 0, relParts = []) {
  if (depth > MAX_DEPTH) return [];
  let entries;
  try {
    entries = await fsp.readdir(rootPath, { withFileTypes: true });
  } catch (_) {
    return [];
  }

  const files = entries.filter(e => e.isFile()).map(e => e.name);
  const categories = [];
  if (files.some(name => WM_TITLE_RE.test(name))) {
    categories.push({ folderPath: rootPath, relPath: relParts.join('/'), files });
  }

  for (const e of entries) {
    if (e.isDirectory()) {
      categories.push(...await findCategoryFolders(path.join(rootPath, e.name), depth + 1, [...relParts, e.name]));
    }
  }
  return categories;
}

function categorySortComparator(a, b) {
  const na = parseLeadingNumber(path.basename(a.relPath));
  const nb = parseLeadingNumber(path.basename(b.relPath));
  if (na !== null && nb !== null) return na - nb;
  if (na !== null) return -1;
  if (nb !== null) return 1;
  return a.relPath.localeCompare(b.relPath, 'pl');
}

function categoryLabel(relPath) {
  const parts = String(relPath || '').split('/').filter(Boolean);
  if (!parts.length) return '(WM)';
  const last = parts[parts.length - 1].replace(/^\d+[.\-_ ]+\s*/, '');
  const parents = parts.slice(0, -1);
  return parents.length ? `${parents.join(' / ')} / ${last}` : last;
}

// Zwykly plik "WM ..." (nie dok.pod) w formacie DOCX - jedyny format, ktory
// da sie przerobic przez Word COM. Jesli tytul istnieje tylko jako PDF (bez
// zrodlowego DOCX), nie ma z czego zrobic wersji powykonawczej.
function pickSourceDocx(files) {
  const matches = files.filter(name =>
    WM_TITLE_RE.test(name) && !WM_DOKPOD_RE.test(name) && name.toLowerCase().endsWith('.docx'));
  return matches[0] || null;
}

function pickExistingDokPod(files) {
  const matches = files.filter(name => WM_DOKPOD_RE.test(name));
  return matches[0] || null;
}

// Skanuje folder WM (dowolnej inwestycji) i zwraca liste kategorii z
// informacja, czy maja gotowy plik zrodlowy do przerobienia, czy juz maja
// wersje powykonawcza, czy brak materialu do przerobienia.
async function scanWmFolder(rootPath) {
  const categories = (await findCategoryFolders(rootPath)).sort(categorySortComparator);

  const items = categories.map(cat => {
    const label = categoryLabel(cat.relPath);
    const sourceDocx = pickSourceDocx(cat.files);
    const existingDokPod = pickExistingDokPod(cat.files);
    let status;
    if (existingDokPod) status = 'juz-istnieje';
    else if (sourceDocx) status = 'do-przerobienia';
    else status = 'brak-docx';

    return {
      category: label,
      categoryPath: cat.relPath,
      folderPath: cat.folderPath,
      sourceDocx,
      sourcePath: sourceDocx ? path.join(cat.folderPath, sourceDocx) : null,
      existingDokPod,
      status
    };
  });

  return {
    items,
    categoriesFound: categories.length,
    toConvertCount: items.filter(i => i.status === 'do-przerobienia').length
  };
}

module.exports = { scanWmFolder, findCategoryFolders, categoryLabel, parseLeadingNumber, WM_TITLE_RE, WM_DOKPOD_RE };
