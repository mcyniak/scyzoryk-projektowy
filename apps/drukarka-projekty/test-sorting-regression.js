// Test regresyjny dla sortowania dokumentow projektu (folderMatch.js).
// To jest funkcja KRYTYCZNA (patrz CLAUDE.md / pamiec projektu) - kazda
// zmiana w folderMatch.js albo migracja na Google Drive musi dawac
// IDENTYCZNY wynik ponizszych testow, chyba ze celowo zmieniamy regule
// biznesowa i swiadomie aktualizujemy oczekiwany wynik.
//
// test/fixtures/kolektory-zarnow-41/ to zamrozona kopia SAMYCH NAZW plikow
// (puste pliki, zero tresci klienta) z prawdziwego projektu na dysku:
// G:\Dyski wspoldzielone\Dzial Projektowy Sanitarny\6. Paradyz Zarnow\
// Kolektory\Projekty\Zarnow\41 - Zarnow, ul. Spacerowa
// Lista zalacznikow ponizej zostala RAZ wyciagnieta z prawdziwego pliku OT
// tego projektu (mammoth + extractAttachmentsList) i zapisana tu na sztywno,
// zeby test nie zalezal od zamontowanego dysku G:\ ani od kopiowania
// prawdziwej tresci dokumentu klienta do repo.
//
// Uruchomienie: node test-sorting-regression.js

const assert = require('assert');
const path = require('path');
const fm = require('./src/folderMatch.js');

let failed = 0;
function check(label, fn) {
  try {
    fn();
    console.log('OK   ' + label);
  } catch (err) {
    failed += 1;
    console.error('FAIL ' + label);
    console.error('     ' + (err.message || err));
  }
}
async function checkAsync(label, fn) {
  try {
    await fn();
    console.log('OK   ' + label);
  } catch (err) {
    failed += 1;
    console.error('FAIL ' + label);
    console.error('     ' + (err.message || err));
  }
}

// ---------------------------------------------------------------------
// Scenariusz 1: prawdziwy projekt kolektorow (Zarnow 41) - patrz komentarz
// na gorze pliku.
// ---------------------------------------------------------------------
const ZARNOW_DIR = path.join(__dirname, 'test', 'fixtures', 'kolektory-zarnow-41', '41 - Żarnów, ul. Spacerowa');
const ZARNOW_ATTACHMENTS = [
  { num: 1, name: 'Informacja BIOZ' },
  { num: 2, name: 'Symulacja solarna' },
  { num: 3, name: 'Protokół uzgodnień projektowych' },
  { num: 4, name: 'Karta katalogowa kolektora słonecznego' },
  { num: 5, name: 'Karta katalogowa zasobnika solarnego' },
  { num: 6, name: 'Karta katalogowa grupy pompowej solarnej' }
];
// Dokladny wynik buildOrder() na dzien 2026-07-15, zweryfikowany bezposrednio
// na zywym folderze na G:\ (patrz komentarz na gorze). Zawiera tez znany,
// NIE naprawiony w tym przebiegu drobny problem: plik blokady Worda
// "~$_S_P_Ż_250.docx" (tworzony automatycznie gdy ktos ma otwarty OT w
// Wordzie) laduje jako "Niedopasowany plik" zamiast byc pominietym cichym
// smieciem - swiadomie zostawione w tescie, zeby przyszla poprawka tego
// zachowania byla widoczna jako oczekiwana zmiana testu, a nie przypadkowa
// regresja.
const ZARNOW_EXPECTED_ORDER = [
  { file: 'ST_S_P_Ż_250.docx', label: 'Strona tytułowa', confidence: 'pewne' },
  { file: 'OT_S_P_Ż_250.docx', label: 'Opis techniczny', confidence: 'pewne' },
  { file: '41_S_Krzywkowski_Żarnów, ul. Spacerowa.pdf', label: 'Rysunek / dokumentacja rysunkowa', confidence: 'pewne' },
  { file: 'BIOZ_S_P_Ż.pdf', label: 'Załącznik nr 1: Informacja BIOZ', confidence: 'słowo kluczowe' },
  { file: 'Symulacja solarna Żarnów_2_250.pdf', label: 'Załącznik nr 2: Symulacja solarna', confidence: 'słowo kluczowe' },
  { file: 'Żarnów Spacerowa.pdf', label: 'Załącznik nr 3: Protokół uzgodnień projektowych', confidence: 'pewne' },
  { file: 'Kolektor KSG 21GT.pdf', label: 'Załącznik nr 4: Karta katalogowa kolektora słonecznego', confidence: 'słowo kluczowe' },
  { file: 'Zasobnik SGW(S)B 250.pdf', label: 'Załącznik nr 5: Karta katalogowa zasobnika solarnego', confidence: 'słowo kluczowe' },
  { file: 'Grupa pompowa.pdf', label: 'Załącznik nr 6: Karta katalogowa grupy pompowej solarnej', confidence: 'słowo kluczowe' },
  { file: '~$_S_P_Ż_250.docx', label: 'Niedopasowany plik - sprawdź ręcznie', confidence: 'niedopasowane' }
];

async function testZarnow41() {
  const classifiedRaw = fm.classifyFiles(ZARNOW_DIR);

  await checkAsync('Żarnów 41: rozpoznaje strone tytulowa (ST_*.docx)', async () => {
    assert.strictEqual(classifiedRaw.titlePage, 'ST_S_P_Ż_250.docx');
  });
  await checkAsync('Żarnów 41: rozpoznaje opis techniczny (OT_*.docx)', async () => {
    assert.strictEqual(classifiedRaw.techDescDocx, 'OT_S_P_Ż_250.docx');
    assert.strictEqual(classifiedRaw.techDescPdf, undefined);
  });
  await checkAsync('Żarnów 41: rozpoznaje rysunek (41_S_..._.pdf pasuje do wzorca N_litera_)', async () => {
    assert.deepStrictEqual(classifiedRaw.drawingLike, ['41_S_Krzywkowski_Żarnów, ul. Spacerowa.pdf']);
  });
  await checkAsync('Żarnów 41: .dwg i .bak sa pomijane (nie sa PDF/DOCX/DOC)', async () => {
    assert.deepStrictEqual(
      new Set(classifiedRaw.skipped),
      new Set(['41_S_Krzywkowski_Żarnów, ul. Spacerowa.dwg', '41_S_Krzywkowski_Żarnów, ul. Spacerowa.bak'])
    );
  });

  const classified = await fm.detectByContent(ZARNOW_DIR, classifiedRaw);
  const order = fm.buildOrder(classified, ZARNOW_ATTACHMENTS, { adres: 'Żarnów, ul. Spacerowa', gmina: 'Żarnów' });

  await checkAsync('Żarnów 41: pelna kolejnosc dokumentow zgadza sie z przypiietym wynikiem', async () => {
    assert.deepStrictEqual(order, ZARNOW_EXPECTED_ORDER);
  });
}

// ---------------------------------------------------------------------
// Scenariusz 2: brak wymaganego pliku (Opis techniczny) - buildOrder MUSI
// jawnie zaznaczyc brak, a nie po prostu pominac pozycje w wyniku (patrz
// komentarz w kodzie buildOrder - to byl swiadomie naprawiony wczesniej
// blad: brakujacy plik byl kiedys NIEWIDOCZNY w wyniku).
// ---------------------------------------------------------------------
function testMissingRequiredFile() {
  const classified = {
    titlePage: 'ST_test.pdf',
    techDescPdf: null,
    techDescDocx: null,
    otStVariants: [],
    drawingLike: ['1_a_rysunek.pdf'],
    pool: [],
    protokolFileByContent: null
  };
  const order = fm.buildOrder(classified, [], { adres: 'Testowa 1' });
  check('Brak Opisu technicznego: buildOrder dodaje jawny wpis "BRAK PLIKU", nie pomija cicho', () => {
    const otEntry = order.find(o => o.label.startsWith('Opis techniczny'));
    assert.ok(otEntry, 'brak wpisu dla Opisu technicznego w ogole');
    assert.strictEqual(otEntry.file, null);
    assert.strictEqual(otEntry.confidence, 'brak');
  });
}

// ---------------------------------------------------------------------
// Scenariusz 3: duplikaty tej samej nazwy w roznych rozszerzeniach -
// classifyFiles ma preferowac PDF nad DOCX/DOC dla tej samej bazowej nazwy.
// ---------------------------------------------------------------------
function testDuplicateBaseNamePrefersPdf() {
  // classifyFiles czyta prawdziwy folder z dysku (scanFilesRecursive), wiec
  // budujemy minimalny fixture w locie zamiast mockowac fs.
  const fs = require('fs');
  const dir = path.join(__dirname, 'test', 'fixtures', '__tmp_duplicate_basename__');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'dokument.docx'), '');
  fs.writeFileSync(path.join(dir, 'dokument.pdf'), '');
  try {
    const classified = fm.classifyFiles(dir);
    check('Ta sama nazwa bazowa w .docx i .pdf: zostaje wersja PDF, .docx trafia do droppedDuplicates', () => {
      assert.ok(classified.printable.includes('dokument.pdf'));
      assert.ok(!classified.printable.includes('dokument.docx'));
      assert.deepStrictEqual(classified.droppedDuplicates, ['dokument.docx']);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  await testZarnow41();
  testMissingRequiredFile();
  testDuplicateBaseNamePrefersPdf();

  console.log('');
  if (failed) {
    console.error(`Testy nie przeszly: ${failed}`);
    process.exit(1);
  }
  console.log('Wszystkie testy sortowania przeszly.');
})();
