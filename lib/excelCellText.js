// Tekst komorki Excela tak, jak ma trafic do dokumentu (Dokumenty seryjne,
// Kreator wzorow). read-excel-file zwraca liczby jako Number, a String(4.32)
// daje "4.32" - w polskim dokumencie ma byc "4,32". Dodatkowo usuwa szum
// zmiennoprzecinkowy (0.1+0.2 -> "0,3"). Bez separatora tysiecy: calkowite
// (NIP, telefon, kod) zostaja jak byly, a parseSmartNumber() i tak rozumie
// przecinek, wiec warunki blokow dzialaja bez zmian.
'use strict';

function formatExcelDate(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return '';
  const dd = String(value.getDate()).padStart(2, '0');
  const mm = String(value.getMonth() + 1).padStart(2, '0');
  const yyyy = value.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

function formatExcelNumber(value) {
  if (!Number.isFinite(value)) return '';
  if (Number.isInteger(value)) return Number.isSafeInteger(value) ? String(value) : value.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 0 });
  let text = String(Number(value.toPrecision(12)));
  if (/e/i.test(text)) text = value.toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
  return text.replace('.', ',');
}

function excelCellText(value) {
  if (value == null) return '';
  if (value instanceof Date) return formatExcelDate(value);
  if (typeof value === 'number') return formatExcelNumber(value);
  return String(value).trim();
}

module.exports = { excelCellText, formatExcelNumber, formatExcelDate };
