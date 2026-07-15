# Konwencje kodu specyficzne dla tego projektu

## Kodowanie polskich znaków
- Pliki `.ps1`: zapisywane jako UTF-8 bez BOM. Skrypty, które mają wypisywać
  polski tekst na stdout w trybie potoku (nie interaktywnej konsoli), MUSZĄ na
  początku ustawić `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)`
  — inaczej PowerShell 5.1 używa systemowej strony kodowej i psuje znaki
  (np. "Mały" → "Ma?y"). Ten preambuł jest już wymuszany globalnie w
  `lib/hardening.js` → `buildPowerShellCommand()` dla wywołań w trybie `-Command`.
- Komentarze w `.ps1` w tym repo są celowo pisane BEZ polskich znaków (ASCII: "recznie"
  zamiast "ręcznie") — nie jest to błąd, to świadoma konwencja zmniejszająca ryzyko
  mojibake przy edycji przez różne narzędzia.

## Izolacja sesji użytkownika (wielu ludzi naraz, bez logowania)
Wzorzec z `apps/drukarka-projekty/lib/sessionStore.js`, skopiowany też do
`apps/drukarka`: middleware ustawia ciasteczko `scyzoryk_sid` (HttpOnly), trzyma
`Map<sid, {data, lastActivity}>` w pamięci procesu, `req.session` wskazuje na
per-użytkownikowy obiekt stanu (kolejka druku, status). Czyszczenie nieaktywnych
sesji przez `setInterval`. Używać tego wzorca dla każdej nowej funkcji wymagającej
stanu per-użytkownik zamiast zmiennych globalnych modułu.

## Dopasowywanie nazw kolumn Excela (arkusze robione ręcznie przez ludzi)
Nigdy nie zakładać dokładnej nazwy kolumny. Wzorzec fuzzy-matching:
najpierw dokładne dopasowanie (po lowercase + strip diakrytyków + trim), potem
częściowe (substring). WAŻNE: wzorce-kandydaci muszą być na tyle specyficzne, żeby
nie kolidować z innymi polami o podobnej nazwie (np. samo "numer" jako wzorzec
fałszywie łapie "Numer działki"/"Nr telefonu" zamiast kolumny z numerem porządkowym
wiersza — używać "lp"/"id projektu", nie gołego "nr"/"numer"). Przy dopasowywaniu
kilku pól na raz (numer/adres/gmina) trzeba wykluczać już przypisaną kolumnę z
dalszego wyszukiwania, inaczej ta sama kolumna może zostać złapana dwa razy
(np. "LP gmina" jako i numer, i gmina, bo zawiera oba słowa).
Referencyjna implementacja: `findColumnFuzzy`/`guessColumns` w
`apps/dokumenty-seryjne/src/folderGeneration.js`.

## Dopasowywanie wariantów dokumentów (moc/model/rozmiar zestawu)
Nie parsować jednego, konkretnego formatu tekstu (Excel bywa "2/300",
"x250L/3,2kW", "2.300" — różne inwestycje, różne konwencje). Zamiast tego:
wyciągnąć ciągi cyfr z obu stron (`match(/\d+/g)`) i sprawdzić czy WSZYSTKIE cyfry
wariantu występują wśród cyfr tekstu komórki — działa niezależnie od separatora.
Referencyjna implementacja: `textContainsVariant` w
`apps/dokumenty-seryjne/src/templateScan.js` (tam też: `classifyTemplates` —
rozpoznawanie TYPU dokumentu po wzorcu nazwy, niezależnie od tego czy wariant
mocy/modelu koduje przyrostek nazwy pliku, czy nazwa podfolderu — oba mechanizmy
występują w prawdziwych danych, czasem nawet w tej samej inwestycji).

## Bezpieczeństwo / higiena (już wdrożone, nie duplikować)
- Nagłówki bezpieczeństwa + CSP + rate-limit: `lib/hardening.js`, stosowane
  identycznie w każdym `apps/*/server.js`.
- POST/PUT/DELETE wymagają nagłówka `X-Scyzoryk-Request: 1` (prosta ochrona przed
  CSRF z zewnętrznych stron) — sprawdzane middleware'em przed `express.json()`.
- Nazwy plików z dysku sanityzowane przed użyciem w ścieżkach/nagłówkach
  (`Content-Disposition` buduje osobno ASCII fallback + `filename*=UTF-8''...`,
  bo surowe polskie znaki w nagłówkach HTTP wywalają wyjątek Node'a).
