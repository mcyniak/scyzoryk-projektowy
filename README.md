# 🧰 Scyzoryk Projektowy

<p align="center">
  <strong>Jeden lokalny panel, który porządkuje i automatyzuje codzienną pracę z dokumentacją projektową.</strong>
</p>

<p align="center">
  <img alt="Platforma Windows" src="https://img.shields.io/badge/platforma-Windows-0078D4?logo=windows&logoColor=white">
  <img alt="Działanie lokalne" src="https://img.shields.io/badge/działanie-lokalne-2E8B57">
  <img alt="Status projektu" src="https://img.shields.io/badge/status-aktywny%20rozwój-F59E0B">
</p>

---

## Czym jest Scyzoryk?

**Scyzoryk Projektowy** to zestaw prostych narzędzi uruchamianych z jednego panelu w przeglądarce. Ogranicza ręczne, powtarzalne czynności związane z przygotowaniem dokumentacji, drukowaniem, porządkowaniem plików i przepisywaniem danych.

Zamiast otwierać wiele programów i wykonywać te same kroki dla każdego adresu, użytkownik wybiera narzędzie i przechodzi przez czytelny formularz krok po kroku.

> Scyzoryk nie zastępuje pracy projektanta. Automatyzuje czynności techniczne i organizacyjne.

## Co daje w praktyce?

- mniej ręcznego przepisywania danych,
- szybsze przygotowywanie powtarzalnych dokumentów,
- kontrolowaną kolejność plików podczas drukowania,
- mniej pomyłek przy dobieraniu dokumentacji do adresu,
- łatwiejsze przetwarzanie większej liczby lokalizacji,
- jeden punkt dostępu do wszystkich firmowych narzędzi.

## Dostępne narzędzia

| Narzędzie | Do czego służy |
|---|---|
| 🖨️ **Drukarka dokumentów** | Dodaje wiele plików PDF/DOC/DOCX, pozwala ustawić kolejność, liczbę kopii, drukarkę i tryb jednostronny lub dwustronny. |
| 🗂️ **Drukarka projektów** | Na podstawie Excela i folderów adresów wyszukuje dokumentację, układa ją w kolejności i przygotowuje do druku. Obsługuje również wnioski materiałowe WM. |
| 🧾 **Pieczątki PDF** | Dodaje jedną lub wiele pieczątek do plików PDF, z podglądem, presetami, zakresem stron i ustawieniem pozycji. |
| 📋 **Dobory myEcodan** | Pobiera dane z Excela, automatycznie wypełnia formularze i zapisuje raporty PDF. Wynik zachowuje wyłącznie pierwsze trzy potrzebne strony. |
| 📄 **Dokumenty seryjne PDF** | Łączy folder wzorów Worda z tabelą Excel i tworzy osobne dokumenty dla wybranych adresów i wariantów. |
| 📝 **Wnioski powykonawcze PDF** | Zamienia wnioski materiałowe Word na dokumentację powykonawczą pojedynczo albo dla całego folderu WM. |
| 📚 **Przypisywanie plików do folderów** | Dobiera właściwe karty katalogowe urządzeń (albo audyty/schematy/dokumenty seryjne/dobory po adresie) i kopiuje je do odpowiednich folderów klientów. |
| 🔎 **OCR audytów** | Odczytuje skany, także z odręcznymi wpisami, tworzy przeszukiwalne PDF-y, dzieli pliki na adresy i przenosi sprawdzone dane do Excela. |
| 🌡️ **Dobory Varmero** | Automatyczne zgłoszenia do kalkulatora doboru pompy ciepła Varmero na podstawie tabeli adresowej, z odbiorem kart wynikowych mailem. |
| 🏷️ **Nazywarka skanów** | Zmienia nazwy zeskanowanych PDF-ów w miejscu, na sieciowym udziale skanera. |
| 📁 **Tworzenie folderów** | Tworzy strukturę podfolderów (WM/pompy/kolektory/kotły) w istniejącym folderze inwestycji na podstawie tabeli adresowej. |
| 📸 **Zdjęcia do PDF Protokołów** | Składa zdjęcia protokołów w przycięte, czarno-białe PDF-y gotowe do druku. |

## Instalacja dla użytkownika końcowego

Użytkownik końcowy nie powinien pobierać repozytorium ani ręcznie instalować Node.js.

1. Wejdź na stronę [Releases](../../releases) tego repozytorium i otwórz najnowsze wydanie (`vX.Y.Z`).
2. Pobierz `ScyzorykProjektowy-Setup-<wersja>.exe` (pierwsza instalacja albo pełna naprawa) — jeśli program jest już zainstalowany i tylko go aktualizujesz, wystarczy dużo mniejszy `ScyzorykProjektowy-Update-<wersja>.exe`.
3. Uruchom pobrany plik `.exe`.

Pełny instalator:

- zawiera przenośny Node.js oraz wszystkie zależności (w tym Chromium) — nic nie pobiera podczas instalacji,
- **nie zawiera** żadnego wbudowanego klucza/konta do OCR — jeśli chcesz automatycznego rozpoznawania tekstu (Google Gemini albo OpenAI), wpisujesz własny klucz API przy pierwszym uruchomieniu narzędzia OCR audytów; bez klucza dostępny jest tryb ręczny (bez AI, bez wysyłania czegokolwiek do internetu),
- jest publikowany dopiero po pełnym teście instalacji i uruchomienia na świeżym Windowsie (patrz `.github/workflows/release-public-installer.yml`).

Pełna instrukcja: [`docs/INSTRUKCJA-INSTALACJI.md`](docs/INSTRUKCJA-INSTALACJI.md).

Po instalacji ta sama instrukcja jest dostępna z przycisku **Pomoc** na panelu głównym lub pod adresem:

```text
http://scyzoryk.localhost:3000/instrukcja.html
```

## Uruchomienie po instalacji

Uruchom skrót **Scyzoryk Projektowy** z pulpitu albo plik:

```text
Scyzoryk.exe
```

Panel działa lokalnie pod adresem:

```text
http://scyzoryk.localhost:3000
```

Adres `scyzoryk.localhost` działa od razu, bez żadnej konfiguracji — domena
`.localhost` jest zarezerwowana (RFC 6761) i każda przeglądarka oraz sam Windows
rozwiązują ją bezpośrednio do tego komputera, bez wpisu w pliku `hosts` i bez
uprawnień administratora.

Każdy moduł działa jako osobny proces. Dłuższe zadanie w jednym narzędziu nie powinno blokować pozostałych.

## Wymagania użytkownika końcowego

- Windows 10 lub Windows 11 x64,
- Microsoft Word dla Dokumentów seryjnych i Wniosków powykonawczych,
- drukarka dla funkcji drukowania,
- pliki z Dysku Google dostępne offline (dla narzędzi pracujących na folderach adresów),
- internet dla Doborów myEcodan/Varmero (zewnętrzne formularze) oraz dla OCR audytów, jeśli używasz automatycznego rozpoznawania (Gemini/OpenAI) — tryb ręczny OCR działa całkowicie offline.

Instalacja sama w sobie **nie wymaga internetu** — nic nie jest pobierane podczas instalowania. Nie jest też wymagane ręczne instalowanie Node.js, npm, Playwrighta ani Chromium.

## Działanie lokalne i dane

Panel oraz wszystkie narzędzia nasłuchują wyłącznie lokalnie na `127.0.0.1`.

Większość operacji odbywa się w całości na komputerze użytkownika, bez łączenia się z internetem. Wyjątki:

- **OCR audytów** — jeśli wybierzesz automatyczne rozpoznawanie tekstu, strony wymagające analizy są wysyłane do wybranego przez Ciebie dostawcy (Google Gemini albo OpenAI, w zależności od tego, jaki klucz API wpiszesz). Tryb **ręczny** (bez AI) nie wysyła nigdzie żadnych danych.
- **Dobory myEcodan** i **Dobory Varmero** komunikują się z zewnętrznymi systemami formularzy tych producentów.

Żadna z aplikacji nie zawiera wbudowanego, zaszytego w instalatorze klucza/sekretu do usług zewnętrznych — każdy klucz API jest wpisywany ręcznie przez użytkownika i trzymany lokalnie na jego komputerze.

Dane runtime, ustawienia i zapisane wzory znajdują się domyślnie w:

```text
%LOCALAPPDATA%\ScyzorykProjektowy\Data
```

## Rozwój ze źródeł

Ta część dotyczy wyłącznie osób rozwijających projekt, a nie użytkowników instalatora.

Wymagania deweloperskie:

- Git,
- Node.js 22 LTS lub 24 LTS (Node 18/20 są już nieaktualne — bez wsparcia bezpieczeństwa; sprawdź aktualny status na [nodejs.org](https://nodejs.org/en/about/previous-releases)),
- npm,
- Microsoft Word do testów funkcji Word COM,
- Inno Setup 6 do lokalnego budowania instalatora Windows,
- .NET SDK 8 do budowania natywnego launchera (`launcher/Scyzoryk.Launcher`).

Podstawowe komendy:

```powershell
npm run install-all
npm run check
npm run test:regressions
npm run security-smoke
npm run start
```

Budowanie instalatora:

```powershell
npm run build-installer
```

Buduje oba warianty instalatora (pełny i aktualizacyjny) bez żadnego wbudowanego sekretu — OCR audytów działa od razu w trybie ręcznym, a automatyczne rozpoznawanie (Gemini/OpenAI) wymaga klucza API wpisanego przez użytkownika po instalacji. Publiczne wydania (`vX.Y.Z` na [Releases](../../releases)) są budowane automatycznie przez `.github/workflows/release-public-installer.yml` po wypchnięciu tagu.

## Dokumentacja

- [Instrukcja instalacji i obsługi](docs/INSTRUKCJA-INSTALACJI.md)
- [Techniczne wyjaśnienie działania projektu](docs/TECHNICZNE_DZIALANIE.md)
- [System wyglądu interfejsu](docs/UI-DESIGN-SYSTEM.md)
- [Wskazówki dla Claude Code i osób rozwijających projekt](CLAUDE.md)

---

<p align="center">
  <strong>Scyzoryk Projektowy</strong><br>
  Mniej ręcznych czynności. Więcej czasu na właściwą dokumentację.
</p>
