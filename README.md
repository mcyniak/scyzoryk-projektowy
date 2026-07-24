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

**Scyzoryk Projektowy** to zestaw prostych narzędzi uruchamianych z jednego panelu w przeglądarce. Powstał po to, aby ograniczyć ręczne, powtarzalne czynności związane z przygotowaniem dokumentacji, drukowaniem, porządkowaniem plików oraz przepisywaniem danych.

Zamiast otwierać wiele programów, wyszukiwać pliki w folderach i wykonywać te same kroki dla każdego adresu, użytkownik wybiera odpowiednie narzędzie i prowadzi zadanie przez czytelny formularz.

> Scyzoryk nie zastępuje pracy projektanta. Automatyzuje czynności techniczne i organizacyjne, aby więcej czasu zostało na właściwą pracę projektową.

## Co daje w praktyce?

- mniej ręcznego przepisywania danych,
- szybsze przygotowywanie powtarzalnych dokumentów,
- właściwa kolejność plików podczas drukowania,
- mniej pomyłek przy dobieraniu dokumentacji do adresu,
- łatwiejsze przetwarzanie większej liczby lokalizacji,
- jeden punkt dostępu do wszystkich firmowych narzędzi,
- możliwość rozwijania kolejnych automatyzacji bez tworzenia osobnego programu od zera.

## Dostępne narzędzia

| Narzędzie | Do czego służy |
|---|---|
| 🖨️ **Drukarka** | Pozwala dodać wiele dokumentów, ustawić ich kolejność, liczbę kopii oraz sposób drukowania, a następnie uruchomić całą paczkę. |
| 🗂️ **Drukarka projekty** | Wyszukuje dokumenty projektu, układa je w odpowiedniej kolejności i przygotowuje do druku na podstawie danych inwestycji. Obsługuje również dokumentację WM. |
| 🧾 **Pieczątki PDF** | Dodaje przygotowaną pieczątkę tekstową do plików PDF bez ręcznego otwierania i poprawiania każdej strony. |
| 📋 **Formularze Ecodan** | Pobiera dane z Excela i automatycznie przygotowuje formularze w zewnętrznym systemie, ograniczając ręczne przepisywanie informacji. |
| 📄 **Dokumenty seryjne PDF** | Łączy dane z Excela, wzory Worda oraz informacje z folderu inwestycji i tworzy osobne dokumenty dla kolejnych adresów. |
| 📝 **Wnioski powykonawcze PDF** | Zamienia przygotowane wnioski materiałowe na dokumentację powykonawczą — pojedynczo albo dla całego folderu. |
| 📚 **Karty katalogowe** | Dobiera właściwe karty urządzeń na podstawie danych z Excela i kopiuje je do odpowiednich folderów klientów. |
| 🔎 **OCR audytów** | Odczytuje zeskanowane audyty, również z odręcznymi wpisami, tworzy PDF-y z możliwym wyszukiwaniem tekstu, pomaga dzielić zbiorcze skany na adresy oraz przenosić sprawdzone dane do Excela. |

## Jak wygląda codzienna praca?

```text
1. Uruchamiasz Scyzoryk jednym plikiem.
2. W przeglądarce wybierasz potrzebne narzędzie.
3. Wskazujesz pliki, folder inwestycji albo arkusz Excel.
4. Sprawdzasz podsumowanie i uruchamiasz zadanie.
5. Pobierasz lub drukujesz gotowy wynik.
```

Każde narzędzie działa niezależnie. Jeżeli jedno wykonuje dłuższe zadanie, pozostałe nadal mogą być używane.

## Przykładowe zastosowania

### Przygotowanie dokumentacji dla wielu adresów

Wskazujesz folder inwestycji i arkusz z danymi. Scyzoryk odnajduje wzory, dopasowuje dodatkowe dane techniczne i tworzy osobny komplet dokumentów dla każdej lokalizacji.

### Drukowanie projektu

Zamiast ręcznie otwierać kolejne PDF-y i pilnować ich kolejności, wybierasz inwestycję. Program odnajduje dokumenty, układa je zgodnie z przyjętymi zasadami i przekazuje do drukarki.

### Odczyt zeskanowanych audytów

Wgrywasz skan PDF. Program rozpoznaje druk i pismo ręczne, pozwala sprawdzić wykryte dane, a następnie tworzy przeszukiwalny dokument i — w razie potrzeby — osobne pliki dla kolejnych adresów.

## Uruchomienie

### Najprostszy sposób

Uruchom plik:

```text
STARTUJ-SCYZORYK.cmd
```

Skrypt przygotuje potrzebne składniki, sprawdzi projekt i uruchomi panel. Następnie otwórz:

```text
http://127.0.0.1:3000
```

Instalacja od zera na nowym komputerze (pobranie z GitHuba, wymagania, zrzuty ekranu
każdego narzędzia): [`docs/INSTRUKCJA-INSTALACJI.md`](docs/INSTRUKCJA-INSTALACJI.md).

### Wymagania

- komputer z systemem **Windows**,
- **Microsoft Word** dla narzędzi generujących dokumenty Word/PDF,
- Node.js w wersji 18 lub nowszej albo przygotowana wersja przenośna,
- dostęp do drukarki i programów PDF dla funkcji drukowania,
- dostęp do Google Cloud Document AI dla narzędzia OCR audytów.

## Gdzie działają dokumenty?

Panel i narzędzia są uruchamiane lokalnie na komputerze użytkownika. Nie wymagają publicznego serwera ani konta użytkownika.

Większość operacji odbywa się wyłącznie lokalnie. **Wyjątkiem jest OCR audytów**, który podczas rozpoznawania tekstu korzysta z Google Cloud Document AI i przesyła do tej usługi strony wybrane do analizy. Pozostałe narzędzia nie wysyłają dokumentów do zewnętrznych usług.

## Status projektu

Projekt jest rozwijany na podstawie rzeczywistych dokumentów i sposobu pracy działu projektowego. Nowe funkcje są dodawane etapami i sprawdzane na prawdziwych inwestycjach.

Możliwe są różnice pomiędzy folderami, wzorami dokumentów oraz sposobem nazewnictwa w poszczególnych inwestycjach. Dlatego przed szerszym użyciem nowej funkcji warto sprawdzić ją na kilku reprezentatywnych przykładach.

## Dokumentacja

- [⚙️ Techniczne wyjaśnienie działania projektu](docs/TECHNICZNE_DZIALANIE.md)
- [🤖 Wskazówki dla Claude Code i osób rozwijających projekt](CLAUDE.md)

---

<p align="center">
  <strong>Scyzoryk Projektowy</strong><br>
  Mniej ręcznych czynności. Więcej czasu na właściwą dokumentację.
</p>
