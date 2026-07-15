# Scyzoryk Projektowy — wersja pokazowa

Lokalny panel narzedzi do automatyzacji pracy z dokumentami firmowymi.
Wersja pokazowa jest przygotowana pod prezentacje: ma uporzadkowany panel startowy, stale linki do narzedzi i jedna bezpieczna instrukcje uruchomienia.

## Co automatyzuje Scyzoryk?

- seryjne tworzenie PDF z Worda i Excela,
- przygotowanie wnioskow powykonawczych PDF,
- pieczetowanie i porzadkowanie PDF,
- drukowanie paczek dokumentow w odpowiedniej kolejnosci,
- generowanie raportow/formularzy Ecodan z danych z Excela.

## Wymagania

- Windows,
- Microsoft Word zainstalowany lokalnie,
- portable Node.js w folderze:

```text
C:\Users\Piotr.Cyniak\node-v26.4.0-win-x64
```

## Najprostsze uruchomienie demo

W PowerShellu uruchom:

```powershell
taskkill /F /IM node.exe

cd "C:\Users\Piotr.Cyniak\Documents\scyzoryk-projektowy-demo"

$env:Path="C:\Users\Piotr.Cyniak\node-v26.4.0-win-x64;$env:Path"
$env:PLAYWRIGHT_BROWSERS_PATH="0"

node scripts/install-all.js
node scripts/check-project.js
node server.js
```

Po starcie otworz:

```text
http://127.0.0.1:3000
```

## Porty narzedzi

- Panel glowny: http://127.0.0.1:3000
- Drukarka dokumentow: http://127.0.0.1:3001
- Pieczatki PDF: http://127.0.0.1:3002
- Formularze Ecodan: http://127.0.0.1:3003
- Dokumenty seryjne PDF: http://127.0.0.1:3004
- Wnioski powykonawcze PDF: http://127.0.0.1:3005
- Panel techniczny: http://127.0.0.1:3000/admin

## Uwaga do prezentacji

To jest wersja pokazowa/prototyp wdrozeniowy. Najlepiej przed prezentacja uruchomic ja raz samemu, przejsc najwazniejsze testy i zostawic otwarte okno PowerShella z dzialajacym `node server.js`.

## Co testowac przed pokazem

1. Panel glowny otwiera narzedzia.
2. Pieczatki PDF: PDF -> pieczatka -> eksport.
3. Wnioski powykonawcze: DOCX -> PDF.
4. Drukarka: dodanie kilku PDF i ustawienie kolejnosci.
5. Dokumenty seryjne: DOCX + XLSX -> 1 testowy PDF.
6. Formularze Ecodan: Excel -> wykryte adresy -> test generowania 1 raportu.


## Poprawka drukarki - szybki bufor + zamykanie Acrobata

Wersja: drukarka-szybki-fix-acrobat-close

- PDF jest wysylany do druku szybko: `print-file.ps1` czeka tylko 5 sekund.
- Acrobat nie jest zamykany ani zabijany po kazdym pliku.
- Po zakonczeniu calej serii Scyzoryk uruchamia opóźnione zamkniecie Acrobata po 120 sekundach.
- Zamkniecie jest lagodne: `CloseMainWindow()`, bez `Stop-Process -Force`, zeby nie anulowac buforowania.
- Czas mozna zmienic zmienna srodowiskowa `DRUKARKA_CLOSE_ACROBAT_AFTER_SECONDS`.

## Drukarka - szybki fix Acrobat w tle

W tej wersji PDF-y sa wysylane do druku tak jak w poprzednim szybkim fixie, ale okno Acrobat/Reader jest od razu minimalizowane. Acrobat nie jest ubijany po kazdym pliku, zeby nie przerywac buforowania ciezkich PDF-ow. Po calej serii aplikacja nadal probuje lagodnie zamknac Acrobat z opoznieniem ustawianym przez DRUKARKA_CLOSE_ACROBAT_AFTER_SECONDS.


## Uruchamianie po poprawce auto-install

Najprosciej uruchom `STARTUJ-SCYZORYK.cmd`. Jesli uruchamiasz recznie `node server.js`, projekt sam sprawdzi brakujace paczki npm i sprobuje je doinstalowac przed startem modulow.
