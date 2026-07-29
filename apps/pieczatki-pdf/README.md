# PDF Stamper Standalone

Niezalezne narzedzie do stemplowania PDF-ow.

## Funkcje

- upload wielu PDF-ow,
- pieczatka tekstowa (kolor, rozmiar, ramka),
- ustawianie pozycji i rozmiaru na podgladzie przez przeciaganie ramki,
- brak recznego wpisywania X/Y w panelu - wartosci sa liczone w tle,
- kompaktowy widok startowy, zeby na ekranie 1080p bylo widac opcje bez przewijania,
- wyrazne rozroznienie ramki roboczej od ramki drukowanej na PDF,
- wybor stron: wszystkie, pierwsza, ostatnia albo zakres, np. `1,3,5-7`,
- wynik jako pojedynczy PDF albo ZIP przy wielu plikach,
- presety pieczatek zapisywane w przegladarce.

## Start z portable Node

W PowerShell (podmien sciezke na swoja):

```powershell
$env:Path="<sciezka-do-portable-node>;$env:Path"
cd "<sciezka-do-tego-folderu>"
node server.js
```

Albo ustaw zmienna srodowiskowa `SCYZORYK_PORTABLE_NODE` na folder z portable Node
(np. `setx SCYZORYK_PORTABLE_NODE "D:\Narzedzia\node-v20-win-x64"`) i kliknij
`start-portable.cmd` - odczyta ta zmienna automatycznie.

Potem otworz:

```text
http://localhost:3000
```

## Instalacja od zera

Ta paczka ma juz `node_modules`, wiec `npm install` nie jest potrzebne. Jesli kiedys chcesz instalowac od zera:

```powershell
npm.cmd config set registry https://registry.npmjs.org/
npm.cmd install
npm.cmd start
```

## Uwaga o pieczatce tekstowej

Pieczatki sa tylko tekstowe (bez wgrywania obrazu/PDF jako pieczatki). Jesli na komputerze jest
zainstalowany font Arial (`C:\Windows\Fonts\Arial.ttf` / `arialbd.ttf`), polskie znaki drukuja sie
normalnie. Jesli fontu nie znaleziono, tekst jest uproszczony (znaki diakrytyczne zamieniane na
odpowiedniki bez ogonkow).
