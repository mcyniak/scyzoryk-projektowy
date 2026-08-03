// Część szablonów (np. Slęsin PC powietrzne) to NIE są pliki z żółtymi komórkami do
// wypełnienia po etykiecie, tylko prawdziwe dokumenty korespondencji seryjnej
// Worda: mają realne pola MERGEFIELD i są na stałe podpięte (przez Word,
// "Wybierz odbiorców") do KONKRETNEGO arkusza w konkretnym pliku Excel, zapisane
// w word/settings.xml wewnątrz samego .docx. Ta funkcja czyta to powiązanie
// wprost z pliku, zamiast zgadywać wariant po nazwie pliku/folderu jak dla
// pozostałych stylów szablonów.
const AdmZip = require('adm-zip');

function readEntryText(zip, entryName) {
  const entry = zip.getEntry(entryName);
  if (!entry) return null;
  return zip.readAsText(entry, 'utf8');
}

// Zwraca { sheetName, dataSourcePath } gdy szablon jest podpięty do
// zewnętrznego Excela przez natywny mail merge Worda, albo null gdy nie -
// wtedy trzeba go traktować wg dotychczasowych reguł (żółte komórki/sufiks/folder).
function detectMailMergeSheetBinding(docxPath) {
  let zip;
  try {
    zip = new AdmZip(docxPath);
  } catch (_) {
    return null;
  }
  const settingsXml = readEntryText(zip, 'word/settings.xml');
  if (!settingsXml || !settingsXml.includes('<w:mailMerge>')) return null;

  // "<w:table w:val="'8kW$'"/>" -> nazwa arkusza "8kW". Fallback na w:query
  // (SELECT * FROM `'8kW$'`) gdy w:table brakuje.
  let sheetName = null;
  const tableMatch = settingsXml.match(/<w:table w:val="'?([^"'$]+)\$?'?"\s*\/>/);
  if (tableMatch) sheetName = tableMatch[1];
  if (!sheetName) {
    const queryMatch = settingsXml.match(/<w:query w:val="SELECT \* FROM `?'?([^`'$]+)\$?'?`?\s*"\s*\/>/);
    if (queryMatch) sheetName = queryMatch[1];
  }
  if (!sheetName) return null;

  // Ścieżka do Excela jest wpisana wprost w connectString (Data Source=...;) -
  // prostsze i bardziej niezawodne niż śledzenie relacji w:dataSource przez rId.
  const dataSourceMatch = settingsXml.match(/Data Source=([^;]+);/);
  const dataSourcePath = dataSourceMatch ? dataSourceMatch[1].trim() : null;

  return { sheetName, dataSourcePath };
}

// Zwraca czas ostatniego zapisu dokumentu (docProps/core.xml, dcterms:modified)
// w milisekundach, albo null gdy nie da sie go odczytac. Uzywane do
// rozstrzygania, ktory z dwoch realnie powiazanych plikow tego samego typu
// (np. przypadkowo zostawiona starsza kopia po zapisaniu poprawionej wersji
// pod inna nazwa - realny przypadek w Slesinie: "OT_ZIN_10KW_korespondencja.docx"
// i "..._korespondencja_1.docx" obok siebie) jest tym nowszym, zamiast po
// prostu gubic caly typ dokumentu jako "niejednoznaczny". Metadane w
// docProps/core.xml sa zapisywane przez Worda niezaleznie od systemu plikow,
// wiec sa wiarygodne nawet po przejsciu pliku przez upload (ktory nie
// zachowuje oryginalnego mtime).
function getDocxModifiedTime(docxPath) {
  let zip;
  try {
    zip = new AdmZip(docxPath);
  } catch (_) {
    return null;
  }
  const coreXml = readEntryText(zip, 'docProps/core.xml');
  if (!coreXml) return null;
  const m = coreXml.match(/<dcterms:modified[^>]*>([^<]+)<\/dcterms:modified>/);
  if (!m) return null;
  const t = Date.parse(m[1]);
  return Number.isNaN(t) ? null : t;
}

module.exports = { detectMailMergeSheetBinding, getDocxModifiedTime };
