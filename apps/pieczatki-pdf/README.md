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

W PowerShell:

```powershell
$env:Path="C:\Users\Piotr.Cyniak\node-v26.4.0-win-x64;$env:Path"
cd "C:\Users\Piotr.Cyniak\Downloads\pdf-stamper-standalone-v4-bundled\pdf-stamper-standalone"
node server.js
```

Albo kliknij `start-portable.cmd`, jezeli portable Node jest w:

```text
C:\Users\Piotr.Cyniak\node-v26.4.0-win-x64
```

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
