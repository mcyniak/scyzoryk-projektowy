const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

// xlsx (SheetJS) nie jest zaleznoscia karty-katalogowe (uzywa tylko read-excel-file
// do ODCZYTU), ale jest juz zaleznoscia drukarka-projekty w tym repo - wykorzystujemy
// jej node_modules do ZAPISU prawdziwego pliku .xlsx na potrzeby testu (ten sam wzorzec
// co test/group3-ocr.test.js requirujacy exceljs z node_modules ocr-audytow).
const XLSX = require('../apps/drukarka-projekty/node_modules/xlsx');
const readXlsxFile = require('../apps/karty-katalogowe/node_modules/read-excel-file/node');
const { przetworzArkusz, adresPasujeDoFolderu } = require('../apps/karty-katalogowe/server');

const HEADER = ['LP gminy', 'Adres', 'UID', 'Rezygnacja'];

// Plik .xlsx zyje w SWOIM WLASNYM katalogu tymczasowym, ODDZIELNYM od "root"
// (folderow projektow/kart). Zlapane realnie na Node 20 (dokladnie wersja
// uzywana w CI): read-excel-file trzyma otwarty uchwyt pliku .xlsx dlugo po
// tym, jak jego Promise sie rozwiazuje - na Windows to blokuje usuniecie
// katalogu (EPERM/ENOTEMPTY) przez wiele sekund. Rozdzielenie katalogow
// oznacza, ze sprzatanie "root" (gdzie faktycznie sprawdzamy wyniki) nigdy
// nie zalezy od tego, czy uchwyt .xlsx zdazyl juz zostac zwolniony.
async function napiszArkusz(sheetName, rows) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kk-xlsx-'));
  const file = path.join(dir, 'dane.xlsx');
  const ws = XLSX.utils.aoa_to_sheet([HEADER, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, file);
  return { file, dir };
}

// Sprzatanie katalogu .xlsx jest "best effort" (nie wplywa na wynik testu) -
// w najgorszym razie zostawia kilka bajtow w %TEMP%, co i tak posprzata system.
function usunPozniej(dir) {
  fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}

async function przygotujRoot({ foldery, kartyPliki }) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kk-root-'));
  const kartyDir = path.join(root, 'karty');
  await fsp.mkdir(kartyDir, { recursive: true });
  for (const nazwa of kartyPliki) await fsp.writeFile(path.join(kartyDir, nazwa), 'tresc');

  const projektyDir = path.join(root, 'Projekty', 'Zarnow');
  await fsp.mkdir(projektyDir, { recursive: true });
  for (const nazwa of foldery) await fsp.mkdir(path.join(projektyDir, nazwa), { recursive: true });

  return { root, projektyDir };
}

const WYMAGANE_KARTY = ['Grupa pompowa.pdf', 'Kolektor KSG 21GT.pdf', 'Zasobnik SGW(S)B 250.pdf'];

test('adresPasujeDoFolderu: zgodny adres przechodzi, niezgodny (konflikt numeracji) odrzuca', () => {
  assert.equal(adresPasujeDoFolderu('ul. Spacerowa 5, Zarnow', '41 - Zarnow, ul. Spacerowa'), true);
  assert.equal(adresPasujeDoFolderu('ul. Kwiatowa 3, Kamiensk', '41 - Zarnow, ul. Spacerowa'), false);
  // Pusty adres w Excelu - nie ma z czym porownac, nie blokujemy (zachowanie sprzed zmiany).
  assert.equal(adresPasujeDoFolderu('', '41 - Zarnow, ul. Spacerowa'), true);
  assert.equal(adresPasujeDoFolderu('   ', '41 - Zarnow, ul. Spacerowa'), true);
});

test('przetworzArkusz: konflikt numeracji miedzy inwestycjami - adres z Excela nie pasuje do znalezionego folderu -> blad, brak kopiowania', async (t) => {
  // Dwie rozne inwestycje maja folder zaczynajacy sie od tego samego numeru "41" -
  // dokladnie scenariusz szkody z audytu zewnetrznego.
  const { root, projektyDir } = await przygotujRoot({
    foldery: ['41 - Zarnow, ul. Spacerowa'],
    kartyPliki: WYMAGANE_KARTY
  });
  t.after(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  const { file, dir: xlsxDir } = await napiszArkusz('Solary Zarnow', [
    // Adres w wierszu wskazuje na CALKIEM INNA miejscowosc/ulice niz folder "41 - Zarnow, ul. Spacerowa".
    [41, 'ul. Kwiatowa 3, Kamiensk', '2/250', '']
  ]);
  t.after(() => usunPozniej(xlsxDir));

  const [arkusz] = await readXlsxFile(file, { getSheets: true });
  const wyniki = await przetworzArkusz({ sheetName: arkusz.sheet, rows: arkusz.data, rootPath: root, dryRun: false });

  assert.equal(wyniki.length, 1);
  assert.equal(wyniki[0].status, 'blad');
  assert.match(wyniki[0].komunikat, /nie zawiera adresu z Excela/);
  assert.match(wyniki[0].komunikat, /konflikt numeracji/);

  const folderKlienta = path.join(projektyDir, '41 - Zarnow, ul. Spacerowa');
  const skopiowane = await fsp.readdir(folderKlienta);
  assert.deepEqual(skopiowane, []); // nic nie zostalo skopiowane do obcego folderu
});

test('przetworzArkusz: zgodny adres -> normalne kopiowanie, zero regresji', async (t) => {
  const { root, projektyDir } = await przygotujRoot({
    foldery: ['41 - Zarnow, ul. Spacerowa'],
    kartyPliki: WYMAGANE_KARTY
  });
  t.after(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  const { file, dir: xlsxDir } = await napiszArkusz('Solary Zarnow', [
    [41, 'ul. Spacerowa 5, Zarnow', '2/250', '']
  ]);
  t.after(() => usunPozniej(xlsxDir));

  const [arkusz] = await readXlsxFile(file, { getSheets: true });
  const wyniki = await przetworzArkusz({ sheetName: arkusz.sheet, rows: arkusz.data, rootPath: root, dryRun: false });

  assert.equal(wyniki.length, 1);
  assert.equal(wyniki[0].status, 'skopiowano');

  const folderKlienta = path.join(projektyDir, '41 - Zarnow, ul. Spacerowa');
  const skopiowane = (await fsp.readdir(folderKlienta)).sort();
  assert.deepEqual(skopiowane, [...WYMAGANE_KARTY].sort());
});
