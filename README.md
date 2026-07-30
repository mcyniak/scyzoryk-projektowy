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
| 📋 **Formularze Ecodan** | Pobiera dane z Excela, automatycznie wypełnia formularze i zapisuje raporty PDF. Wynik zachowuje wyłącznie pierwsze trzy potrzebne strony. |
| 📄 **Dokumenty seryjne PDF** | Łączy folder wzorów Worda z tabelą Excel i tworzy osobne dokumenty dla wybranych adresów i wariantów. |
| 📝 **Wnioski powykonawcze PDF** | Zamienia wnioski materiałowe Word na dokumentację powykonawczą pojedynczo albo dla całego folderu WM. |
| 📚 **Karty katalogowe** | Dobiera właściwe karty urządzeń według UID z Excela i kopiuje je do odpowiednich folderów klientów. |
| 🔎 **OCR audytów** | Odczytuje skany, także z odręcznymi wpisami, tworzy przeszukiwalne PDF-y, dzieli pliki na adresy i przenosi sprawdzone dane do Excela. |

## Instalacja dla użytkownika końcowego

Użytkownik końcowy nie powinien pobierać repozytorium ani ręcznie instalować Node.js.

1. W GitHub Actions uruchom workflow **Zbuduj gotowy instalator Windows z OCR**.
2. Poczekaj, aż zakończą się joby **Zbuduj instalator** oraz **Świeża instalacja i pełne testy**.
3. Pobierz artefakt:

```text
Scyzoryk-Projektowy-gotowy-Windows-z-OCR
```

4. Rozpakuj artefakt i uruchom `ScyzorykProjektowy-Setup-....exe`.

Gotowy instalator:

- zawiera przenośny Node.js,
- instaluje wymagane zależności i Chromium,
- zawiera wewnętrzną konfigurację Google Document AI,
- po instalacji nie wymaga ustawiania OCR przez odbiorcę,
- jest publikowany dopiero po teście na świeżym Windowsie.

> Instalator z OCR zawiera poufne dane konta serwisowego i jest przeznaczony wyłącznie do użytku wewnętrznego.

Pełna instrukcja: [`docs/INSTRUKCJA-INSTALACJI.md`](docs/INSTRUKCJA-INSTALACJI.md).

Po instalacji ta sama instrukcja jest dostępna z przycisku **Pomoc** na panelu głównym lub pod adresem:

```text
http://127.0.0.1:3000/instrukcja.html
```

## Uruchomienie po instalacji

Uruchom skrót **Scyzoryk Projektowy** z pulpitu albo plik:

```text
Uruchom-Scyzoryk.cmd
```

Panel działa lokalnie pod adresem:

```text
http://127.0.0.1:3000
```

Każdy moduł działa jako osobny proces. Dłuższe zadanie w jednym narzędziu nie powinno blokować pozostałych.

## Wymagania użytkownika końcowego

- Windows 10 lub Windows 11 x64,
- internet podczas instalacji,
- Microsoft Word dla Dokumentów seryjnych i Wniosków powykonawczych,
- drukarka dla funkcji drukowania,
- pliki z Dysku Google dostępne offline,
- internet podczas OCR audytów i Formularzy Ecodan.

Nie jest wymagane ręczne instalowanie Node.js, npm, Playwrighta, Chromium ani konfiguracji OCR.

## Działanie lokalne i dane

Panel oraz narzędzia nasłuchują wyłącznie lokalnie na `127.0.0.1`.

Większość operacji odbywa się na komputerze użytkownika. Wyjątkiem jest **OCR audytów**, który wysyła strony wymagające rozpoznania do Google Cloud Document AI. Formularze Ecodan komunikują się z zewnętrznym systemem formularzy.

Dane runtime, ustawienia i zapisane wzory znajdują się domyślnie w:

```text
%LOCALAPPDATA%\ScyzorykProjektowy\Data
```

## Rozwój ze źródeł

Ta część dotyczy wyłącznie osób rozwijających projekt, a nie użytkowników instalatora.

Wymagania deweloperskie:

- Git,
- Node.js 18 lub nowszy,
- npm,
- Microsoft Word do testów funkcji Word COM,
- Inno Setup 6 do lokalnego budowania instalatora Windows.

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

Bez czterech zmiennych `OCR_DOCAI_*` powstanie instalator deweloperski bez wbudowanej konfiguracji OCR. Poufny instalator gotowy dla pracowników powinien być budowany przez właściwy workflow GitHub Actions z sekretem `OCR_DOCAI_CREDENTIALS_B64`.

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
