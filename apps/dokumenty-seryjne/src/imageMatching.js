'use strict';

// Dopasowanie folderow ze ZDJECIAMI do adresow z Excela (plan
// PLAN_dokumenty_seryjne_tylko_zdjecia.md). Model: uzytkownik wybiera folder
// glowny, w ktorym leza PODFOLDERY nazwane adresami; wszystkie zdjecia
// (.jpg/.jpeg/.png) z podfolderu adresu trafiaja do pola galerii
// MERGEFIELD Zdjecia_pomontazowe w jego dokumencie. Zdjecia sa OPCJONALNE:
// brak folderu/puste folder to status 'ok' z zerem zdjec, nigdy blad.
//
// Normalizacja adresu jest deterministyczna (brak fuzzy/Levenshtein/typo-tolerance):
// "Łaszew 5A", "laszew 5a", " LASZEW  5A " -> ten sam klucz;
// "Laszew 5" vs "Laszew 5A" -> Rozne adresy. Nigdy nie zgadujemy.

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);

function normalizeAddress(text) {
  if (text === null || text === undefined) return '';
  const str = String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/ł/g, 'l')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return str;
}

// Pola galerii rozpoznajemy po znormalizowanej nazwie - lapie rowniez pisownie
// z diakrytykami ("Zdjecia_pomontazowe" / "Zdjęcia pomontażowe" itp.), bo
// normalizeAddress folduje lacinskie rozszerzenia i dowolne separatory.
function isGalleryFieldName(fieldName) {
  return normalizeAddress(fieldName) === normalizeAddress('Zdjecia_pomontazowe');
}

// Zwykle pole tekstowe typu "Zdjecie_1"/"Foto_X" NIE jest galeria - stare
// szablony z per-pozycyjnymi polami sa poza zakresem tej wersji (plan sect. 11).
function detectImageMergeFields(docxPath) {
  const fields = [];
  if (!fs.existsSync(docxPath)) return fields;

  let zip;
  try {
    zip = new AdmZip(docxPath);
  } catch (err) {
    return fields;
  }

  const entries = zip.getEntries();
  const relevant = entries.filter((e) => {
    const name = e.entryName.toLowerCase();
    return (
      name === 'word/document.xml' ||
      name.startsWith('word/header') ||
      name.startsWith('word/footer')
    );
  });

  const seen = new Set();
  for (const entry of relevant) {
    const xml = entry.getData().toString('utf8');
    const instrMatches = xml.matchAll(/<w:instrText[^>]*>([\s\S]*?)<\/w:instrText>/gi);
    let merged = '';
    for (const m of instrMatches) {
      merged += m[1];
    }

    const regex = /MERGEFIELD\s+(?:"([^"]+)"|([^\s\\]+))/gi;
    let m;
    while ((m = regex.exec(merged)) !== null) {
      const name = (m[1] || m[2]).trim();
      if (!name) continue;
      if (!isGalleryFieldName(name)) continue;
      if (!seen.has(name)) {
        seen.add(name);
        fields.push(name);
      }
    }
  }

  return fields;
}

// manifest.files = pliki zdjec; addressFolder to RAW nazwa podfolderu.
// Klucz mapy to znormalizowany adres folderu; wartość to wpisy POGRUPOWANE
// po RAW nazwie folderu - potrzebne do wykrycia niejednoznacznosci
// (dwa rozne fizyczne foldery dajace ten sam klucz, np. "Laszew 5A" i
// "Łaszew 5A" - plan sect. 21).
function buildFolderGroups(manifest) {
  // Map<normalizedKey, Array<{ rawFolder, files: [] }>>
  const map = new Map();
  if (!manifest || !Array.isArray(manifest.files)) return map;

  for (const file of manifest.files) {
    const ext = path.extname(String(file.originalName || '')).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) continue;
    const key = normalizeAddress(file.addressFolder);
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    const groups = map.get(key);
    let group = groups.find((g) => g.rawFolder === file.addressFolder);
    if (!group) {
      group = { rawFolder: file.addressFolder, files: [] };
      groups.push(group);
    }
    group.files.push(file);
  }
  return map;
}

function naturalCompareByOriginalName(a, b) {
  return String(a.originalName).localeCompare(String(b.originalName), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

// Zwraca { status, photos, folders }:
//   ok        -> photos = wszystkie zdjecia podfolderu adresu (moze byc 0), posortowane naturalnie
//   ambiguous -> kilka roznych folderow o tym samym znormalizowanym adresie;
//                photos = [] - NIGDY nie uzywamy zdjec innego adresu
function findPhotosForAddress(address, manifest) {
  const emptyOk = { status: 'ok', photos: [], folders: [] };
  const key = normalizeAddress(address);
  if (!key) return emptyOk;

  const groupsMap = buildFolderGroups(manifest);
  const groups = groupsMap.get(key);
  if (!groups || groups.length === 0) return emptyOk;

  if (groups.length > 1) {
    return {
      status: 'ambiguous',
      photos: [],
      folders: groups.map((g) => g.rawFolder),
    };
  }

  return {
    status: 'ok',
    photos: [...groups[0].files].sort(naturalCompareByOriginalName),
    folders: [groups[0].rawFolder],
  };
}

function summarizeImages(addresses, manifest) {
  const rows = [];
  let withImages = 0;
  let withoutImages = 0;
  let ambiguous = 0;

  for (const raw of addresses || []) {
    const address = String(raw == null ? '' : raw).trim();
    const resolved = findPhotosForAddress(address, manifest);
    rows.push({ address, ...resolved });
    if (resolved.status === 'ambiguous') ambiguous++;
    else if (resolved.photos.length > 0) withImages++;
    else withoutImages++;
  }

  return {
    total: rows.length,
    withImages,
    withoutImages,
    ambiguous,
    rows,
  };
}

// Manifest budowany tez z dysku - dla zrodla typu sciezka na dysku
// (ta sama struktura co przy uploadzie: root/adres/zdjecie.ext).
function buildManifestFromDisk(imageRoot) {
  const files = [];
  if (!fs.existsSync(imageRoot)) return { files, root: imageRoot };

  const entries = fs.readdirSync(imageRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const addressFolder = entry.name;
    const folderPath = path.join(imageRoot, addressFolder);
    const folderEntries = fs.readdirSync(folderPath, { withFileTypes: true });
    for (const fe of folderEntries) {
      if (fe.isDirectory()) continue;
      const ext = path.extname(fe.name).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(ext)) continue;
      files.push({
        relativePath: path.join(addressFolder, fe.name),
        addressFolder,
        storedPath: path.join(folderPath, fe.name),
        originalName: fe.name,
      });
    }
  }

  return { files, root: imageRoot };
}

function loadManifest(manifestPath) {
  if (!manifestPath || !fs.existsSync(manifestPath)) {
    return { files: [], root: '' };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!parsed || !Array.isArray(parsed.files)) return { files: [], root: parsed?.root || '' };
    return parsed;
  } catch {
    return { files: [], root: '' };
  }
}

function saveManifest(manifestPath, manifest) {
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
}

module.exports = {
  IMAGE_EXTENSIONS,
  normalizeAddress,
  isGalleryFieldName,
  detectImageMergeFields,
  buildManifestFromDisk,
  loadManifest,
  saveManifest,
  findPhotosForAddress,
  summarizeImages,
};
