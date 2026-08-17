# Instrukcja instalacji i obsługi Scyzoryka Projektowego

Ta instrukcja opisuje aktualną wersję Scyzoryka instalowaną jednym plikiem EXE.
Użytkownik końcowy nie pobiera repozytorium, nie instaluje Node.js i nie ustawia ręcznie OCR.

Ta sama instrukcja jest dostępna po uruchomieniu programu pod adresem:

```text
http://scyzoryk.localhost:3000/instrukcja.html
```

oraz przez przycisk **Pomoc** na panelu głównym.

## 1. Co jest potrzebne

- Windows 10 lub Windows 11 w wersji 64-bitowej,
- połączenie z internetem podczas instalacji,
- połączenie z internetem podczas korzystania z OCR audytów i Formularzy Ecodan,
- Microsoft Word dla narzędzi **Dokumenty seryjne PDF** i **Wnioski powykonawcze PDF**,
- dostęp do używanej drukarki,
- pliki z Dysku Google ustawione jako dostępne offline.

Nie jest wymagane instalowanie:

- Node.js,
- npm,
- Playwrighta,
- Chromium,
- Pythona,
- klucza Google Document AI.

Gotowy instalator zawiera przenośny Node.js, a podczas instalacji pobiera wymagane zależności i Chromium. Wewnętrzna wersja instalatora zawiera również gotową konfigurację Google Document AI.

## 2. Pobranie właściwego instalatora

1. Otwórz repozytorium na GitHubie.
2. Przejdź do zakładki **Actions**.
3. Uruchom workflow **Zbuduj gotowy instalator Windows z OCR**.
4. Poczekaj, aż przejdą oba joby:
   - **Zbuduj instalator**,
   - **Świeża instalacja i pełne testy**.
5. Pobierz artefakt:

```text
Scyzoryk-Projektowy-gotowy-Windows-z-OCR
```

6. Rozpakuj ZIP i uruchom plik `ScyzorykProjektowy-Setup-....exe`.

Finalny artefakt jest publikowany dopiero po zainstalowaniu go na świeżym runnerze Windows, uruchomieniu wszystkich modułów, wykonaniu testów regresyjnych, zrzutów ekranów oraz prawdziwego testu Google Document AI.

> Instalator zawiera wewnętrzną konfigurację OCR. Traktuj go jako plik poufny i nie udostępniaj publicznie.

## 3. Instalacja

1. Uruchom instalator EXE.
2. Przejdź przez kreator instalacji.
3. Pozostaw zaznaczoną opcję utworzenia ikony na pulpicie.
4. Autostart przy logowaniu jest opcjonalny (nie wymaga żadnego dodatkowego okna ani uprawnień administratora).
5. Poczekaj, aż instalator doinstaluje składniki. Nie zamykaj instalatora w trakcie tego kroku.
6. Po zakończeniu uruchom Scyzoryk.

Domyślny folder programu:

```text
%LOCALAPPDATA%\Programs\ScyzorykProjektowy
```

Dane użytkownika, ustawienia, wzory i pliki robocze są przechowywane oddzielnie:

```text
%LOCALAPPDATA%\ScyzorykProjektowy\Data
```

## 4. Uruchomienie

Uruchom skrót **Scyzoryk Projektowy** z pulpitu albo plik:

```text
Scyzoryk.exe
```

Panel otworzy się pod adresem:

```text
http://scyzoryk.localhost:3000
```

Ten adres działa automatycznie, bez żadnej konfiguracji ani uprawnień
administratora (domena `.localhost` zawsze wskazuje na ten komputer).

Status **gotowe** na kafelku oznacza, że narzędzie działa. Jeżeli przez dłuższy czas widoczny jest status uruchamiania lub restartu, zamknij Scyzoryk i uruchom ponownie skrótem.

## 5. Zasady bezpiecznej pracy

- Przed pracą na całej inwestycji wykonaj próbę na jednym adresie.
- Pliki z Dysku Google muszą być dostępne offline.
- Nie przenoś wzorów Worda i Excela podczas trwającego zadania.
- Przed drukiem sprawdź kolejność, drukarkę, kopie oraz tryb jednostronny lub dwustronny.
- Nie uruchamiaj dwóch serii drukowania jednocześnie.
- Nie usuwaj ręcznie folderu danych użytkownika, jeśli zawiera potrzebne wzory lub wyniki.

## 6. Drukarka dokumentów

1. Kliknij **Dodaj pliki** albo przeciągnij pliki PDF, DOC lub DOCX.
2. Ułóż kolejność dokumentów.
3. Wybierz drukarkę.
4. Ustaw liczbę kopii.
5. Wybierz druk jednostronny lub dwustronny.
6. Wybierz układ kopii.
7. Kliknij **Drukuj**.

Scyzoryk nie powinien zamykać ani minimalizować prywatnych dokumentów Worda użytkownika. Po serii przywraca wcześniejszy tryb duplex drukarki.

## 7. Drukarka projektów

### Projekty z arkusza Excel

1. Wybierz tryb **Drukuj projekty**.
2. Wgraj Excel inwestycji i wybierz arkusz.
3. Zaznacz adresy bez odbioru i bez rezygnacji.
4. Wklej ścieżkę folderu bazowego.
5. Kliknij **Znajdź projekty**.
6. Sprawdź proponowaną kolejność dokumentów.
7. Ręcznie sprawdź pozycje oznaczone jako wariant, niedopasowane albo dopasowane po kolejności.
8. Zatwierdź kolejność i wydrukuj.

### Wnioski materiałowe WM

1. Wybierz **Drukuj wnioski materiałowe (WM)**.
2. Wskaż folder WM jednego adresu.
3. Opcjonalnie zaznacz wersję powykonawczą `dok.pod`.
4. Zeskanuj folder, sprawdź wyniki i wydrukuj.

## 8. Dokumenty seryjne PDF

1. Wybierz cały folder z szablonami DOCX.
2. Zaznacz rodzaje dokumentów do wygenerowania.
3. Dodaj tabelę Excel.
4. Kliknij **Sprawdź dane**.
5. Wybierz arkusz z odpowiednią mocą.
6. Jeśli dokumenty mają warianty, wybierz kolumnę wariantu.
7. Zaznacz adresy.
8. Ustaw opcjonalny przedrostek nazwy pliku.
9. Kliknij **Utwórz PDF-y**.
10. Pobierz pojedyncze pliki albo ZIP.

Microsoft Word musi być zainstalowany i aktywowany.

## 9. Wnioski powykonawcze PDF

### Tryb ręczny

1. Wybierz **Wgraj pliki ręcznie**.
2. Dodaj pliki DOCX.
3. Ustaw datę albo miesiąc i rok.
4. Ustaw przedrostek nazwy.
5. Kliknij **Utwórz PDF-y**.

### Cały folder WM

1. Wybierz **Cały folder WM (automatycznie)**.
2. Wklej ścieżkę folderu.
3. Ustaw datę i przedrostek.
4. Kliknij **Skanuj folder**.
5. Sprawdź znalezione kategorie.
6. Kliknij **Przerób zaznaczone i zapisz w folderach**.

## 10. Dobory myEcodan

1. Dodaj Excel inwestycji.
2. Uzupełnij nazwę inwestycji.
3. Ustaw globalną lokalizację lub kod pocztowy.
4. Zaznacz adresy do wygenerowania.
5. Pozostaw zaznaczone **Pomiń już gotowe raporty**, jeżeli istniejących raportów nie trzeba generować ponownie.
6. Kliknij **Start generowania PDF**.
7. Po zakończeniu pobierz ZIP.

### Ważna reguła Ecodan

Każdy raport wynikowy zawiera wyłącznie pierwsze trzy strony, ponieważ tylko one są potrzebne. Dotyczy to:

- nowo wygenerowanych raportów,
- istniejących raportów wykrytych przez `skipExisting`,
- raportów umieszczanych w ZIP-ie.

Dokument mający jedną lub dwie strony pozostaje odpowiednio jedno- lub dwustronicowy.

## 11. Pieczątki PDF

1. Wybierz jeden albo kilka plików PDF.
2. Wczytaj preset albo kliknij **Dodaj**.
3. Ustaw pieczątkę, zakres stron, rozmiar i pozycję.
4. Sprawdź podgląd.
5. Kliknij **Dodaj pieczątki i pobierz**.
6. Często używane ustawienia zapisz jako preset.

## 12. Karty katalogowe

1. Wybierz Excel z arkuszami `Solary {gmina}`.
2. Wklej ścieżkę głównego folderu Kolektory.
3. Kliknij **Sprawdź tabelę**.
4. Sprawdź dopasowania UID, folderów i adresów.
5. Kliknij **Uruchom dobór kart**.

## 13. OCR audytów

1. Dodaj zeskanowane PDF-y.
2. Kliknij **Rozpoznaj tekst**.
3. Sprawdź podział na adresy.
4. Wybierz rodzinę dokumentów: Pompy ciepła, Solary albo Kotły.
5. W razie potrzeby wybierz wzór gminy.
6. Uzupełnij niepewne pola. Jeśli pole jest puste w oryginale, kliknij **Brak w oryginale**.
7. Opcjonalnie podaj ścieżkę nowego pliku Excel.
8. Kliknij **Zapisz i pobierz**.

W gotowym instalatorze OCR działa bez ręcznego ustawiania klucza. Strony wymagające rozpoznania są wysyłane do Google Document AI, dlatego wymagają internetu i generują koszt usługi.

## 14. Najczęstsze problemy

| Problem | Rozwiązanie |
|---|---|
| Kafelek nie przechodzi na status „gotowe” | Uruchom Scyzoryk ponownie skrótem z pulpitu. |
| Word nie tworzy PDF | Sprawdź instalację i aktywację Worda oraz dostępność pliku offline. |
| Nie znaleziono pliku na Dysku Google | Ustaw plik lub folder jako dostępny offline. |
| Drukowanie jest zajęte | Poczekaj na zakończenie serii w innym module lub karcie. |
| OCR nie odpowiada | Sprawdź internet. Gotowy instalator nie wymaga ręcznego ustawiania klucza. |
| Ecodan ma tylko trzy strony | To prawidłowe i wymagane działanie. |
| Niepewny dokument projektu nie został zaznaczony | Sprawdź podgląd i zaznacz go ręcznie. |

## 15. Aktualizacja

Nie aktualizuj komputera użytkownika przez pobieranie ZIP-a repozytorium.

1. Uruchom ponownie workflow **Zbuduj gotowy instalator Windows z OCR** na właściwym branchu.
2. Pobierz nowy przetestowany artefakt.
3. Uruchom nowy instalator na komputerze użytkownika.

Instalator wykona ponowną instalację. Dane użytkownika znajdują się poza katalogiem programu.
