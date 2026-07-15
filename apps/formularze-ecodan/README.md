# Ecodan Generator PDF — final v1 RC5

Lokalny generator raportów PDF z my-ecodan.me na podstawie Excela inwestycji.

## Najważniejsze w RC5

- użytkownik podaje **nazwę inwestycji**,
- użytkownik podaje **folder bazowy zapisu**, np. `D:\Raporty Ecodan`,
- program sam tworzy folder inwestycji, np. `D:\Raporty Ecodan\Ślesin 2026`,
- PDF-y zapisują się automatycznie w `pdf`, bez ręcznego zapisywania każdego raportu,
- po zakończeniu można pobrać jeden ZIP z wynikami,
- wygląd strony został odświeżony,
- zostaje równoległość workerów, anulowanie zadania, CSV, błędy, podsumowanie i debug.

## Uruchomienie na Windows

Najprościej:

```powershell
.\start.cmd
```

Jeżeli poprzednia instalacja została przerwana albo `node_modules` jest uszkodzone:

```powershell
.\clean-install.cmd
.\start.cmd
```

Po starcie otwórz:

```text
http://localhost:3000
```

## Jak zapisywane są pliki

Na stronie podajesz:

```text
Nazwa inwestycji: Ślesin 2026
Folder bazowy zapisu: D:\Raporty Ecodan
```

Program utworzy:

```text
D:\Raporty Ecodan\Ślesin 2026
├── pdf
│   ├── 002 - Tobiasz Górski - Akacjowa 4.pdf
│   ├── 003 - ...pdf
│   └── ...
├── wyniki.csv
├── bledy.txt
├── podsumowanie.json
├── logs
│   └── events.jsonl
├── debug
└── tmp
```

Jeżeli zostawisz pole folderu puste, wyniki zapiszą się w folderze generatora:

```text
output/jobs/<nazwa-inwestycji-data-id>
```

## ZIP z wynikami

Po zakończeniu zadania na stronie pojawia się przycisk:

```text
Pobierz ZIP z wynikami
```

ZIP zawiera:

```text
pdf/
wyniki.csv
bledy.txt
podsumowanie.json
logs/events.jsonl
debug/
```

## Ustawienia zalecane

Na początek:

```text
Ile raportów równolegle: 2
```

Jeżeli komputer i my-ecodan działają stabilnie:

```text
3 albo 4
```

Dziesięć równoległych sesji jest dostępne testowo, ale nie jest zalecane jako domyślne ustawienie.

## Zmienne środowiskowe

Można ustawiać ręcznie przed `npm.cmd start`:

```powershell
$env:HEADLESS="true"
$env:BATCH_CONCURRENCY="2"
$env:BATCH_RESTART_EVERY="5"
$env:RECORD_TIMEOUT_MS="480000"
```

## Diagnostyka

```powershell
npm.cmd run doctor
npm.cmd run check
```

## Ważne ograniczenie

Aplikacja WWW działa lokalnie przez Node.js. Pole „Folder bazowy zapisu” jest ścieżką widzianą przez komputer/serwer, na którym uruchomiono generator. Jeżeli generator będzie kiedyś uruchomiony na wspólnym serwerze, pliki zapiszą się na tym serwerze, a użytkownik pobierze je przyciskiem ZIP.

## Skracanie raportów PDF

Po pobraniu raportu z My Ecodan aplikacja automatycznie zostawia w gotowym pliku tylko pierwsze 3 strony. Dotyczy to PDF-ów w folderze `pdf` oraz plików pobieranych w ZIP-ie.
