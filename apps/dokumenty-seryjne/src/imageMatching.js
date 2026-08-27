'use strict';

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

function normalizeFileName(name) {
  const base = path.basename(name, path.extname(name));
  return base
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/ł/g, 'l')
    .replace(/[^a-z0-9]+/g, '');
}

function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function naturalSort(arr) {
  return [...arr].sort(naturalCompare);
}

function extractTrailingNumber(name) {
  const m = name.match(/(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

function makeFieldAliases(fieldName) {
  const aliases = new Set();
  const normalized = normalizeFileName(fieldName);
  aliases.add(normalized);
  aliases.add(normalized.replace(/_/g, ''));

  const num = extractTrailingNumber(fieldName);
  if (num !== null) {
    aliases.add(String(num));
    aliases.add(String(num).padStart(2, '0'));
    const withoutUnderscoreNum = normalized.replace(/_?\d+$/, '') + String(num);
    aliases.add(withoutUnderscoreNum);
  }

  return aliases;
}

function findBestFileForField(fieldName, files) {
  const aliases = makeFieldAliases(fieldName);
  const candidates = files.filter((f) => {
    const ext = path.extname(f.originalName).toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  });

  for (const file of candidates) {
    const baseNorm = normalizeFileName(file.originalName);
    if (aliases.has(baseNorm)) {
      return file;
    }
  }
  return null;
}

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
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

function saveManifest(manifestPath, manifest) {
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
}

function buildFolderMap(manifest) {
  const map = new Map();
  for (const file of manifest.files) {
    const key = normalizeAddress(file.addressFolder);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(file);
  }
  return map;
}

function resolveImagesForAddress(address, fields, manifest) {
  const result = {
    status: 'missing',
    matches: Object.create(null),
    errors: [],
  };

  const folderMap = buildFolderMap(manifest);
  const key = normalizeAddress(address);
  const files = folderMap.get(key) || [];

  const imageFiles = files.filter((f) => {
    const ext = path.extname(f.originalName).toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  });

  if (imageFiles.length === 0 && fields.length === 0) {
    result.status = 'complete';
    return result;
  }

  if (fields.length === 0 && imageFiles.length > 0) {
    result.status = 'ambiguous';
    result.errors.push('Brak pól zdjęciowych w szablonie, ale znaleziono pliki w folderze ze zdjęciami.');
    return result;
  }

  const directMatches = Object.create(null);
  let directCount = 0;
  for (const field of fields) {
    const file = findBestFileForField(field, imageFiles);
    if (file) {
      directMatches[field] = file;
      directCount++;
    }
  }

  if (directCount === fields.length) {
    result.status = 'complete';
    result.matches = directMatches;
    return result;
  }

  const unmatchedFields = fields.filter((f) => !directMatches[f]);
  const usedPaths = new Set(Object.values(directMatches).map((f) => f.storedPath));
  const unusedFiles = imageFiles.filter((f) => !usedPaths.has(f.storedPath));

  if (unusedFiles.length === unmatchedFields.length && unmatchedFields.length > 0) {
    const sortedFields = naturalSort(unmatchedFields);
    const sortedFiles = naturalSort(unusedFiles.map((f) => f.originalName));
    for (let i = 0; i < sortedFields.length; i++) {
      const file = unusedFiles.find((f) => f.originalName === sortedFiles[i]);
      directMatches[sortedFields[i]] = file;
    }
  }

  for (const field of fields) {
    result.matches[field] = directMatches[field] || null;
  }

  const matchedCount = Object.values(result.matches).filter(Boolean).length;
  if (matchedCount === fields.length) {
    result.status = 'complete';
    return result;
  }

  if (imageFiles.length > fields.length) {
    result.status = 'ambiguous';
    result.errors.push(
      `W folderze znaleziono ${imageFiles.length} zdjęć, ale szablon wymaga ${fields.length} pól.`
    );
  } else {
    result.status = 'missing';
    result.errors.push(
      `Dopasowano ${matchedCount} z ${fields.length} wymaganych zdjęć.`
    );
  }

  return result;
}

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
      const lower = name.toLowerCase();
      if (lower.startsWith('zdjecie') || lower.startsWith('zdjęcie') || lower.startsWith('foto') || lower.startsWith('zdj_')) {
        if (!seen.has(name)) {
          seen.add(name);
          fields.push(name);
        }
      }
    }
  }

  return fields;
}

function summarizeImages(addresses, fields, manifest) {
  const rows = [];
  let complete = 0;
  let missing = 0;
  let ambiguous = 0;

  for (const address of addresses) {
    const resolved = resolveImagesForAddress(address, fields, manifest);
    rows.push({ address, ...resolved });
    if (resolved.status === 'complete') complete++;
    else if (resolved.status === 'ambiguous') ambiguous++;
    else missing++;
  }

  let status = 'complete';
  if (ambiguous > 0) status = 'ambiguous';
  else if (missing > 0) status = 'missing';

  return {
    status,
    total: addresses.length,
    complete,
    missing,
    ambiguous,
    rows,
  };
}

module.exports = {
  normalizeAddress,
  buildManifestFromDisk,
  loadManifest,
  saveManifest,
  buildFolderMap,
  resolveImagesForAddress,
  detectImageMergeFields,
  summarizeImages,
  IMAGE_EXTENSIONS,
};
