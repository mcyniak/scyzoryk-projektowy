# OCR audytów

Rozpoznaje tekst (w tym pismo ręczne) na zeskanowanych PDF-ach audytów i zwraca ten sam dokument
z niewidoczną, przeszukiwalną/zaznaczalną warstwą tekstu - oryginalny wygląd (w tym odręczne
notatki) zostaje bez zmian. Jeśli w jednym pliku jest kilka adresów (zbundlowany skan), narzędzie
proponuje podział na osobne pliki - ale nigdy nie dzieli automatycznie bez przeglądu: zawsze
pokazuje ekran potwierdzenia z miniaturami stron.

## Wymagana konfiguracja (Google Cloud Document AI)

To jedyna aplikacja w Scyzoryku, która łączy się z internetem - wysyła zawartość strony do
rozpoznania przez [Google Cloud Document AI](https://cloud.google.com/document-ai) (procesor typu
Form Parser). Powód: lokalne silniki OCR (Tesseract, PaddleOCR) i nawet Google Cloud Vision,
testowane na realnych audytach, słabo radziły sobie z odręcznymi wpisami i checkboxami w tych
formularzach - Document AI rozpoznaje checkbox jako własny typ bytu i sam paruje go z etykietą,
zamiast zwracać losowy znak Unicode do ręcznego dopasowania.

Instalator celowo nie zawiera klucza konta serwisowego. Skopiuj
`docs/ocr-document-ai.example.json` jako
`%LOCALAPPDATA%\Scyzoryk\ocr-document-ai.json`, uzupełnij wartości i ustaw
`keyFile` na bezpieczną lokalizację klucza poza katalogiem programu.

Alternatywnie ustaw 4 zmienne środowiskowe:

- `OCR_DOCAI_KEY_FILE` - ścieżka do pliku JSON konta serwisowego GCP (uprawnienia: Document AI API
  User na projekt z utworzonym procesorem). **Nigdy nie kopiować tego pliku do repo** - trzymać go
  poza katalogiem projektu i wskazywać ścieżką.
- `OCR_DOCAI_PROJECT_ID` - id projektu GCP (np. `scyzoryk-ocr-test`).
- `OCR_DOCAI_LOCATION` - region procesora (np. `eu`).
- `OCR_DOCAI_PROCESSOR_ID` - id utworzonego procesora typu Form Parser (Google Cloud Console →
  Document AI → Processors → utwórz procesor, skopiuj jego ID).

Bez tych zmiennych analiza plików, które faktycznie wymagają OCR-u, zwróci czytelny błąd zamiast
się wywalić - pliki, które już mają warstwę tekstu (np. eksporty z aplikacji), działają bez
żadnej z tych zmiennych, bo OCR jest wtedy pomijany całkowicie.

**Dane osobowe z audytów (imię, nazwisko, adres, telefon, e-mail) opuszczają komputer** przy
każdym rozpoznawaniu tekstu - to świadoma decyzja (patrz notatka w `CLAUDE.md`), ale warto o tym
pamiętać przy udostępnianiu tego narzędzia dalej.

Koszt jest znacząco wyższy niż przy poprzednio używanym Google Cloud Vision - ok. $30/1000 stron
(Vision: $1,50/1000 stron) - świadoma decyzja właściciela po realnym porównaniu jakości
rozpoznawania na trudnych formularzach (patrz `src/documentAiEngine.js`).

## Start

Uruchamiane jak każda inna aplikacja w Scyzoryku - przez główny `server.js`/`STARTUJ-SCYZORYK.cmd`
(port domyślnie 3011, `OCR_AUDYTOW_PORT` żeby zmienić), albo samodzielnie:

```powershell
$env:OCR_DOCAI_KEY_FILE = "C:\sciezka\do\klucza-konta-serwisowego.json"
$env:OCR_DOCAI_PROJECT_ID = "twoj-projekt-gcp"
$env:OCR_DOCAI_LOCATION = "eu"
$env:OCR_DOCAI_PROCESSOR_ID = "id-procesora"
node apps/ocr-audytow/server.js
```
