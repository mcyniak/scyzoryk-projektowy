# ONLYOFFICE x2t - konwerter DOCX -> PDF w Scyzoryku

Scyzoryk (Scyzoryk.DocumentEngine.exe) uruchamia `x2t.exe` z oficjalnej paczki
ONLYOFFICE DocumentBuilder jako **osobny, niezmodyfikowany program** (osobny proces,
komunikacja przez pliki). Binaria nie sa trzymane w repo - pobiera je
`scripts/fetch-onlyoffice-x2t.ps1` do `tools/onlyoffice`, a instalator kopiuje je do
`<katalog instalacji>\onlyoffice` razem z tym plikiem licencji (`LICENSE.txt`).

- Licencja: GNU Affero General Public License v3 (`LICENSE.txt` w tym folderze).
- Wersja: zapisana w `onlyoffice/WERSJA.txt` (domyslnie v9.4.0, parametr `-Version` skryptu).
- Kod zrodlowy: https://github.com/ONLYOFFICE/core oraz
  https://github.com/ONLYOFFICE/DocumentBuilder (tag odpowiadajacy wersji).
- Paczka binarna: https://github.com/ONLYOFFICE/DocumentBuilder/releases

Scyzoryk nie modyfikuje ani nie linkuje kodu ONLYOFFICE - zmiana wersji to wylacznie
ponowne uruchomienie skryptu pobierajacego.
