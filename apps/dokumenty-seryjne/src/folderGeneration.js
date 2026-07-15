const fs = require("fs");
const path = require("path");
const { resolveEntriesForRow } = require("./templateScan");

// Elastyczne dopasowanie nazwy kolumny - arkusze sa robione recznie przez
// rozne osoby, wiec "LP", "Lp", " LP", "ID projektu", "Id" itd. musza byc
// rozpoznawane jako to samo pole. Najpierw szukamy DOKLADNEGO dopasowania
// (po zdjeciu spacji/wielkosci liter), potem CZESCIOWEGO (zawiera sie).
function findColumnFuzzy(columns, patterns) {
  const normalized = (columns || []).map(c => ({
    original: c,
    key: String(c).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim()
  }));
  for (const p of patterns) {
    const exact = normalized.find(c => c.key === p);
    if (exact) return exact.original;
  }
  for (const p of patterns) {
    const partial = normalized.find(c => c.key.includes(p));
    if (partial) return partial.original;
  }
  return "";
}

// UWAGA: wzorce musza byc na tyle specyficzne, zeby nie kolidowaly z innymi
// polami o podobnej nazwie - np. "numer"/"nr" jako pattern latwo trafialby
// tez w "Numer działki" albo "Nr telefonu", wiec ich tu NIE MA - zamiast
// tego tylko "lp"/"id projektu"/"id", ktore sa dużo bardziej jednoznaczne.
const COLUMN_GUESSES = {
  numer: ["lp gmina", "lp", "id projektu", "id"],
  adres: ["adres", "adres inwestycji", "ulica"],
  gmina: ["gmina", "miejscowosc"]
};

// Dopasowujemy PO KOLEI (numer -> adres -> gmina) i wykluczamy juz
// przypisana kolumne z dalszych wyszukiwan - inaczej np. "LP gmina" mogloby
// zostac zlapane RAZEM jako numer I jako gmina (bo zawiera slowo "gmina").
function guessColumns(columns) {
  const pool = [...(columns || [])];
  const result = { numer: "", adres: "", gmina: "" };
  for (const field of ["numer", "adres", "gmina"]) {
    const found = findColumnFuzzy(pool, COLUMN_GUESSES[field]);
    if (found) {
      result[field] = found;
      const idx = pool.indexOf(found);
      if (idx !== -1) pool.splice(idx, 1);
    }
  }
  return result;
}

function safeFolderName(name) {
  const invalid = /[<>:"/\\|?*\x00-\x1F]/g;
  let cleaned = String(name || "").replace(invalid, "_").replace(/\s+/g, " ").trim();
  cleaned = cleaned.replace(/^\.+|\.+$/g, "");
  if (!cleaned) cleaned = "bez_nazwy";
  return cleaned.slice(0, 150);
}

// Nazwa folderu klienta - "{numer} - {adres}", identycznie jak szuka
// Drukarka projektow, zeby moc tam potem trafic tym samym mechanizmem.
function buildFolderName(row, columns) {
  const numer = columns.numer ? String(row[columns.numer] || "").trim() : "";
  const adres = columns.adres ? String(row[columns.adres] || "").trim() : "";
  if (numer && adres) return safeFolderName(`${numer} - ${adres}`);
  if (adres) return safeFolderName(adres);
  return safeFolderName(`wiersz_${row._record}`);
}

// Buduje plan generowania: dla kazdego wybranego wiersza - folder
// docelowy + lista zadan generowania (.docx, przez Worda) i kopiowania
// (.pdf, bezposrednio) dla wybranych typow dokumentow.
function buildGenerationPlan(rows, templateGroups, selectedGroupNames, columns, variantColumn) {
  const plan = [];
  for (const row of rows) {
    const folderName = buildFolderName(row, columns);
    const generateTasks = [];
    const copyTasks = [];
    const warnings = [];
    for (const groupName of selectedGroupNames) {
      const group = templateGroups.find(g => g.name === groupName);
      if (!group) continue;
      const variantValue = variantColumn ? row[variantColumn] : "";
      const gminaValue = columns.gmina ? row[columns.gmina] : "";
      const entries = resolveEntriesForRow(group, row, variantValue, gminaValue);
      if (!entries.length) {
        warnings.push(`Nie znaleziono pasującego wariantu dla „${groupName}" (wiersz ${row._record}).`);
        continue;
      }
      for (const entry of entries) {
        if (entry.ext === ".docx") generateTasks.push({ groupName, entry });
        else copyTasks.push({ groupName, entry });
      }
    }
    plan.push({ row, folderName, generateTasks, copyTasks, warnings });
  }
  return plan;
}

module.exports = { findColumnFuzzy, guessColumns, safeFolderName, buildFolderName, buildGenerationPlan };
