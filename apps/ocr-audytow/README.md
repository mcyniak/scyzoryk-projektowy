# OCR audytów

Rozpoznaje tekst (w tym pismo ręczne) na zeskanowanych PDF-ach audytów i zwraca ten sam dokument
z niewidoczną, przeszukiwalną/zaznaczalną warstwą tekstu - oryginalny wygląd (w tym odręczne
notatki) zostaje bez zmian. Jeśli w jednym pliku jest kilka adresów (zbundlowany skan), narzędzie
proponuje podział na osobne pliki - ale nigdy nie dzieli automatycznie bez przeglądu: zawsze
pokazuje ekran potwierdzenia z miniaturami stron.

## Wymagany klucz API (Google Cloud Vision)

To jedyna aplikacja w Scyzoryku, która łączy się z internetem - wysyła zawartość strony do
rozpoznania przez [Google Cloud Vision](https://cloud.google.com/vision) (`DOCUMENT_TEXT_DETECTION`).
Powód: lokalne silniki OCR (Tesseract, PaddleOCR) testowane na realnych audytach praktycznie nie
czytały odręcznych wpisów w tych formularzach - Vision czyta większość poprawnie, przy okazji
znacznie szybciej.

**Zanim uruchomisz tę aplikację, ustaw zmienną środowiskową `OCR_VISION_API_KEY`** (klucz API
Google Cloud, ograniczony wyłącznie do "Cloud Vision API" w konsoli Google Cloud - patrz
`console.cloud.google.com` → API i usługi → Dane logowania). Bez tego klucza analiza plików zwróci
czytelny błąd zamiast się wywalić.

Opcjonalnie: `OCR_VISION_REGION=eu`, żeby żądania szły przez europejski endpoint
(`eu-vision.googleapis.com`) zamiast domyślnego.

**Dane osobowe z audytów (imię, nazwisko, adres, telefon, e-mail) opuszczają komputer** przy
każdym rozpoznawaniu tekstu - to świadoma decyzja (patrz notatka w `CLAUDE.md`), ale warto o tym
pamiętać przy udostępnianiu tego narzędzia dalej.

Koszt przy typowej skali (dziesiątki-niskie setki stron/miesiąc) jest praktycznie zerowy - Google
Cloud Vision ma darmowy limit 1000 jednostek/miesiąc, cena powyżej limitu to $1,50/1000 stron.

## Start

Uruchamiane jak każda inna aplikacja w Scyzoryku - przez główny `server.js`/`STARTUJ-SCYZORYK.cmd`
(port domyślnie 3011, `OCR_AUDYTOW_PORT` żeby zmienić), albo samodzielnie:

```powershell
$env:OCR_VISION_API_KEY = "twoj-klucz"
node apps/ocr-audytow/server.js
```
