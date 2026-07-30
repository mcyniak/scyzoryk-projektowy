# System projektowy Scyzoryka

Ten dokument opisuje wspólny design system wprowadzony w redesignie 2026-07-30.
Zastępuje wcześniejsze `shared-styles/base.css` + ręczne kopie per moduł.

## Cel

Jeden spójny wygląd wszystkich narzędzi Scyzoryka — panel główny, panel admina
i 8 modułów — bez frameworka frontendowego, bez CDN, w pełni offline.

## Struktura

```
shared-styles/
  tokens.css        - zmienne: kolory, spacing, promienie, cienie, typografia, czas animacji
  components.css    - biblioteka komponentów (przyciski, formularze, tabele, modal, itd.)
  icons.svg         - lokalny sprite SVG (symbole <symbol id="i-nazwa">)
apps/<nazwa>/public/
  app.css           - TYLKO to, co unikalne dla tego modułu (własne widgety, layout)
```

## Jak to jest serwowane (bez kopiowania plików)

Wcześniejsze podejście (`shared-styles/README.md`) zakładało ręczne kopiowanie
`base.css` do każdego `apps/<nazwa>/public/base.css` — po każdej zmianie trzeba
było pamiętać o skopiowaniu do 8 miejsc, co w praktyce się rozjeżdżało (stąd
warstwy „UI refresh” / „v3” / „final polish” w każdym module).

Teraz każdy serwer (root `server.js` i każdy `apps/<nazwa>/server.js`) montuje
katalog `shared-styles/` bezpośrednio pod `/shared`:

```js
app.use('/shared', express.static(path.join(ROOT, '..', '..', 'shared-styles')));
```

HTML każdego modułu linkuje wprost:

```html
<link rel="stylesheet" href="/shared/tokens.css">
<link rel="stylesheet" href="/shared/components.css">
<link rel="stylesheet" href="app.css">
```

Efekt: **jedna zmiana w `shared-styles/*.css` jest natychmiast widoczna we
wszystkich modułach** po odświeżeniu strony — nie ma kopii do synchronizacji,
więc nie da się ich przypadkiem rozjechać. To jest bezpieczniejszy wariant niż
skrypt synchronizujący (żadnego dodatkowego kroku do pamiętania), a nie
wymaga bundlera ani zmiany architektury supervisora.

## Tokeny (`tokens.css`)

- Kolory neutralne: `--gray-0` … `--gray-900` (chłodna, jasna paleta szarości)
- Marka: `--brand-500` (czerwień Scyzoryka) + warianty hover/tekst
- Semantyczne: `--danger-*` (celowo INNY odcień niż marka — róż/karmin, żeby błąd
  nigdy nie wyglądał jak zwykły czerwony przycisk), `--success-*`, `--warning-*`, `--info-*`
- Znaczeniowe aliasy: `--bg-page`, `--bg-surface`, `--text-primary/secondary/tertiary`,
  `--border-default/strong`
- Spacing w skali 4px: `--space-1` (4px) … `--space-16` (64px)
- Promienie: `--radius-sm` … `--radius-full`
- Cienie: `--shadow-xs` … `--shadow-lg` (świadomie subtelne — bez efektu
  „unoszenia się pół ekranu")
- Typografia: `--font-sans` (Segoe UI Variable + fallbacki), skala `--text-xs` … `--text-3xl`
- Czas animacji: `--duration-fast` (120ms) … `--duration-slow` (220ms)

## Komponenty (`components.css`)

Pełna lista klas: `.app-header`, `.btn` (+ `.btn-primary/secondary/ghost/danger/icon`),
pola formularzy (`input`, `select`, custom `checkbox`/`radio`/`.switch`), `.dropzone`,
`.panel`/`.card`, `.hero`/`.kicker`/`.lead`/`.pill-list`, `.modal-overlay`/`.modal-box`,
`.tooltip`, `.badge` (+ warianty), `.alert` (+ warianty, z rozwijanymi szczegółami
technicznymi), `.table` (sticky header), `.progress`/`.skeleton`, `.state`
(empty/success/error), `.stepper`, `.file-list`/`.file-item` (draggable),
`.doc-viewer` (ciemny podgląd dokumentu, używany w Pieczątkach PDF i Drukarce).

Zasada: **zero `!important`** w `components.css` poza jednym wyjątkiem
(`.u-hidden`) — to jest warstwa bazowa, nic wcześniejszego jej nie przykrywa,
więc nie ma potrzeby "przebijania się" przez starsze reguły. Poprzedni kod miał
1245+ wystąpień `!important` rozrzuconych po kolejnych warstwach poprawek — nowy
system tego nie potrzebuje, bo jest ładowany raz, w jednej, świadomie
zaprojektowanej kolejności (`tokens.css` → `components.css` → `app.css`).

## Ikony (`icons.svg`)

Lokalny sprite SVG (autorskie, proste kształty liniowe — bez zależności od
zewnętrznych bibliotek ikon i bez CDN). Użycie:

```html
<svg class="icon"><use href="/shared/icons.svg#i-printer"/></svg>
```

Klasa `.icon` ustawia rozmiar na `1em` (dziedziczy z `font-size` kontekstu),
`.icon-lg` wymusza 22px. Kolor ikony = `currentColor`.

## Fokus i dostępność

Jedna reguła `:focus-visible` w całym systemie (niebieski obrys `--info-500`,
2px, offset 2px) zamiast domyślnego obrysu przeglądarki — to naprawia też
efekt uboczny zauważony w Kartach katalogowych: domyślny czarny prostokąt
fokusu przeglądarki na linku logo, który wyglądał jak przypadkowa "ramka"
wokół logo i napisu po kliknięciu.

Inne zasady: minimalny obszar klikalny `--hit-min` (42px), `prefers-reduced-motion`
wyłącza animacje, statusy nigdy nie polegają wyłącznie na kolorze (ikona + tekst).

## Dodawanie nowego modułu

1. W `apps/<nazwa>/server.js` dodaj (obok istniejącego `express.static(...public...)`):
   ```js
   app.use('/shared', express.static(path.join(ROOT, '..', '..', 'shared-styles')));
   ```
2. W `<head>` HTML-a: `tokens.css` → `components.css` → `app.css` (w tej kolejności).
3. Użyj gotowych klas (`.app-header`, `.btn`, `.panel`, `.table`, ...) zamiast
   pisać nowe reguły od zera.
4. Rzeczy unikalne dla modułu (własne widgety, nietypowe layouty) zostają w
   małym `app.css` tego modułu — nigdy w inline `<style>` w HTML.
5. Jeśli potrzebujesz nowej ikony, dopisz `<symbol>` do `shared-styles/icons.svg`
   (prosty kształt liniowy, `stroke="currentColor"`, `viewBox="0 0 24 24"`).

## Zmiana koloru/wyglądu w przyszłości

Zmień **tylko** `shared-styles/tokens.css` lub `components.css` — efekt jest
natychmiastowy we wszystkich modułach (bez kopiowania, bez ryzyka rozjechania
się kopii). To był główny problem poprzedniego podejścia.
