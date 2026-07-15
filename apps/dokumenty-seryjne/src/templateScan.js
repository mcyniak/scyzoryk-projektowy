const fs = require("fs");
const path = require("path");

const TEMPLATE_TYPE_PATTERNS = [
  { name: "Strona tytułowa", re: /^st[_\- ]/i },
  { name: "Opis techniczny", re: /^(ot[_\- ]|opis[_\- ]?techniczn)/i },
  { name: "Informacja BIOZ", re: /bioz/i },
  { name: "Symulacja solarna", re: /symulacj/i },
  { name: "Karta katalogowa", re: /karta.*katalogow/i },
  { name: "Zasobnik", re: /zasobnik/i },
  { name: "Grupa pompowa", re: /grupa.*pompow/i }
];

function classifyTemplateType(filename) {
  for (const t of TEMPLATE_TYPE_PATTERNS) if (t.re.test(filename)) return t.name;
  return null;
}

const VARIANT_SUFFIX_RE = /_(\d{3})$/;
// "solarn" jest OPCJONALNE - Kamieńsk pisze "Symulacja_Kamieńsk_2_300.pdf"
// (bez slowa "solarna"), Paradyż pisze "Symulacja solarna Paradyż_2_250.pdf".
const SYMULACJA_RE = /symulacj\w*[\s_]+(?:solarn\w*[\s_]+)?([a-ząćęłńóśźż]+)[\s_]*\d*[\s_]*(\d{3})/i;
// Przedrostek numeryczny typu "1. Karta katalogowa..." - uzywany TYLKO do
// sortowania w wyniku (zeby drukujacy recznie mial latwiej), nie do
// rozpoznawania typu.
const ORDER_PREFIX_RE = /^(\d+)[.\)]\s+/;

function classifyTemplates(items) {
  const groups = new Map();
  for (const it of items) {
    const withoutOrder = it.originalName.replace(ORDER_PREFIX_RE, "");
    const orderMatch = it.originalName.match(ORDER_PREFIX_RE);
    const orderNum = orderMatch ? Number(orderMatch[1]) : null;

    const recognizedName = classifyTemplateType(withoutOrder);
    const typeName = recognizedName || withoutOrder.replace(/\.(docx|pdf)$/i, "");
    if (!groups.has(typeName)) groups.set(typeName, { name: typeName, recognized: Boolean(recognizedName), entries: [] });
    const g = groups.get(typeName);

    if (typeName === "Symulacja solarna") {
      const m = withoutOrder.match(SYMULACJA_RE);
      g.entries.push({ ...it, orderNum, variantKey: m ? `${m[1].toLowerCase()}|${m[2]}` : null, gmina: m ? m[1] : null, moc: m ? m[2] : null });
    } else if (it.subfolder) {
      g.entries.push({ ...it, orderNum, variantKey: it.subfolder, variantRaw: it.subfolder });
    } else {
      const base = withoutOrder.replace(/\.(docx|pdf)$/i, "");
      const m = base.match(VARIANT_SUFFIX_RE);
      g.entries.push({ ...it, orderNum, variantKey: m ? m[1] : null, variantRaw: m ? m[1] : null });
    }
  }
  return Array.from(groups.values()).map(g => ({
    name: g.name,
    recognized: g.recognized,
    hasVariants: g.entries.some(e => e.variantKey),
    isSymulacja: g.name === "Symulacja solarna",
    entries: g.entries
  }));
}

function scanTemplateFolder(folderPath) {
  const items = [];
  const top = fs.readdirSync(folderPath, { withFileTypes: true });
  for (const e of top) {
    if (e.isFile()) pushIfDoc(items, folderPath, e.name, null);
    else if (e.isDirectory()) {
      let sub = [];
      try { sub = fs.readdirSync(path.join(folderPath, e.name), { withFileTypes: true }); } catch (_) { continue; }
      for (const se of sub) if (se.isFile()) pushIfDoc(items, path.join(folderPath, e.name), se.name, e.name);
    }
  }
  return items;
}
function pushIfDoc(items, dir, name, subfolder) {
  const ext = path.extname(name).toLowerCase();
  if (ext !== ".docx" && ext !== ".pdf") return;
  items.push({ path: path.join(dir, name), originalName: name, ext, subfolder });
}

// Sprawdza czy dany wariant pasuje do tekstu komorki, BEZ zakladania
// konkretnego formatu zapisu po ktorejkolwiek stronie. Jesli wariant
// zawiera liczby (250/300/400, "2.300", "VPM 9020" itd.) - dopasowujemy po
// WYSTAPIENIU TYCH SAMYCH CIAGOW CYFR w tekscie, niezaleznie od separatorow
// (/ . spacja) po obu stronach. Dziala jednakowo dla "2/300" (Excel) vs
// "2.300" (podfolder), "x250L/3,2kW" vs "250" (przyrostek pliku),
// "Varmero VPM9020" (Excel) vs "VARMERO VPM 9020" (podfolder).
// Jesli wariant nie ma zadnych cyfr, porownujemy tekst bez spacji.
function textContainsVariant(text, variantRaw) {
  const v = String(variantRaw || "").trim();
  if (!v) return false;
  const vDigits = v.match(/\d+/g) || [];
  if (vDigits.length) {
    const textDigits = String(text || "").match(/\d+/g) || [];
    return vDigits.every(d => textDigits.includes(d));
  }
  const norm = s => String(s || "").toLowerCase().replace(/\s+/g, "");
  return norm(text).includes(norm(v));
}

// Sposrod wpisow pasujacych do jednego wariantu usuwa duplikaty: jesli
// jest i .docx i .pdf o tej samej bazowej nazwie, PDF traktujemy jako
// zbedna kopie/podglad i zostawiamy tylko .docx (do wypelnienia danymi).
function dedupeEntries(entries) {
  const byBase = new Map();
  for (const e of entries) {
    const base = e.originalName.replace(ORDER_PREFIX_RE, "").replace(/\.(docx|pdf)$/i, "").toLowerCase().trim();
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(e);
  }
  const result = [];
  for (const list of byBase.values()) {
    const docx = list.find(e => e.ext === ".docx");
    result.push(docx || list[0]);
  }
  result.sort((a, b) => (a.orderNum ?? 999) - (b.orderNum ?? 999));
  return result;
}

// Zwraca wpisy pasujace do danego wiersza (po variantColumn) dla jednej
// grupy dokumentow. Dla Symulacji solarnej wymaga DODATKOWO dopasowania
// gminy.
function resolveEntriesForRow(group, row, variantColumnValue, gminaColumnValue) {
  if (!group.hasVariants) return dedupeEntries(group.entries);
  if (group.isSymulacja) {
    const gmina = String(gminaColumnValue || "").trim().toLowerCase();
    const matched = group.entries.filter(e =>
      textContainsVariant(variantColumnValue, e.moc) && gmina && e.gmina && e.gmina.toLowerCase() === gmina
    );
    return dedupeEntries(matched);
  }
  const matched = group.entries.filter(e => textContainsVariant(variantColumnValue, e.variantRaw));
  return dedupeEntries(matched);
}

module.exports = { scanTemplateFolder, classifyTemplates, classifyTemplateType, textContainsVariant, resolveEntriesForRow, dedupeEntries };
