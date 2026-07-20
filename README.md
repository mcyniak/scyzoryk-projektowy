# Scyzoryk Projektowy

Lokalny (127.0.0.1) zestaw narzędzi webowych do automatyzacji pracy biurowej działu
projektowego: generowanie dokumentacji z Worda i Excela, stemplowanie i porządkowanie
PDF-ów, drukowanie paczek dokumentów we właściwej kolejności oraz generowanie raportów
Ecodan. Całość działa na Windows, uruchamiana lokalnie na jednym komputerze — bez
logowania, bez chmury, bez instalacji poza portable Node.js i lokalnym Microsoft Word.

Projekt jest rozwijany od 2026-07 i pozostaje w aktywnym rozwoju — część funkcji (np.
automatyczne dane z OZC/audytów w dokumentach seryjnych) jest świadomie budowana
etapami i weryfikowana na prawdziwych danych projektowych przed uznaniem za gotową.

## Jak to jest zbudowane

Scyzoryk **nie jest jedną aplikacją**, tylko nadzorcą procesów + panelem. Plik `server.js`
w katalogu głównym:

- uruchamia po jednym procesie `node server.js` na każde narzędzie z `apps/*`, każde na
  własnym porcie,
- restartuje z backoffem (max 30 s) każdy proces, który padnie,
- serwuje statyczny panel startowy (`public/index.html`) z linkami do wszystkich narzędzi
  oraz panel techniczny (`public/admin.html`),
- **nie proxuje** ruchu do dzieci — przeglądarka łączy się bezpośrednio z portem danego
  narzędzia.

Każde narzędzie w `apps/<nazwa>/` to niezależna aplikacja Express z własnym
`package.json`, `node_modules`, `public/` (front-end) i (w bardziej złożonych
przypadkach) `src/` na logikę wydzieloną z handlerów tras.

## Narzędzia

| Narzędzie | Port | Co robi |
|---|---|---|
| Panel główny | 3000 | Lista narzędzi, status procesów, panel techniczny (`/admin`) |
| Drukarka | 3001 | Kolejka wydruku — dodaj pliki PDF/DOC/DOCX, ustaw kolejność, kopie, druk jedno-/dwustronny |
| Pieczątki PDF | 3002 | Dodawanie tekstowej pieczątki (pozycja, obrót, przezroczystość) do PDF |
| Formularze Ecodan | 3003 | Wypełnianie zewnętrznego formularza web na podstawie danych z Excela (sterowanie prawdziwą przeglądarką przez Playwright) |
| Dokumenty seryjne PDF | 3004 | Jeden PDF na adres z korespondencji seryjnej Word + Excel — patrz niżej |
| Wnioski powykonawcze PDF | 3005 | Zamiana wniosków materiałowych (Word) na dokumentację powykonawczą PDF — ręcznie albo automatycznie dla całego folderu WM |
| Karty katalogowe | 3006 | Dobór i kopiowanie kart katalogowych urządzeń do folderów klientów po kolumnie UID z Excela |
| Drukarka projekty | 3010 | Automatyczne odnalezienie folderu projektu, ustalenie kolejności dokumentów z Opisu technicznego i przygotowanie ich do druku (tryb adresowy i tryb WM) |

### Dokumenty seryjne PDF — najbardziej rozbudowane narzędzie

Wypełnia realne szablony Worda (bez pól MERGEFIELD/`{{}}` — same żółto podświetlone
komórki tabeli jako wizualna podpowiedź) danymi z Excela, dopasowując wartość po
**etykiecie w sąsiedniej komórce tabeli**, nie po pozycji. Dwa sposoby dostarczenia
szablonów:

- **Wgraj folder** — klasyczny wybór folderu przez przeglądarkę.
- **Wskaż folder inwestycji** — podajesz tylko ścieżkę folderu inwestycji (np.
  `G:\...\6. Paradyż Żarnów`), a program sam znajduje w nim podfolder ze wzorami (jeśli
  jest ich kilka — dajesz wybrać) oraz podfolder z danymi OZC/audytów, żeby uzupełnić
  dodatkowe pola techniczne tam, gdzie to możliwe (dane z Excela zawsze mają
  pierwszeństwo).

Warianty dokumentów (np. różne moce pompy ciepła albo rozmiary zestawu solarnego) są
rozpoznawane dwojako: po sufiksie w nazwie pliku (`_250`/`_300`/`_400`) albo po nazwie
podfolderu (np. `VARMERO VPM 9020`) — dopasowywane do wiersza Excela po kolumnie
wybranej przez użytkownika.

## Wymagania

- Windows,
- Microsoft Word zainstalowany lokalnie (Word COM — dotyczy Dokumentów seryjnych i
  Wniosków powykonawczych),
- portable instalacja Node.js (żadna globalna instalacja nie jest wymagana).

## Uruchomienie

Najprościej: dwuklik na `STARTUJ-SCYZORYK.cmd` — zabija osierocone procesy `node.exe`,
instaluje brakujące zależności, uruchamia sprawdzian składni i startuje serwer.

Ręcznie, z katalogu głównego repo:

```powershell
npm run install-all   # zależności wszystkich apps/* (npm ci gdy jest czysty lockfile)
npm run check          # node --check na kazdym .js + parser PowerShell na kazdym .ps1
npm start               # start panelu (port 3000) i wszystkich narzedzi-dzieci
```

Panel startowy: http://127.0.0.1:3000. Auto-instalacja brakujących zależności przy
starcie można wyłączyć zmienną `SCYZORYK_SKIP_AUTO_INSTALL=1`.

Awaryjnie, gdy zależności są uszkodzone: `NAPRAW-ZALEZNOSCI.cmd` (usuwa `node_modules`
i `package-lock.json` w każdej aplikacji i instaluje od zera).

## Bezpieczeństwo

Każda aplikacja niezależnie stosuje ten sam wzorzec (świadomie duplikowany, nie
importowany ze wspólnej biblioteki, żeby każde narzędzie było samodzielne):

- stałe nagłówki bezpieczeństwa (CSP, `X-Frame-Options: DENY`, `X-Content-Type-Options:
  nosniff`, `Referrer-Policy: no-referrer`),
- każde żądanie modyfikujące dane (nie GET/HEAD/OPTIONS) musi mieć nagłówek
  `X-Scyzoryk-Request: 1` — ochrona przed CSRF z innej domeny,
- `express-rate-limit` na trasach API (z wyjątkiem odczytu statusu zadania i
  health-checka, które są odpytywane zbyt często, by je limitować),
- `multer` z sanityzowanymi nazwami plików i białą listą rozszerzeń/MIME,
- wszystko nasłuchuje wyłącznie na `127.0.0.1` (zmienna `SCYZORYK_HOST`) — narzędzie
  jest z założenia lokalne, nie wystawione na sieć.

`npm run security-smoke` uruchamia smoke-test na już działającej instancji: sprawdza
health-endpoint każdej aplikacji i weryfikuje, że mutujący POST bez nagłówka
`X-Scyzoryk-Request` dostaje 403.

## Testy

Repo nie ma jednego wspólnego zestawu testów. `drukarka-projekty` ma własny
`npm test` (`node test-sorting-regression.js`) — regresję pinującą dokładną kolejność
dokumentów wygenerowaną przez `src/folderMatch.js` na zamrożonym, prawdziwym przykładzie
(same nazwy plików, bez treści dokumentów klienta). To najważniejsza logika biznesowa w
repo (deterministyczna kolejność druku/scalania dokumentów projektu) — uruchom ten test
po każdej zmianie w `folderMatch.js`.

## Struktura repo

```text
server.js              # nadzorca procesow + panel
lib/                    # wspolne moduly root-level (hardening.js, printing.js, ...)
public/                 # front-end panelu glownego
apps/<nazwa>/           # kazde narzedzie - niezalezna apka Express
  server.js
  public/                # front-end tego narzedzia
  src/                    # logika wydzielona z tras (w wiekszych apkach)
  scripts/                # skrypty PowerShell (Word COM, druk, itp.)
scripts/                # instalacja/sprawdzian/smoke-test calego repo
```

Szczegółowe wytyczne dla pracy nad kodem (konwencje, architektura poszczególnych
narzędzi, znane pułapki) są w `CLAUDE.md`.
