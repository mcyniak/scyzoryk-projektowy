# Wspólny CSS Scyzoryka - base.css

## Co to jest
`base.css` to jedno źródło prawdy dla wyglądu wszystkich modułów: kolory,
przyciski, panele, karty, formularze, modal, komunikaty błędów. Wzięte
z najczystszej wersji (Drukarka projektów) i oczyszczone z rzeczy
specyficznych tylko dla niej (stepper, lista adresów itp.).

## Stan obecny (jeszcze NIE podłączone do modułów)
Ten plik na razie leży tu jako gotowa baza. Żaden moduł jeszcze go nie
używa - to następny krok.

## Plan podłączenia (do zrobienia per moduł)
Dla każdego modułu (`apps/<nazwa>/public/`):
1. Skopiuj `base.css` jako `apps/<nazwa>/public/base.css` (identyczna kopia).
2. Z istniejącego `<style>` w index.html (albo starego style.css/styles.css)
   zostaw TYLKO to, co unikalne dla tego modułu (własne listy, widgety),
   zapisz jako `apps/<nazwa>/public/app.css`. Usuń duplikaty reguł, które
   są już w base.css.
3. W index.html: usuń `<style>...</style>`, dodaj w `<head>`:
   ```html
   <link rel="stylesheet" href="base.css">
   <link rel="stylesheet" href="app.css">
   ```
4. Odśwież i porównaj wizualnie przed/po - upewnij się że nic się nie
   rozjechało.

## Jeśli zmieniasz kolory/wygląd w przyszłości
Zmień `base.css` w JEDNYM miejscu (np. tu, w `shared-styles/`), potem
skopiuj identycznie do wszystkich `apps/*/public/base.css`. Nie edytuj
kopii w poszczególnych modułach osobno - rozjadą się.

## Kolejność modułów do przerobienia (od najprostszych)
1. Drukarka projektów - już czysta (można od razu podpiąć base.css +
   przenieść resztę do app.css, jako pierwszy test wzorca).
2. Karty katalogowe, Drukarka, Pieczątki PDF - mają już osobny plik CSS,
   więc łatwiej odseparować unikalne reguły.
3. Formularze Ecodan, Dokumenty seryjne, Wnioski powykonawcze - całość
   inline w index.html, wymaga najwięcej pracy przy wyciąganiu.
