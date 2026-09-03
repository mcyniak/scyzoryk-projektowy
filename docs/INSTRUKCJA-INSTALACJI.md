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
- Microsoft Word dla narzędzi **Dokumenty seryjne PDF** i **Wnioski powykonawcze PDF**,
- dostęp do używanej drukarki,
- pliki z Dysku Google ustawione jako dostępne offline,
- internet dla Doborów myEcodan/Varmero (zewnętrzne formularze producentów) oraz dla OCR audytów, jeśli używasz automatycznego rozpoznawania tekstu (Gemini/OpenAI) — tryb ręczny OCR działa bez internetu.

Nie jest wymagane instalowanie:

- Node.js,
- npm,
- Playwrighta,
- Chromium,
- Pythona,
- żadnego klucza API — instalator go nie zawiera; jeśli chcesz automatyczne rozpoznawanie w OCR, wpisujesz własny klucz Gemini albo OpenAI po instalacji.

Gotowy instalator zawiera przenośny Node.js i wszystkie zależności (w tym Chromium) już spakowane w środku — **nic nie jest pobierane podczas instalacji**, sama instalacja działa więc offline.

## 2. Pobranie właściwego instalatora

1. Otwórz stronę **Releases** repozytorium (zakładka „Releases” na GitHubie albo `<adres-repozytorium>/releases`).
2. Otwórz najnowsze wydanie (numer wersji `vX.Y.Z`).
3. Pobierz plik instalatora:
   - `ScyzorykProjektowy-Setup-<wersja>.exe` — pierwsza instalacja albo pełna naprawa (zawiera wszystko, ok. 600–900 MB),
   - `ScyzorykProjektowy-Update-<wersja>.exe` — zwykła aktualizacja, gdy program już jest zainstalowany (dużo mniejszy plik, bez ponownego pobierania Node.js/Chromium).
4. Uruchom pobrany plik `.exe`.

Każde wydanie jest publikowane dopiero po pełnym teście: instalacji na świeżym Windowsie, uruchomieniu wszystkich modułów i przejściu testów regresyjnych (patrz `.github/workflows/release-public-installer.yml`).

> Instalator jest w pełni publiczny i nie zawiera żadnych poufnych danych ani kluczy — można go swobodnie udostępniać.

## 3. Instalacja

1. Uruchom instalator EXE.
2. Przejdź przez kreator instalacji.
3. Pozostaw zaznaczoną opcję utworzenia ikony na pulpicie.
4. Autostart przy logowaniu jest opcjonalny (nie wymaga żadnego dodatkowego okna ani uprawnień administratora).
5. Poczekaj, aż instalator doinstaluje składniki. Nie zamykaj instalatora w trakcie tego kroku.
6. Po zakończeniu uruchom Scyzoryk.

Domyślny folder programu:

```text
%LOCALAPPDATA%\ScyzorykApp
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
3. Ustaw datę: konkretną, tylko miesiąc i rok, albo **Bez daty** (żadna data w dokumencie nie zostanie zmieniona).
4. Zaznacz **Dodaj też wersję Word (DOCX)**, jeśli oprócz PDF-a potrzebujesz też pliku Word.
5. Ustaw przedrostek nazwy.
6. Kliknij **Utwórz PDF-y**.

### Cały folder WM

1. Wybierz **Cały folder WM (automatycznie)**.
2. Wklej ścieżkę folderu.
3. Ustaw datę (albo **Bez daty**), przedrostek i opcjonalnie **Dodaj też wersję Word (DOCX)**.
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

## 12. Przypisywanie plików do folderów

1. Wybierz Excel z arkuszami `Solary {gmina}`.
2. Wklej ścieżkę głównego folderu Kolektory.
3. Wybierz rodzaj: karty katalogowe (Solary/Pompy) albo jeden z dodatków (Audyty/schematy elektryczne/dokumenty seryjne/Dobory) dołączanych po adresie do już istniejącego folderu klienta.
4. Kliknij **Sprawdź tabelę**.
5. Sprawdź dopasowania UID/adresu, folderów.
6. Kliknij **Uruchom dobór kart** (albo doklejenie wybranego dodatku).

## 13. OCR audytów

1. Dodaj zeskanowane PDF-y.
2. Przy pierwszym uruchomieniu wybierz sposób rozpoznawania tekstu:
   - **Google Gemini** albo **OpenAI** — wpisz własny klucz API dostawcy (rozpoznawanie automatyczne, w tym pismo odręczne),
   - **Ręcznie (bez AI)** — bez żadnego klucza; wszystkie pola trzeba uzupełnić samodzielnie, korzystając z podglądu strony obok.
3. Kliknij **Rozpoznaj tekst**.
4. Sprawdź podział na adresy.
5. Wybierz rodzinę dokumentów: Pompy ciepła, Solary albo Kotły.
6. W razie potrzeby wybierz wzór gminy.
7. Uzupełnij niepewne pola. Jeśli pole jest puste w oryginale, kliknij **Brak w oryginale**.
8. Opcjonalnie podaj ścieżkę nowego pliku Excel.
9. Kliknij **Zapisz i pobierz**.

Klucz API (jeśli go używasz) jest zapisywany lokalnie na Twoim komputerze i nigdy nie trafia do repozytorium ani do instalatora. W trybie Gemini/OpenAI strony wymagające rozpoznania są wysyłane do wybranego dostawcy — wymaga to internetu i generuje koszt po stronie tego dostawcy. Tryb ręczny nie wysyła nigdzie żadnych danych i działa bez internetu.

## 14. Dobory Varmero

1. Dodaj Excel z tabelą adresową (kolumna „Rodzaj pompy” — tylko wiersze „Powietrze-woda” trafiają do kalkulatora).
2. Podaj gminę, kod pocztowy, strefę klimatyczną i województwo dla całej paczki.
3. Zaznacz adresy do zgłoszenia.
4. Przy pierwszym uruchomieniu podaj skrzynkę pocztową (przycisk **Skrzynka pocztowa** u góry okna): adres e-mail, hasło do aplikacji i serwer IMAP. Scyzoryk loguje się do niej, żeby odebrać karty wynikowe i zapisać je jako PDF. Ustawienie wpisuje się raz — zostaje w katalogu danych i przeżywa aktualizacje.
   - Dla Gmaila potrzebne jest **hasło do aplikacji** (Konto Google → Bezpieczeństwo → Hasła do aplikacji), nie zwykłe hasło do poczty. Wymaga włączonej weryfikacji dwuetapowej.
   - Program próbuje się zalogować, zanim zapisze ustawienia, więc błędne dane wychodzą od razu — a nie dopiero po wysłaniu nieodwracalnych zgłoszeń do kalkulatora.
   - Skrzynka musi obsługiwać adresy plusowe (`nazwa+cos@domena`) — Scyzoryk nadaje każdemu zgłoszeniu własny wariant adresu, żeby karty nie pomyliły się między adresami inwestycji.
   - Administrator może zamiast tego ustawić zmienne środowiskowe `VARMERO_IMAP_HOST`/`USER`/`PASSWORD` (opcjonalnie `PORT`, `SECURE`) — mają pierwszeństwo przed ekranem w programie, który wtedy pokazuje, że decyduje ustawienie systemowe.
5. Kliknij start — narzędzie samo wypełnia kalkulator Varmero dla każdego adresu i pobiera kartę wynikową mailem.

## 15. Nazywarka skanów

Zmienia nazwy zeskanowanych plików PDF **w miejscu**, bezpośrednio na sieciowym udziale skanera, na podstawie zawartości/podglądu strony — bez kopiowania plików gdziekolwiek indziej.

## 16. Tworzenie folderów

1. Dodaj Excel z tabelą adresową (arkusze pomp/kolektorów/kotłów rozpoznawane po nazwie zakładki).
2. Wskaż istniejący już folder inwestycji (narzędzie **nie** tworzy folderu inwestycji od zera, tylko uzupełnia w nim podfoldery).
3. Sprawdź podgląd planowanej struktury (WM, PC Grunt/PC powietrzne, kolektory, kotły — z podziałem na gminy, jeśli w tabeli jest więcej niż jedna).
4. Zatwierdź utworzenie folderów.

## 17. Zdjęcia do PDF Protokołów

Składa zdjęcia protokołów z folderów adresów (ten sam układ folderów co Drukarka projektów) w przycięte, czarno-białe pliki PDF gotowe do druku.

## 18. Najczęstsze problemy

| Problem | Rozwiązanie |
|---|---|
| Kafelek nie przechodzi na status „gotowe” | Uruchom Scyzoryk ponownie skrótem z pulpitu. |
| Word nie tworzy PDF | Sprawdź instalację i aktywację Worda oraz dostępność pliku offline. |
| Nie znaleziono pliku na Dysku Google | Ustaw plik lub folder jako dostępny offline. |
| Drukowanie jest zajęte | Poczekaj na zakończenie serii w innym module lub karcie. |
| OCR nie odpowiada / błąd klucza | Jeśli używasz Gemini/OpenAI, sprawdź internet i poprawność klucza API w ustawieniach narzędzia; ewentualnie przełącz się na tryb ręczny (bez AI, bez klucza). |
| Ecodan ma tylko trzy strony | To prawidłowe i wymagane działanie. |
| Niepewny dokument projektu nie został zaznaczony | Sprawdź podgląd i zaznacz go ręcznie. |

## 19. Aktualizacja

Najprostszy sposób: Scyzoryk sam sprawdza dostępność nowej wersji i potrafi się zaktualizować z poziomu panelu (przycisk sprawdzania aktualizacji w nagłówku) — nie trzeba nic pobierać ręcznie.

Aktualizacja ręczna (np. gdy automatyczna z jakiegoś powodu zawiedzie):

1. Pobierz najnowszy `ScyzorykProjektowy-Update-<wersja>.exe` ze strony **Releases** repozytorium (patrz sekcja 2) — nie trzeba pobierać pełnego instalatora, jeśli program już jest zainstalowany.
2. Uruchom pobrany plik na komputerze użytkownika.

Aktualizacja nadpisuje wyłącznie pliki programu. Dane użytkownika (`%LOCALAPPDATA%\ScyzorykProjektowy\Data`) znajdują się poza katalogiem programu i nie są ruszane.
