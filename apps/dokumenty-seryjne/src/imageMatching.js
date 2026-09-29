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

// --- Przypisanie folderow zdjec do wierszy Excela (2026-09-28) --------------
// Wczesniej zdjecia trafialy do dokumentu TYLKO przy identycznej (po
// znormalizowaniu) nazwie folderu i adresu - folder "2.Wierzchlas 12" (tak
// nazywa foldery klientow "Tworzenie folderow": {LP}.{adres}),
// "Wierzchlas, ul. Polna 5" albo "Kamion 5 - zdjecia" po cichu nie dostawal
// zadnego zdjecia, a folder bez pary nie byl nigdzie pokazany.
//
// Dalej bez zgadywania "na podobienstwo" (zero Levenshteina): porownujemy
// ZBIORY slow adresu (kolejnosc, "ul."/"nr", przecinki bez znaczenia), plus
// trzy jawne, bezpieczne warianty nazwy folderu: bez numeru LP/ID na poczatku,
// bez opisu po numerze domu ("Kamion 5 zdjecia") i adres z Excela do
// pierwszego przecinka ("Kamion 5, 99-300 Kutno"). "Kamion 5" i "Kamion 15"
// dalej sa roznymi adresami. Folder pasujacy do kilku ROZNYCH adresow albo
// adres z kilkoma folderami -> nic automatycznie, uzytkownik wybiera sam
// (overrides: { [folder]: adres | '' } - '' = "nie uzywaj tego folderu").
const IGNORED_ADDRESS_TOKENS = new Set(['ul', 'nr', 'al', 'os', 'pl']);

function addressTokenList(text) {
  const tokens = normalizeAddress(text).split(' ').filter(Boolean);
  const out = [];
  for (const t of tokens) {
    // "5 A" == "5A": pojedyncza litera tuz po numerze domu.
    if (/^[a-z]$/.test(t) && out.length && /^\d+$/.test(out[out.length - 1])) { out[out.length - 1] += t; continue; }
    if (IGNORED_ADDRESS_TOKENS.has(t)) continue;
    out.push(t);
  }
  return out;
}

// Slowa bez kolejnosci ("Polna 5 Wierzchlas" == "Wierzchlas, ul. Polna 5"),
// ale numery W KOLEJNOSCI - "Kamion 5/3" i "Kamion 3/5" to rozne lokale.
function tokenKey(tokens) {
  const words = tokens.filter(t => !/\d/.test(t)).sort();
  const numbers = tokens.filter(t => /\d/.test(t));
  return words.join(' ') + ' | ' + numbers.join(' ');
}

function stripLeadingNumber(folder) {
  const m = String(folder || '').match(/^\s*(\d+)\s*[.)_\-]\s*(.+)$/) || String(folder || '').match(/^\s*(\d+)\s+(\D.*)$/);
  return m ? { number: m[1], rest: m[2] } : null;
}

// Warianty nazwy folderu: [{ key, how }]. "how" trafia do UI jako wyjasnienie.
function folderVariants(folder) {
  const variants = [];
  const add = (tokens, how) => {
    if (!tokens.length || !tokens.some(t => /\d/.test(t)) && tokens.length < 2) return;
    const key = tokenKey(tokens);
    if (!variants.some(v => v.key === key)) variants.push({ key, how });
  };
  const base = addressTokenList(folder);
  add(base, 'exact');
  const stripped = stripLeadingNumber(folder);
  const withoutLp = stripped ? addressTokenList(stripped.rest) : null;
  if (withoutLp) add(withoutLp, 'lp');
  for (const tokens of [base, withoutLp].filter(Boolean)) {
    const lastDigit = tokens.map(t => /\d/.test(t)).lastIndexOf(true);
    if (lastDigit > 0 && lastDigit < tokens.length - 1) add(tokens.slice(0, lastDigit + 1), 'suffix');
  }
  return { variants, leadingNumber: stripped ? stripped.number : null };
}

function addressVariants(address) {
  const variants = [];
  const add = (tokens, how) => {
    if (!tokens.length) return;
    const key = tokenKey(tokens);
    if (!variants.some(v => v.key === key)) variants.push({ key, how });
  };
  add(addressTokenList(address), 'exact');
  const firstPart = String(address || '').split(',')[0];
  if (firstPart !== String(address || '')) add(addressTokenList(firstPart), 'comma');
  return variants;
}

const MATCH_REASONS = {
  exact: 'ta sama nazwa',
  lp: 'nazwa folderu z numerem na początku',
  suffix: 'nazwa folderu z dopiskiem po numerze domu',
  comma: 'adres z Excela do pierwszego przecinka',
  manual: 'wybrane ręcznie',
};

function fileFolderPath(file) {
  if (Array.isArray(file.folderPath) && file.folderPath.length) return file.folderPath.map(String);
  return file.addressFolder ? [String(file.addressFolder)] : [];
}

// Etykieta folderu zdjecia: najplytszy segment sciezki, ktory pasuje do
// jakiegos adresu ("Inwestycja/projekty/1.Kamion 5/zdjecia/1.jpg" ->
// "projekty/1.Kamion 5"), a gdy zaden nie pasuje - pierwszy segment (jak
// dotad: podfolder wybranego folderu). Dzieki temu mozna wskazac caly folder
// inwestycji z drzewem z "Tworzenia folderow", a nie tylko folder "Zdjecia".
function matchedDepth(segs, addressKeys) {
  for (let i = 0; i < segs.length; i++) {
    const { variants } = folderVariants(segs[i]);
    if (variants.some(v => addressKeys.has(v.key))) return i;
  }
  return -1;
}

// Folder bez pary ma byc pokazany na TYM SAMYM poziomie co foldery, ktore
// sie dopasowaly ("projekty/3.Nieznany 9", a nie samo "projekty").
function labelContext(manifest, addressKeys) {
  const depthCounts = new Map();
  for (const file of (manifest && manifest.files) || []) {
    const depth = matchedDepth(fileFolderPath(file), addressKeys);
    if (depth >= 0) depthCounts.set(depth, (depthCounts.get(depth) || 0) + 1);
  }
  let fallbackDepth = 0;
  let best = 0;
  for (const [depth, count] of depthCounts) if (count > best) { best = count; fallbackDepth = depth; }
  return { addressKeys, fallbackDepth };
}

function photoFolderLabel(file, ctx) {
  const segs = fileFolderPath(file);
  if (!segs.length) return '';
  const depth = matchedDepth(segs, ctx.addressKeys);
  if (depth >= 0) return segs.slice(0, depth + 1).join('/');
  return segs.slice(0, Math.min(segs.length, ctx.fallbackDepth + 1)).join('/');
}

function lastSegment(label) {
  const parts = String(label).split('/');
  return parts[parts.length - 1];
}

function buildAddressKeys(rowInfo) {
  const addressKeys = new Map();
  rowInfo.forEach(r => {
    for (const v of addressVariants(r.address)) {
      if (!addressKeys.has(v.key)) addressKeys.set(v.key, []);
      addressKeys.get(v.key).push({ row: r, how: v.how });
    }
  });
  return addressKeys;
}

function listPhotoFolders(manifest, addressKeys = new Map()) {
  const ctx = labelContext(manifest, addressKeys);
  const map = new Map();
  for (const file of (manifest && manifest.files) || []) {
    const ext = path.extname(String(file.originalName || '')).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) continue;
    const label = photoFolderLabel(file, ctx);
    if (!label) continue;
    map.set(label, (map.get(label) || 0) + 1);
  }
  return [...map.entries()].map(([folder, photoCount]) => ({ folder, photoCount }))
    .sort((a, b) => a.folder.localeCompare(b.folder, 'pl', { numeric: true }));
}

function normalizeRows(rows) {
  return (rows || []).map(r => ({
    record: r.record,
    address: String(r.address == null ? '' : r.address).trim(),
    id: r.id == null ? '' : String(r.id).trim(),
  }));
}

// rows: [{ record, address, id }] (id = LP/ID wiersza, opcjonalnie - tylko
// do rozstrzygniecia "1.Kamion 5" vs "3.Kamion 5" dla powtorzonego adresu).
function matchPhotoFolders(rows, manifest, overrides = {}) {
  const rowInfo = normalizeRows(rows);
  const addressKeys = buildAddressKeys(rowInfo);
  const folders = listPhotoFolders(manifest, addressKeys);

  const folderResult = folders.map(({ folder, photoCount }) => {
    if (Object.prototype.hasOwnProperty.call(overrides, folder)) {
      const target = String(overrides[folder] || '');
      return { folder, photoCount, status: target ? 'manual' : 'ignored', address: target || null, reason: target ? MATCH_REASONS.manual : 'pominięty ręcznie', candidates: [] };
    }
    const { variants, leadingNumber } = folderVariants(lastSegment(folder));
    const hits = new Map(); // address -> { how, ids }
    for (const v of variants) {
      for (const hit of addressKeys.get(v.key) || []) {
        const how = hit.how === 'comma' ? 'comma' : v.how;
        if (!hits.has(hit.row.address)) hits.set(hit.row.address, { how, ids: new Set() });
        hits.get(hit.row.address).ids.add(hit.row.id);
      }
      if (hits.size && v.how === 'exact') break; // pewne dopasowanie wygrywa z wariantami
    }
    const candidates = [...hits.keys()];
    if (candidates.length === 1) {
      const { how } = hits.get(candidates[0]);
      return { folder, photoCount, status: how === 'exact' ? 'matched' : 'matched-loose', address: candidates[0], reason: MATCH_REASONS[how], candidates };
    }
    if (candidates.length > 1 && leadingNumber) {
      const byId = candidates.filter(a => hits.get(a).ids.has(leadingNumber));
      if (byId.length === 1) return { folder, photoCount, status: 'matched-loose', address: byId[0], reason: 'numer LP/ID na początku nazwy folderu', candidates };
    }
    return { folder, photoCount, status: candidates.length ? 'conflict' : 'unassigned', address: null, reason: candidates.length ? 'pasuje do kilku adresów' : 'brak pasującego adresu w Excelu', candidates };
  });

  // Adres z kilkoma folderami dopasowanymi AUTOMATYCZNIE = niejednoznaczne
  // (jak dotad: np. "Kamion 5" i "1.Kamion 5") - zadnego nie uzywamy, dopoki
  // uzytkownik nie wybierze. Reczne przypisanie kilku folderow jest OK.
  const autoByAddress = new Map();
  for (const f of folderResult) {
    if (f.status === 'matched' || f.status === 'matched-loose') {
      if (!autoByAddress.has(f.address)) autoByAddress.set(f.address, []);
      autoByAddress.get(f.address).push(f);
    }
  }
  for (const list of autoByAddress.values()) {
    if (list.length < 2) continue;
    for (const f of list) {
      f.candidates = [f.address];
      f.status = 'conflict';
      f.reason = `do tego adresu pasuje kilka folderów (${list.map(x => x.folder).join(', ')})`;
      f.address = null;
    }
  }

  const byAddress = new Map();
  for (const f of folderResult) {
    if (!f.address) continue;
    if (!byAddress.has(f.address)) byAddress.set(f.address, []);
    byAddress.get(f.address).push(f);
  }
  const rowsOut = rowInfo.map(r => {
    const assigned = byAddress.get(r.address) || [];
    const conflicting = folderResult.filter(f => f.status === 'conflict' && f.candidates.includes(r.address));
    return {
      record: r.record,
      address: r.address,
      folders: assigned.map(f => f.folder),
      photoCount: assigned.reduce((sum, f) => sum + f.photoCount, 0),
      status: assigned.length ? (assigned.every(f => f.status === 'matched' || f.status === 'manual') ? 'ok' : 'check') : (conflicting.length ? 'conflict' : 'none'),
      reason: assigned.length ? [...new Set(assigned.map(f => f.reason))].join('; ') : (conflicting.length ? `kilka możliwych folderów: ${conflicting.map(f => f.folder).join(', ')}` : ''),
    };
  });

  return {
    folders: folderResult,
    rows: rowsOut,
    counts: {
      rows: rowsOut.length,
      withPhotos: rowsOut.filter(r => r.photoCount > 0).length,
      toCheck: rowsOut.filter(r => r.status === 'check').length,
      conflicts: rowsOut.filter(r => r.status === 'conflict').length,
      unassignedFolders: folderResult.filter(f => f.status === 'unassigned' || f.status === 'conflict').length,
      ignoredFolders: folderResult.filter(f => f.status === 'ignored').length,
    },
  };
}

// Manifest dla silnika: silnik dopasowuje zdjecia po (znormalizowanym)
// adresie rekordu == addressFolder. Przepisujemy wiec addressFolder kazdego
// zdjecia na ADRES wiersza, do ktorego jego folder zostal przypisany; zdjecia
// z folderow nieprzypisanych/pominietych/sprzecznych nie trafiaja nigdzie.
function buildEffectiveManifest(manifest, matchResult, rows) {
  const ctx = labelContext(manifest, buildAddressKeys(normalizeRows(rows)));
  const target = new Map(matchResult.folders.filter(f => f.address).map(f => [f.folder, f.address]));
  const files = [];
  for (const file of (manifest && manifest.files) || []) {
    const label = photoFolderLabel(file, ctx);
    const address = target.get(label);
    if (!address) continue;
    files.push({ ...file, sourceFolder: label, addressFolder: address });
  }
  return { root: manifest && manifest.root || '', files };
}

module.exports = {
  IMAGE_EXTENSIONS,
  addressTokenList,
  listPhotoFolders,
  matchPhotoFolders,
  buildEffectiveManifest,
  normalizeAddress,
  isGalleryFieldName,
  detectImageMergeFields,
  buildManifestFromDisk,
  loadManifest,
  saveManifest,
  findPhotosForAddress,
  summarizeImages,
};
