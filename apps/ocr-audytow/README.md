# OCR audytów

Rozpoznaje tekst i pismo ręczne na zeskanowanych PDF-ach audytów, dzieli zbundlowane pliki na osobne adresy (po potwierdzeniu przez użytkownika) i wyciąga wartości pól formularza do tabelki, którą można zapisać jako Excel. Oryginalny wygląd, pieczątki i odręczne notatki pozostają bez zmian - wyjściowe PDF-y to zwykłe kopie oryginalnych stron.

Jeżeli jeden PDF zawiera kilka adresów, narzędzie proponuje podział na osobne pliki, ale zawsze pokazuje użytkownikowi miniatury i wymaga potwierdzenia podziału.

## Dostawcy rozpoznawania

Ekstrakcja pól idzie przez wspólny router `src/aiProvider.js` (dodany 2026-08-19) - reszta aplikacji
(łącznie z `server.js`) importuje wyłącznie ten moduł, nigdy konkretny silnik wprost, więc zmiana
dostawcy nie dotyka żadnego innego pliku. Trzy dostępne opcje:

- **Google Gemini** (`src/geminiFieldEngine.js`) - domyślny dostawca.
- **OpenAI** (`src/openaiFieldEngine.js`, Responses API + Structured Outputs) - dodany 2026-08-19 jako
  druga opcja, bo darmowy limit Gemini (20 zapytań) realnie blokował przetwarzanie większych paczek, a
  firma ma praktycznie nielimitowany dostęp do API OpenAI. Prompt/logika pól są wspólne z Gemini
  (`src/aiEngineShared.js`) - każdy plik silnika zawiera tylko to, co specyficzne dla danego API.
- **Ręcznie (bez AI)** - dodany tego samego dnia, bez osobnego pliku silnika (obsłużony wprost w
  `aiProvider.js`, logika za prosta na osobny moduł): żaden klucz, żadne zapytanie sieciowe - wszystkie
  pola startują puste (`needsReview: true`) i użytkownik wpisuje wartości sam, patrząc na duży,
  przybliżalny podgląd strony obok tabeli pól.

Który dostawca oba Gemini/OpenAI - model dostaje cały blok dokumentu (zakres stron jednego adresu) naraz i
sam semantycznie przypisuje wartości do schematu pól (`src/fieldExtraction.js`'s `FIELD_DEFS`), bez
własnej logiki geometrycznego dopasowania etykieta→wartość. Aktywny dostawca jest zapisany w
`%LOCALAPPDATA%\Scyzoryk\ai-provider.json` - zapisanie nowego klucza API automatycznie ustawia jego
dostawcę jako aktywnego.

Gemini zastąpił 2026-08-12 wcześniejszy silnik (Google Cloud Document AI, Form Parser) po teście porównawczym na realnych audytach: stary silnik zostawiał 76% pól pustych i potrafił po cichu wsadzić wartość w złe pole (dopasowanie geometryczne "najbliższa etykieta"), Gemini zostawiał ~18% pustych bez tej klasy błędów - patrz git history dla poprzedniej wersji tego pliku i `documentAiEngine.js`/`templateEngine.js`, jeśli kiedyś potrzebne do wglądu.

Ta migracja usunęła też funkcję niewidocznej, przeszukiwalnej warstwy tekstu (dawny `buildOcrPdf`) - świadoma decyzja właściciela, bo to była jedyna pozostała przyczyna trzymania Document AI w tej apce. Wyjściowy PDF to od tej migracji zwykła kopia stron oryginału (`pdf-lib` `copyPages`, bez rasteryzacji).

## Konfiguracja klucza API

Każdy silnik AI sprawdza swój klucz API w następującej kolejności:

1. zmienna środowiskowa (`GEMINI_API_KEY` albo `OPENAI_API_KEY`),
2. plik użytkownika `%LOCALAPPDATA%\Scyzoryk\gemini-api-key.json` albo `...\openai-api-key.json` (patrz `docs/gemini-api-key.example.json`) - oba pliki mogą współistnieć niezależnie, aktywny jest tylko jeden dostawca naraz.

Tryb ręczny nie potrzebuje żadnego klucza.

Zwykły użytkownik wpisuje klucz ręcznie w samej aplikacji (ekran "Rozpoznawanie tekstu nie jest jeszcze skonfigurowane" przy pierwszym uruchomieniu, z wyborem dostawcy) - trafia do pliku użytkownika powyżej. Żaden instalator nigdy nie zawiera wbudowanego klucza (w odróżnieniu od dawnego Document AI, który miał osobny, poufny wariant instalatora z wbudowanym sekretem kontem serwisowego - ten wariant nie istnieje już w ogóle, bo nie ma czego bakować: jeden krótki string zamiast pliku JSON konta serwisowego).

Klucza API nie wolno commitować do repozytorium.

## Prywatność i koszt

W trybie Gemini/OpenAI dane widoczne na stronach audytów, w tym imię, nazwisko, adres, telefon lub e-mail, są przesyłane do wybranego dostawcy podczas rozpoznawania. Tryb ręczny (bez AI) nie wysyła nigdzie żadnych danych.

Nie należy uruchamiać ponownie tej samej dużej paczki bez potrzeby - każdy blok (adres) to jedno zapytanie do wybranego dostawcy i może generować koszt usługi.

## Start

W normalnej pracy aplikacja jest uruchamiana przez główny panel Scyzoryka na porcie 3011.

Uruchomienie samodzielne ze źródeł:

```powershell
node apps/ocr-audytow/server.js
```

Health check:

```text
http://127.0.0.1:3011/api/health
```

Pole `ocrConfigured` ma wartość `true` dopiero po ręcznym wpisaniu klucza API Gemini (albo ustawieniu `GEMINI_API_KEY`) - żaden instalator nie ustawia go automatycznie.
