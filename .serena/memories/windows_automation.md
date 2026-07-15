# Automatyzacja Windows (drukowanie, Word) — pułapki

## Drukowanie (`lib/printing/print-file.ps1` + `lib/printing.js`, wspolne dla
`apps/drukarka` i `apps/drukarka-projekty` od konsolidacji 2026-07-15 — wczesniej
byly to dwie bit-identyczne kopie w `apps/<modul>/scripts/`, ktore juz zaczely sie
rozjezdzac: regex filtrowania drukarek wirtualnych i lista procesow zamykanych po
serii wydrukow roznily sie miedzy kopiami. `lib/printing.js` eksportuje
`listPrinters/safeName/contentDispositionHeader/wait/buildPrintJobs/
printFileWindows/closePdfAppsAfterBatch`; kazdy modul przekazuje wlasny
`logDir` (`apps/<modul>/data`) do `printFileWindows`, zeby log
`print-log.txt` zostal per-modul mimo wspolnego skryptu — skrypt PS przyjmuje
to jako parametr `-LogDir` (bez niego pisalby obok siebie w `lib/printing/`).)
Hybryda z trzema poziomami fallbacku, w tej kolejności (tylko dla plików PDF —
patrz niżej dla nie-PDF):
1. **SumatraPDF.exe** (portable, w `scripts/`) z `-print-to "<drukarka>" -silent
   -exit-when-done` — jedyna metoda, która NAPRAWDĘ nie pokazuje żadnego okna.
   Niektóre drukarki (potwierdzone: sterowniki sieciowe/WSD, np. Brother przez WSD)
   zwracają kod błędu (obserwowany: 13) i NIC nie drukują mimo pozornego sukcesu —
   dlatego zawsze wymagany fallback, nie ufać samej Sumatrze.
2. **Adobe Acrobat DC** przez `/t "plik" "drukarka"` (linia komend) — działa
   szerzej, ale na chwilę "budzi się" jako aplikacja (mignięcie okna), mimo
   `-WindowStyle Hidden` w `Start-Process` (Acrobat częściowo ignoruje tę wskazówkę).
3. **Shell verb `-Verb Print`** (otwiera plik w jego domyślnym programie) — jedyna
   metoda działająca dla plików NIE-PDF (np. .docx), bo Sumatra/Acrobat `/t` obsługują
   tylko PDF. Nie pozwala wybrać innej niż systemowa domyślna drukarka.
- Wybór KONKRETNEJ (nie domyślnej) drukarki działa więc dziś TYLKO dla PDF.
  Dla .docx trzeba by prawdziwej automatyzacji Worda z ustawieniem aktywnej
  drukarki przed drukiem (nie zaimplementowane).
- Timeout na próbę Sumatry: 15s, potem `Stop-Process -Force` i przejście do
  Acrobata — Sumatra bywa obserwowana jako zawieszająca się na niektórych drukarkach.
- Odzyskiwanie focusu okna (żeby drukowanie nie przerywało pisania użytkownikowi
  w innym oknie): `ScyzorykFocusGuard` (P/Invoke `user32.dll`, `EnumWindows` +
  `SetForegroundWindow`/`AttachThreadInput`), pollowanie co 15ms przez pierwsze
  1.5s (moment w którym drukująca aplikacja tworzy okno), potem co 80ms.
- Log diagnostyczny: `apps/<moduł>/data/print-log.txt` (dopisywany, nie nadpisywany
  między próbami w ramach jednej operacji — częściowo wdrożone, nie 100% pokrycia).

## Word COM (`apps/dokumenty-seryjne/scripts/mailmerge-to-pdf.ps1`,
`apps/wnioski-powykonawcze`)
- Prawdziwe `New-Object -ComObject Word.Application` — wymaga zainstalowanego
  Worda, działa TYLKO na Windows. Jedna instancja Worda na raz w całym systemie
  (serializowane przez `wordQueue` w `lib/hardening.js` → `createSerialQueue`).
- Nazwa pliku wyjściowego: `Safe-FileName(Join-PrefixAndAddress $FilePrefix $address)`
  + `.pdf`, ląduje płasko w `-OutputDir`. `Unique-Path` dopisuje `_2`, `_3`... przy
  kolizji nazw — NIEBEZPIECZNE do polegania na kolejności przy przetwarzaniu
  wsadowym wielu wierszy naraz, bo nie da się niezawodnie odtworzyć który plik
  wyjściowy odpowiada któremu wierszowi wejściowemu.
- Bezpieczny wzorzec (użyty w `apps/dokumenty-seryjne/src/folderRoutes.js`
  → `runOneTemplate`): wywoływać skrypt RAZEM Z JEDNYM rekordem na raz
  (`-RowsCsv` z jednym numerem), z `-OutputDir` ustawionym NA folder docelowy tego
  konkretnego adresu — eliminuje całkowicie ryzyko pomylenia plików między
  klientami, kosztem wolniejszego przetwarzania wsadowego (jedno uruchomienie
  Worda per dokument per adres, nie batch).
