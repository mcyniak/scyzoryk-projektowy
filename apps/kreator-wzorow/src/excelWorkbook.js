// Odczyt przykladowej tabeli Excel dla Kreatora wzorow seryjnych. Ten sam
// wzorzec co apps/dokumenty-seryjne/server.js (read-excel-file + kolejnosc
// arkuszy z xl/workbook.xml zamiast zawodnej kolejnosci z samej biblioteki,
// patrz komentarz przy getSheetOrder ponizej) - apki w tym repo maja WLASNE
// kopie takich helperow (nie wspoldziela sie ich miedzy apps/*), Kreator nie
// jest tu wyjatkiem.
'use strict';

const readExcelFile = require('read-excel-file/node').default;
const AdmZip = require('adm-zip');

const MAX_UNIQUE_VALUES = 100;
const MAX_PREVIEW_ROWS = 500;

function formatExcelDate(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return '';
  const dd = String(value.getDate()).padStart(2, '0');
  const mm = String(value.getMonth() + 1).padStart(2, '0');
  const yyyy = value.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

function cellText(value) {
  if (value == null) return '';
  if (value instanceof Date) return formatExcelDate(value);
  return String(value).trim();
}

function decodeXmlEntities(text) {
  return String(text || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

// Kolejnosc arkuszy zwracana przez read-excel-file NIE musi odpowiadac
// kolejnosci widocznych zakladek w samym Excelu (potwierdzone realnie w
// dokumenty-seryjne - eksporty z Google Sheets potrafia zwrocic techniczne,
// ukryte arkusze PRZED prawdziwymi) - jedyne wiarygodne zrodlo to <sheet> w
// xl/workbook.xml.
function getSheetOrderFromWorkbookXml(filePath) {
  try {
    const zip = new AdmZip(filePath);
    const entry = zip.getEntry('xl/workbook.xml');
    if (!entry) return null;
    const xml = zip.readAsText(entry, 'utf8');
    const out = [];
    const re = /<sheet\b[^>]*\/>/g;
    let m;
    while ((m = re.exec(xml))) {
      const nameMatch = m[0].match(/name="([^"]*)"/);
      if (!nameMatch) continue;
      out.push({ name: decodeXmlEntities(nameMatch[1]), hidden: /state="hidden"/.test(m[0]) });
    }
    return out.length ? out : null;
  } catch (_) {
    return null;
  }
}

function dedupeColumnNames(columns) {
  const seen = new Map();
  return columns.map(name => {
    const key = String(name).toLowerCase().trim();
    const count = (seen.get(key) || 0) + 1;
    seen.set(key, count);
    return count === 1 ? name : `${name} (${count})`;
  });
}

function parseSheetRows(rawRows) {
  const inputRows = Array.isArray(rawRows) ? rawRows : [];
  let headerRowNumber = 0;
  let columns = [];
  for (let i = 0; i < inputRows.length; i += 1) {
    const row = Array.isArray(inputRows[i]) ? inputRows[i] : [];
    const values = row.map(cellText);
    if (values.some(Boolean)) {
      headerRowNumber = i + 1;
      columns = dedupeColumnNames(values.map((v, idx) => v || `Kolumna ${idx + 1}`));
      break;
    }
  }
  if (!headerRowNumber) return { columns: [], rows: [] };

  const rows = [];
  for (let i = headerRowNumber; i < inputRows.length; i += 1) {
    const row = Array.isArray(inputRows[i]) ? inputRows[i] : [];
    const obj = {};
    let hasData = false;
    for (let col = 0; col < columns.length; col += 1) {
      const text = cellText(row[col]);
      obj[columns[col]] = text;
      if (text) hasData = true;
    }
    if (hasData) rows.push(obj);
  }
  return { columns, rows };
}

// Zwraca { sheetNames, defaultSheet, sheets: { [name]: { columns, rows, totalRows } } }.
// `rows` maja doklejony `_record` (numer porzadkowy w OBRAMIE arkusza, stabilny
// niezaleznie od filtrowania w UI) - ten sam wzorzec co dokumenty-seryjne,
// bo Kreator finalnie przekazuje wybrany rekord do TEGO SAMEGO
// evaluateSmartRecord()/mailmerge-to-pdf.ps1, ktore go oczekuja.
async function readWorkbook(filePath) {
  const sheetsRaw = await readExcelFile(filePath);
  const sheetOrderFromXml = getSheetOrderFromWorkbookXml(filePath);

  const byName = new Map();
  for (const sheet of sheetsRaw || []) {
    const name = String(sheet.sheet || '').trim();
    if (!name) continue;
    byName.set(name, sheet.data || []);
  }

  let orderedNames;
  if (sheetOrderFromXml) {
    const known = new Set(byName.keys());
    orderedNames = sheetOrderFromXml.filter(s => known.has(s.name) && !s.hidden).map(s => s.name);
    if (!orderedNames.length) orderedNames = sheetOrderFromXml.filter(s => known.has(s.name)).map(s => s.name);
  }
  if (!orderedNames || !orderedNames.length) orderedNames = Array.from(byName.keys());

  const sheets = {};
  for (const name of orderedNames) {
    const parsed = parseSheetRows(byName.get(name) || []);
    const rows = parsed.rows.map((row, idx) => ({ _record: idx + 1, ...row }));
    sheets[name] = { columns: parsed.columns, rows, totalRows: rows.length };
  }

  return { sheetNames: orderedNames, defaultSheet: orderedNames[0] || null, sheets };
}

function sheetPreview(sheet, offset = 0, limit = MAX_PREVIEW_ROWS) {
  const safeOffset = Math.max(0, Number(offset) || 0);
  const safeLimit = Math.min(MAX_PREVIEW_ROWS, Math.max(1, Number(limit) || MAX_PREVIEW_ROWS));
  return {
    totalRows: sheet.rows.length,
    offset: safeOffset,
    limit: safeLimit,
    rows: sheet.rows.slice(safeOffset, safeOffset + safeLimit)
  };
}

// Do konfiguracji "lookup" (sekcja 8.C) - do MAX_UNIQUE_VALUES pierwszych
// unikalnych, NIEPUSTYCH wartosci danej kolumny, w kolejnosci wystapienia
// (nie alfabetycznie - user latwiej rozpoznaje "swoja" tabele po naturalnej
// kolejnosci wierszy).
function uniqueColumnValues(sheet, columnName) {
  const seen = new Set();
  const out = [];
  for (const row of sheet.rows) {
    const value = String(row[columnName] ?? '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= MAX_UNIQUE_VALUES) break;
  }
  return out;
}

module.exports = { readWorkbook, sheetPreview, uniqueColumnValues, getSheetOrderFromWorkbookXml, MAX_UNIQUE_VALUES };
