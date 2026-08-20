# Techniczne działanie Scyzoryka Projektowego

Ten dokument opisuje budowę projektu, sposób uruchamiania narzędzi oraz najważniejsze przepływy danych. Jest przeznaczony dla osób rozwijających, diagnozujących lub wdrażających Scyzoryk.

## 1. Ogólny model działania

Scyzoryk nie jest jedną dużą aplikacją. Składa się z:

- głównego panelu i nadzorcy procesów,
- niezależnych aplikacji narzędziowych,
- wspólnych modułów pomocniczych,
- skryptów instalacyjnych i diagnostycznych,
- lokalnych katalogów roboczych na pliki tymczasowe, wyniki i logi.

Schemat:

```text
STARTUJ-SCYZORYK.cmd
        │
        ▼
  główny server.js
        │
        ├── panel główny                 port 3000
        ├── Drukarka                     port 3001
        ├── Pieczątki PDF                port 3002
        ├── Dobory myEcodan            port 3003
        ├── Dokumenty seryjne            port 3004
        ├── Wnioski powykonawcze         port 3005
        ├── Przypisywanie plików do folderów port 3006
        ├── Drukarka projekty            port 3010
        └── OCR audytów                  port 3011
```

Główny serwer nie wykonuje zadań poszczególnych narzędzi. Uruchamia je jako oddzielne procesy Node.js, sprawdza ich stan i ponownie uruchamia proces, jeżeli zakończy się błędem.

Przeglądarka łączy się bezpośrednio z portem wybranego narzędzia. Panel główny pełni funkcję katalogu aplikacji i ekranu kontroli ich stanu.

## 2. Struktura repozytorium

```text
server.js
package.json
STARTUJ-SCYZORYK.cmd
NAPRAW-ZALEZNOSCI.cmd

apps/
  drukarka/
  drukarka-projekty/
  pieczatki-pdf/
  formularze-ecodan/
  dokumenty-seryjne/
  wnioski-powykonawcze/
  karty-katalogowe/
  ocr-audytow/

lib/
  hardening.js
  printing.js
  printing/

public/
  index.html
  admin.html

scripts/
  install-all.js
  check-project.js
  security-smoke-test.js

docs/
  TECHNICZNE_DZIALANIE.md
```

Każdy katalog `apps/<nazwa>` jest osobnym pakietem npm. Najczęściej zawiera:

```text
server.js          serwer Express i trasy API
package.json       zależności konkretnego narzędzia
public/            interfejs przeglądarkowy
src/               bardziej rozbudowana logika
scripts/           skrypty PowerShell lub narzędzia pomocnicze
data/              dane robocze, logi, pliki tymczasowe i wyniki
```

## 3. Uruchamianie projektu

### Standardowe uruchomienie

Użytkownik uruchamia:

```text
STARTUJ-SCYZORYK.cmd
```

Skrypt przygotowuje środowisko i uruchamia projekt. Typowy przepływ obejmuje:

1. zamknięcie pozostawionych procesów Node.js,
2. sprawdzenie lub instalację brakujących zależności,
3. kontrolę składni plików JavaScript i PowerShell,
4. uruchomienie głównego `server.js`,
5. uruchomienie wszystkich aplikacji potomnych.

Panel jest dostępny pod adresem:

```text
http://127.0.0.1:3000
```

### Uruchomienie ręczne

```powershell
npm run install-all
npm run check
npm start
```

### Instalowanie zależności

`scripts/install-all.js` przechodzi po jawnie zdefiniowanej liście aplikacji. Dla każdej z nich:

- sprawdza obecność wymaganych pakietów,
- uruchamia `npm ci` albo `npm install`,
- wymusza publiczny rejestr npm,
- dla Formularzy Ecodan instaluje również przeglądarkę Chromium używaną przez Playwright.

Dodając nową aplikację, należy dopisać ją zarówno w głównym `server.js`, jak i w `scripts/install-all.js`.

## 4. Główny nadzorca procesów

Plik `server.js` w katalogu głównym posiada listę aplikacji zawierającą:

- identyfikator narzędzia,
- nazwę wyświetlaną,
- opis,
- katalog roboczy,
- port,
- ścieżkę kontroli zdrowia,
- ewentualne dodatkowe zmienne środowiskowe.

Każde narzędzie jest uruchamiane poleceniem odpowiadającym:

```text
node server.js
```

w katalogu danej aplikacji.

Nadzorca:

- przechwytuje standardowe wyjście i błędy,
- oznacza linie nazwą aplikacji,
- zapisuje informacje o awariach,
- wznawia proces z rosnącym opóźnieniem,
- udostępnia panelowi informacje o stanie narzędzi.

## 5. Wspólny wzorzec aplikacji

Większość aplikacji używa podobnego schematu:

```text
interfejs HTML/JavaScript
          │
          ▼
      trasy Express
          │
          ▼
  logika w server.js/src
          │
          ├── pliki lokalne
          ├── Microsoft Word przez PowerShell
          ├── drukarki systemu Windows
          ├── zewnętrzny formularz przez Playwright
          └── Google Gemini / OpenAI dla OCR (opcjonalnie — dostępny tez tryb ręczny bez AI)
```

Żądania zmieniające dane powinny zawierać nagłówek:

```text
X-Scyzoryk-Request: 1
```

Aplikacje stosują również:

- ograniczenie liczby żądań,
- filtrowanie typów i rozszerzeń plików,
- sanityzowanie nazw,
- limity rozmiaru przesyłanych danych,
- okresowe usuwanie starych plików roboczych,
- diagnostykę błędów procesu,
- nasłuchiwanie wyłącznie na adresie lokalnym.

## 6. Wspólne moduły

### `lib/hardening.js`

Zawiera funkcje wykorzystywane przez różne aplikacje, między innymi:

- konfigurację diagnostyki procesu,
- logowanie krytycznych błędów,
- ustawianie limitów czasu serwera HTTP,
- uruchamianie PowerShell z poprawnym kodowaniem UTF-8,
- czyszczenie starych plików,
- kolejki szeregowe i semafory,
- pomocnicze funkcje JSON i logów.

### Drukowanie

Aplikacje drukujące korzystają ze wspólnej warstwy w `lib/printing.js` oraz ze skryptu PowerShell. Mechanizm wybiera dostępny sposób drukowania i przekazuje pliki do drukarki w ustalonej kolejności.

## 7. Opis narzędzi

### 7.1 Drukarka

Przyjmuje dokumenty, przechowuje kolejkę w ramach sesji użytkownika i drukuje pliki zgodnie z ustawieniami:

- kolejność,
- liczba kopii,
- tryb jedno- lub dwustronny,
- wybrana drukarka,
- opóźnienia pomiędzy zadaniami.

Przed faktycznym drukowaniem pliki są przygotowywane w lokalnym katalogu roboczym.

### 7.2 Drukarka projekty

Łączy dane z arkusza inwestycji z zawartością folderów projektowych. Logika:

1. odczytuje dane z Excela,
2. dopasowuje lokalizację do folderu projektu,
3. klasyfikuje znalezione dokumenty,
4. ustala kolejność na podstawie przyjętych zasad,
5. prezentuje zestaw użytkownikowi,
6. przekazuje zatwierdzoną paczkę do modułu drukowania.

Najbardziej wrażliwą częścią jest deterministyczne rozpoznawanie i sortowanie dokumentów. Dla tej logiki istnieje osobny test regresyjny.

### 7.3 Pieczątki PDF

Narzędzie otwiera dokument PDF i tworzy nową wersję z naniesioną pieczątką. Wykorzystuje bibliotekę `pdf-lib`, a podgląd dokumentu przygotowuje za pomocą `pdfjs-dist`.

Oryginalny plik nie jest modyfikowany.

### 7.4 Dobory myEcodan

Narzędzie odczytuje dane z arkusza Excel, sprawdza ich poprawność, a następnie steruje prawdziwą przeglądarką Chromium przez Playwright.

Przepływ:

```text
Excel
  → walidacja danych
  → kolejka rekordów
  → sesja Chromium
  → wypełnianie formularza
  → pobieranie lub zapisywanie wyników
```

Zadania wykonywane są partiami. Aplikacja prowadzi stan postępu i zapisuje informacje diagnostyczne, aby możliwe było ustalenie miejsca ewentualnego błędu.

### 7.5 Dokumenty seryjne PDF

Narzędzie przygotowuje osobny dokument dla każdego wiersza lub adresu.

Źródła danych mogą obejmować:

- arkusz Excel,
- wzory dokumentów Word,
- folder inwestycji,
- dokumenty OZC i audyty.

Microsoft Word jest sterowany przez skrypt PowerShell i mechanizm COM. Program odnajduje właściwe miejsca w tabelach oraz tekstach szablonu i zastępuje je danymi rekordu.

Ważne jest zachowanie istniejącego formatowania dokumentów. Dlatego uzupełnianie wykonywane jest w programie Word, a nie przez budowanie dokumentów od zera.

### 7.6 Wnioski powykonawcze

Aplikacja przetwarza pliki Word i tworzy końcową dokumentację PDF. Może działać dla pojedynczego pliku albo przetwarzać większy folder według ustalonych reguł.

### 7.7 Przypisywanie plików do folderów

Narzędzie odczytuje identyfikatory urządzeń z Excela, wyszukuje właściwe karty katalogowe i kopiuje je do folderów przypisanych do klientów lub lokalizacji. Alternatywnie (bez doboru kart) dokleja audyty, schematy elektryczne, dokumenty seryjne albo dobory (Varmero/myEcodan) do już istniejącego folderu klienta, dopasowane po adresie z tego samego arkusza.

Główne ryzyko biznesowe stanowi poprawne dopasowanie identyfikatora (albo adresu) do właściwego pliku, dlatego nazewnictwo i reguły dopasowania powinny być testowane na rzeczywistych inwestycjach.

### 7.8 OCR audytów

OCR audytów jest najbardziej rozbudowanym przepływem analizy dokumentu.

Od 12 sierpnia 2026 narzędzie ma trzech wymiennych dostawców rozpoznawania (moduł
`src/aiProvider.js` działa jako wspólny adapter — reszta aplikacji nie zależy od tego, który
dostawca jest akurat aktywny):

- **Google Gemini** — użytkownik wpisuje własny klucz API w ustawieniach narzędzia,
- **OpenAI** — analogicznie, własny klucz API,
- **Ręcznie (bez AI)** — żaden klucz, żadne zapytanie sieciowe; użytkownik sam odczytuje wartości
  z dużego, przybliżalnego podglądu strony obok tabeli pól.

Wcześniejsza wersja korzystała z Google Cloud Document AI z wbudowaną w instalator konfiguracją
konta serwisowego — to rozwiązanie zostało **całkowicie usunięte**. Instalator (zarówno publiczny,
jak i deweloperski) nie zawiera już żadnego sekretu OCR; każdy klucz API jest wpisywany ręcznie
przez użytkownika po instalacji i trzymany lokalnie na jego komputerze
(`%LOCALAPPDATA%\Scyzoryk\gemini-api-key.json` albo analogiczny plik dla OpenAI).

Przepływ wygląda następująco:

```text
zeskanowany PDF
      │
      ▼
podział zbiorczego pliku na adresy
      │
      ├── Gemini/OpenAI: automatyczna propozycja podziału na bloki
      └── tryb ręczny: caly plik = jeden blok, uzytkownik dzieli recznie
      │
      ▼
kontrola i korekta przez użytkownika
      │
      ▼
rozpoznanie pól formularza
      │
      ├── Gemini/OpenAI: automatyczne (w tym pismo odręczne i checkboxy)
      └── tryb ręczny: wszystkie pola startują puste, wymagają recznego uzupelnienia
      │
      ▼
kontrola pól niepewnych lub pustych
      │
      ├── PDF wyjściowy = kopia oryginalnych stron (bez utraty jakości)
      └── opcjonalny zapis danych do Excela
```

Narzędzie nie dzieli dokumentu automatycznie bez potwierdzenia. Użytkownik może poprawić granice poszczególnych bloków i wartości, których system nie rozpoznał wystarczająco pewnie.

Narzędzie nie wykrywa ani nie poprawia automatycznie obrotu strony (świadomie usunięte) — strony
muszą być wgrane już w prawidłowej orientacji, w przeciwnym razie podglądy pól i ręczne zaznaczenia
na tej stronie będą nietrafione.

Wyjściowy PDF to zwykła kopia stron oryginalnego skanu (bez ponownej rasteryzacji, bez utraty jakości) — od migracji z Document AI (12 sierpnia 2026) narzędzie nie buduje już niewidocznej, przeszukiwalnej warstwy tekstu; rozpoznane wartości trafiają wyłącznie do tabeli pól i opcjonalnego eksportu do Excela.

OCR w trybie Gemini/OpenAI jest jedynym miejscem w projekcie wykonującym połączenia z usługą
zewnętrzną — strony wymagające rozpoznania są wtedy wysyłane do wybranego dostawcy. Tryb ręczny nie
łączy się z niczym. Konfiguracja to wyłącznie klucz API wpisany przez użytkownika w UI (albo,
opcjonalnie przy uruchomieniu ze źródeł, zmienna środowiskowa `GEMINI_API_KEY`/`OPENAI_API_KEY`) —
brak jakichkolwiek zmiennych `OCR_DOCAI_*` (usunięte razem z Document AI).

## 8. Pliki robocze i czyszczenie

Aplikacje tworzą katalogi takie jak:

- `data/`,
- `uploads/`,
- `output/`,
- `tmp/`,
- `logs/`.

Nie są to pliki źródłowe. Przechowują przesłane dokumenty, stan zadań, podglądy, wyniki oraz logi diagnostyczne.

Stare artefakty są okresowo usuwane przez harmonogram czyszczenia. Każda aplikacja może mieć własny czas przechowywania, zależny od rodzaju zadania.

## 9. Kontrola poprawności

Podstawowa kontrola całego repozytorium:

```powershell
npm run check
```

Skrypt sprawdza składnię:

- wszystkich plików JavaScript,
- wszystkich skryptów PowerShell.

Test uruchomionej instancji:

```powershell
npm run security-smoke
```

Sprawdza między innymi:

- dostępność aplikacji,
- działanie health-checków,
- odrzucanie niedozwolonych żądań modyfikujących.

Test sortowania Drukarki projekty uruchamia się w katalogu tej aplikacji:

```powershell
npm test
```

## 10. Dodawanie nowego narzędzia

Minimalna procedura:

1. utwórz `apps/<nowe-narzedzie>`,
2. dodaj `package.json`, `server.js` i katalog `public/`,
3. zastosuj istniejący wzorzec nagłówków, limitów i diagnostyki,
4. dodaj aplikację do listy w głównym `server.js`,
5. dodaj jej zależności do `dependencyChecks`,
6. dodaj ją do `scripts/install-all.js`,
7. dodaj health-check do `scripts/security-smoke-test.js`,
8. uzupełnij README i CLAUDE.md,
9. uruchom `npm run check`,
10. sprawdź aplikację na reprezentatywnych plikach.

## 11. Najważniejsze założenia projektowe

- system jest przeznaczony przede wszystkim dla Windows,
- aplikacje są lokalne i dostępne przez `127.0.0.1`,
- każde narzędzie pozostaje możliwie niezależne,
- formatowanie dokumentów użytkownika powinno być zachowane,
- zadania masowe muszą wymagać kontroli przed wykonaniem nieodwracalnej operacji,
- wyniki nie powinny nadpisywać oryginałów,
- nowe reguły dopasowania należy sprawdzać na rzeczywistych inwestycjach,
- długie zadania powinny mieć czytelny stan, diagnostykę i możliwość bezpiecznego zakończenia.

## 12. Dalsza dokumentacja

- [`README.md`](../README.md) — nietechniczny opis projektu i narzędzi,
- [`CLAUDE.md`](../CLAUDE.md) — szczegółowe konwencje i pułapki dla osób rozwijających kod.
