# Kiedy zadanie uważać za zakończone

Brak linterów/testów automatycznych w projekcie. Checklist przed uznaniem zmiany
za gotową:

1. Składnia:
   - `.js`: `node --check <plik>` (wiarygodne).
   - `.ps1`: WYŁĄCZNIE `[System.Management.Automation.Language.Parser]::ParseFile`
     (patrz `mem:suggested_commands` — `node --check` na .ps1 nic nie mówi).
2. Restart procesu (`Stop-Process node -Force` + `Start-Process node server.js`)
   i potwierdzenie, że wszystkie 8 portów wraca (`mem:apps/overview` — pełna lista
   portów; pamiętać o pułapce filtra `:300` nie łapiącego `:3010`).
3. Dla zmian w logice dopasowywania (kolumny Excela, warianty dokumentów, foldery
   klientów) — weryfikacja na PRAWDZIWYCH danych z `G:\Dyski współdzielone\...`,
   nie tylko na syntetycznych przykładach. Ten projekt ma silną historię "działa na
   jednym przykładzie, psuje się na drugiej inwestycji" — różne inwestycje mają
   naprawdę różne konwencje nazewnictwa kolumn/plików/folderów.
4. Dla zmian dotykających drukowanie/Word: NIE da się w pełni zweryfikować zdalnie
   bez użytkownika patrzącego na ekran (okna, fizyczny wydruk). Wdrożyć, opisać
   dokładnie co się zmieniło i czego oczekiwać, poprosić użytkownika o realny test.
5. Backup przed ryzykowną zmianą w already-working skrypcie: kopia
   `plik.ps1.bak-<opis>` obok oryginału.
