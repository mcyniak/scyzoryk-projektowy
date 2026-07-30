# Wspólny wygląd Scyzoryka - shared-styles/

Zobacz pełny opis: [`docs/UI-DESIGN-SYSTEM.md`](../docs/UI-DESIGN-SYSTEM.md).

## Skrót

- `tokens.css` + `components.css` + `icons.svg` to jedyne źródło prawdy dla
  wyglądu wszystkich modułów.
- Każdy moduł (`apps/<nazwa>/server.js`) serwuje ten katalog pod `/shared` przez
  `express.static(...)` i linkuje go bezpośrednio w `<head>` — **nie kopiuje**
  plików do siebie. Zmiana tutaj jest od razu widoczna wszędzie.
- Rzeczy unikalne dla jednego modułu (własne widgety, listy, nietypowy layout)
  zostają w małym `apps/<nazwa>/public/app.css`, ładowanym po `components.css`.
- Stare `base.css` (kopiowane ręcznie do `apps/*/public/base.css`) zostało
  usunięte 2026-07-30 - powodowało rozjazd kopii i warstwy `!important`
  ("UI refresh", "v3", "final polish") w każdym module.
