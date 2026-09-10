// Czyta manifest Smart Template (Kreator wzorow seryjnych) osadzony w DOCX
// jako Custom XML Part (namespace urn:scyzoryk:smart-template:v1). Uzywa
// adm-zip (juz zaleznosc tej apki, patrz package.json) - NIE wymaga Worda/COM,
// bo to tylko odczyt statycznej zawartosci pliku .docx (ktory jest zwyklym
// ZIP-em) - musi zadzialac natychmiast przy uploadzie, zanim jakakolwiek
// automatyzacja Worda w ogole wystartuje.
//
// apps/kreator-wzorow zapisuje manifest przez Word COM
// (`Document.CustomXMLParts.Add(...)`, patrz scripts/build-template.ps1) - to
// Word sam poprawnie dba o [Content_Types].xml i relacje w paczce OPC. Tutaj
// go tylko CZYTAMY, wiec prosty odczyt XML przez regex (ten sam styl co
// src/mailMergeSheetBinding.js w tym samym repo - regex na surowym XML
// zamiast pelnego parsera DOM, bo szukamy jednego znanego, prostego wzorca)
// wystarcza i nie wymaga dodatkowej zaleznosci do parsowania XML.
const AdmZip = require('adm-zip');
const { validateManifest } = require('../../../lib/smartTemplateRules');

const NAMESPACE = 'urn:scyzoryk:smart-template:v1';

// Rzucany gdy DOCX MA smart-template, ale manifest jest niepoprawny -
// nieobslugiwana/przyszla wersja schematu ALBO uszkodzona/niespojna struktura
// (patrz smartTemplateRules.js#validateManifest). W obu przypadkach NIE wolno
// cicho potraktowac pliku jak zwykly legacy template (jego "podswietlone"
// komorki/wielokropki nie sa etykietami do legacy heurystyk, tylko smart
// polami/blokami Kreatora - legacy fillery wygenerowalyby bezsensowna
// tresc) - wywolujacy ma pokazac ten blad wprost i zablokowac generowanie.
class SmartTemplateError extends Error {
  constructor(message, { futureVersion = false } = {}) {
    super(message);
    this.code = 'SMART_TEMPLATE_INVALID';
    this.futureVersion = futureVersion;
  }
}

function extractManifestJson(xmlText) {
  const cdataMatch = xmlText.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  if (cdataMatch) return cdataMatch[1];
  // Zapasowo (gdyby kiedys manifest zostal zapisany/recznie zedytowany bez
  // CDATA) - tresc miedzy tagami, z odkodowanymi encjami XML.
  const innerMatch = xmlText.match(/<scyzoryk:smartTemplate[^>]*>([\s\S]*?)<\/scyzoryk:smartTemplate>/);
  if (!innerMatch) return null;
  return innerMatch[1]
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .trim();
}

// Zwraca sparsowany manifest (juz przeszedl walidacje schematu w
// smartTemplateRules.js) albo `null`, jesli plik to zwykly, legacy DOCX bez
// zadnego smart-template - to jest cala odpowiedz na pytanie "czy ten
// konkretny szablon nalezy potraktowac jak Smart Template". Rzuca
// SmartTemplateError, gdy manifest JEST obecny, ale jest niepoprawny.
function readSmartTemplateManifest(docxPath) {
  let zip;
  try {
    zip = new AdmZip(docxPath);
  } catch (_) {
    return null;
  }

  const entries = zip.getEntries().filter(e => /^customXml\/item\d+\.xml$/.test(e.entryName));
  for (const entry of entries) {
    let xmlText;
    try {
      xmlText = zip.readAsText(entry, 'utf8');
    } catch (_) {
      continue;
    }
    if (!xmlText.includes(NAMESPACE)) continue;

    const manifestJson = extractManifestJson(xmlText);
    if (!manifestJson) {
      throw new SmartTemplateError('Znaleziono ślad Smart Template w dokumencie, ale nie udało się odczytać samego manifestu (uszkodzona struktura Custom XML Part).');
    }
    let manifest;
    try {
      manifest = JSON.parse(manifestJson);
    } catch (err) {
      throw new SmartTemplateError(`Uszkodzony manifest Smart Template w dokumencie: ${err.message}`);
    }
    const validation = validateManifest(manifest);
    if (!validation.valid) {
      throw new SmartTemplateError(
        `Nieprawidłowy wzór z Kreatora: ${validation.errors.join('; ')}`,
        { futureVersion: validation.futureVersion }
      );
    }
    return manifest;
  }
  return null;
}

module.exports = { readSmartTemplateManifest, SmartTemplateError, NAMESPACE };
