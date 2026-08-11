// Czysta logika: dane odczytane przez src/excel.js -> plaska lista
// WZGLEDNYCH sciezek folderow do utworzenia w folderze inwestycji. Zero
// dostepu do systemu plikow tutaj (ten sam wzorzec co jobs.js/rules.js w
// innych appkach - logika oddzielona od I/O, w pelni testowalna bez
// dotykania dysku). Pelna specyfikacja drzewa: patrz plan w
// C:\Users\Piotr.Cyniak\.claude\plans\sparkling-doodling-prism.md i pamiec
// scyzoryk_next_roadmap_2026_08_11.md - wynegocjowana krok po kroku z
// wlascicielem, 2026-08-11.
const sanitize = require('sanitize-filename');

// Kazdy segment nazwy folderu pochodzacy z Excela (nazwa gminy, LP/ID,
// adres) przechodzi przez sanitize-filename PRZED zlozeniem sciezki -
// dokladnie ten sam wzorzec i uzasadnienie (dane z Excela = dane od
// klienta, moga zawierac "../") co apps/karty-katalogowe/server.js's
// gminaZNazwyArkusza()/safeName().
function safeSegment(value, fallback = '_') {
  const cleaned = sanitize(String(value || fallback)).replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '');
  return cleaned || fallback;
}

// "audyty"/"dobory"/"OZC"/"Projekty robót geologicznych" - zwykle podfoldery
// PC Grunt/PC powietrzne (OZC ma dodatkowo wlasny "pdf" w srodku). Kolektory
// i kotly NIE dostaja zadnego z tych czterech - tylko projekty+wzor.
const PC_EXTRA_LEAVES = [
  { name: 'audyty' },
  { name: 'dobory' },
  { name: 'OZC', child: 'pdf' },
  { name: 'Projekty robót geologicznych' }
];

function distinctGminas(records) {
  const seen = new Set();
  const result = [];
  for (const record of records) {
    const gmina = String(record.gmina || '').trim();
    if (!gmina || seen.has(gmina)) continue;
    seen.add(gmina);
    result.push(gmina);
  }
  return result;
}

// Buduje liste podfolderow dla jednego typu ("pompy/PC Grunt", "kolektory",
// "kotły"...). `extraLeaves` sa PUSTE dla kolektory/kotly (tylko
// projekty+wzor), a pelna 4-elementowa lista dla PC Grunt/PC powietrzne.
// Podzial na gminy (jesli gminaColumnPresent) dotyczy extraLeaves +
// projekty, ale NIGDY wzor - wzor zawsze zostaje plaski.
function buildTypeFolders(basePath, { gminaColumnPresent, records, extraLeaves }) {
  const paths = [];
  const gminas = gminaColumnPresent ? distinctGminas(records) : [null];

  for (const leaf of extraLeaves) {
    for (const gmina of gminas) {
      const base = gmina ? `${basePath}/${leaf.name}/${safeSegment(gmina)}` : `${basePath}/${leaf.name}`;
      paths.push(leaf.child ? `${base}/${leaf.child}` : base);
    }
  }

  // "projekty" (albo "projekty/{gmina}") istnieje zawsze, nawet gdy akurat
  // zero adresow trafilo do tego konkretnego podzialu (np. arkusz kolektory
  // istnieje, ale bez zadnego poprawnego wiersza) - gwarantuje strukture
  // zgodna z drzewem specyfikacji niezaleznie od danych.
  for (const gmina of gminas) {
    paths.push(gmina ? `${basePath}/projekty/${safeSegment(gmina)}` : `${basePath}/projekty`);
  }
  // Kazdy adres z arkusza dostaje wlasny podfolder {LP lub ID}.{adres}/pdf
  // wewnatrz "projekty" (lub "projekty/{gmina}").
  for (const record of records) {
    const addressFolder = `${safeSegment(record.lpOrId)}.${safeSegment(record.address)}`;
    const projektyBase = gminaColumnPresent
      ? `${basePath}/projekty/${safeSegment(record.gmina)}/${addressFolder}`
      : `${basePath}/projekty/${addressFolder}`;
    paths.push(`${projektyBase}/pdf`);
  }

  // "wzór" jest ZAWSZE plaski - jedyny podfolder wylaczony z podzialu na
  // gminy (to szablon, nie dane per-projekt).
  paths.push(`${basePath}/wzór`);

  return paths;
}

// Glowna funkcja: { sheets: [...] } (z excel.js#readTabelaAdresowa) ->
// plaska, zdeduplikowana lista wzglednych sciezek do utworzenia.
function buildFolderPlan(excelResult) {
  const sheets = (excelResult && excelResult.sheets) || [];
  const paths = ['WM'];

  const pompySheet = sheets.find(sheet => sheet.type === 'pompy');
  if (pompySheet) {
    const gruntRecords = pompySheet.records.filter(record => record.pumpType === 'grunt');
    const powietrznaRecords = pompySheet.records.filter(record => record.pumpType === 'powietrzna');
    // "PC Grunt"/"PC powietrzne" powstaja TYLKO gdy jest przynajmniej jeden
    // pasujacy wiersz - nigdy "na wszelki wypadek".
    if (gruntRecords.length > 0) {
      paths.push(...buildTypeFolders('pompy/PC Grunt', {
        gminaColumnPresent: pompySheet.gminaColumnPresent,
        records: gruntRecords,
        extraLeaves: PC_EXTRA_LEAVES
      }));
    }
    if (powietrznaRecords.length > 0) {
      paths.push(...buildTypeFolders('pompy/PC powietrzne', {
        gminaColumnPresent: pompySheet.gminaColumnPresent,
        records: powietrznaRecords,
        extraLeaves: PC_EXTRA_LEAVES
      }));
    }
  }

  const kolektorySheet = sheets.find(sheet => sheet.type === 'kolektory');
  if (kolektorySheet) {
    paths.push(...buildTypeFolders('kolektory', {
      gminaColumnPresent: kolektorySheet.gminaColumnPresent,
      records: kolektorySheet.records,
      extraLeaves: []
    }));
  }

  const kotlySheet = sheets.find(sheet => sheet.type === 'kotly');
  if (kotlySheet) {
    paths.push(...buildTypeFolders('kotły', {
      gminaColumnPresent: kotlySheet.gminaColumnPresent,
      records: kotlySheet.records,
      extraLeaves: []
    }));
  }

  // Deduplikacja - np. dwa wiersze z tym samym LP/adresem daloby ta sama
  // sciezke dwa razy.
  return [...new Set(paths)];
}

module.exports = { buildFolderPlan, buildTypeFolders, safeSegment, distinctGminas };
