# OCR audytów

Rozpoznaje tekst, w tym pismo ręczne, na zeskanowanych PDF-ach audytów i zwraca dokument z niewidoczną, przeszukiwalną warstwą tekstu. Oryginalny wygląd, pieczątki i odręczne notatki pozostają bez zmian.

Jeżeli jeden PDF zawiera kilka adresów, narzędzie proponuje podział na osobne pliki, ale zawsze pokazuje użytkownikowi miniatury i wymaga potwierdzenia podziału.

## Google Cloud Document AI

OCR korzysta z procesora Google Cloud Document AI typu Form Parser. To jedyna aplikacja Scyzoryka, która wysyła zawartość stron do zewnętrznej usługi w celu rozpoznania tekstu i pól formularza.

Document AI został wybrany po testach na rzeczywistych audytach, ponieważ lepiej niż lokalne silniki i Google Cloud Vision rozpoznaje odręczne wpisy, checkboxy i układ formularzy.

## Gotowy instalator wewnętrzny

Workflow GitHub Actions:

```text
Zbuduj gotowy instalator Windows z OCR
```

buduje poufny instalator, który zawiera gotową konfigurację Document AI. Odbiorca instalatora:

- nie kopiuje klucza,
- nie ustawia zmiennych środowiskowych,
- nie tworzy pliku konfiguracyjnego,
- po instalacji może od razu używać OCR.

Konfiguracja jest dodawana do katalogu staging wyłącznie podczas workflow z GitHub Actions Secret `OCR_DOCAI_CREDENTIALS_B64`. Nie znajduje się w repozytorium ani w zwykłym `git archive`.

Gotowy instalator zawiera dane konta serwisowego, dlatego jest przeznaczony wyłącznie do użytku wewnętrznego i nie może być publikowany publicznie.

## Kolejność odczytu konfiguracji

`src/documentAiEngine.js` sprawdza konfigurację w następującej kolejności:

1. zmienne środowiskowe `OCR_DOCAI_*`,
2. plik użytkownika `%LOCALAPPDATA%\Scyzoryk\ocr-document-ai.json`,
3. konfigurację wbudowaną w instalator: `apps\ocr-audytow\config\document-ai.json`.

Dzięki temu deweloper może nadpisać ustawienia lokalnie, a zwykły użytkownik gotowego instalatora korzysta z konfiguracji wbudowanej.

## Konfiguracja deweloperska

Przy uruchamianiu projektu ze źródeł można utworzyć plik:

```text
%LOCALAPPDATA%\Scyzoryk\ocr-document-ai.json
```

Przykład:

```json
{
  "projectId": "scyzoryk-ocr-test",
  "location": "eu",
  "processorId": "id-procesora",
  "keyFile": "C:\\bezpieczna-sciezka\\service-account.json"
}
```

Alternatywnie można ustawić:

- `OCR_DOCAI_KEY_FILE`,
- `OCR_DOCAI_PROJECT_ID`,
- `OCR_DOCAI_LOCATION`,
- `OCR_DOCAI_PROCESSOR_ID`.

Pliku konta serwisowego nie wolno commitować do repozytorium.

## Prywatność i koszt

Dane widoczne na stronach audytów, w tym imię, nazwisko, adres, telefon lub e-mail, mogą zostać przesłane do Google Document AI podczas rozpoznawania.

Nie należy uruchamiać ponownie tej samej dużej paczki bez potrzeby. Każda strona faktycznie wymagająca OCR zużywa limit i może generować koszt usługi.

Strony, które mają już użyteczną warstwę tekstową, są rozpoznawane osobno i nie powinny być ponownie wysyłane do OCR.

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

Dla gotowego instalatora pole `ocrConfigured` powinno mieć wartość `true` bez wykonywania dodatkowych czynności po instalacji.
