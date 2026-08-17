// Scyzoryk - wspolny przelacznik trybu ciemnego (dodany 2026-08-17).
// Serwowany pod /shared/theme.js przez kazdy modul (ten sam mechanizm co
// tokens.css/components.css/icons.svg - patrz docs/UI-DESIGN-SYSTEM.md).
// Ten plik NIE jest kopiowany do apps/<nazwa>/public - kazde HTML linkuje go
// wprost, zeby jedna zmiana byla widoczna wszedzie.
//
// Musi byc zaladowany jako zwykly, blokujacy <script> W <head> (bez defer/
// async), PRZED pierwszym malowaniem strony - inaczej uzytkownik widziclby
// bialy blysk (FOUC) zanim JS zdazylby przelaczyc na ciemny motyw. Dlatego
// czesc "ustaw atrybut" wykonuje sie natychmiast przy parsowaniu, a
// podpiecie przycisku czeka na DOMContentLoaded (przycisk jeszcze nie
// istnieje w <head>).
(function () {
  const STORAGE_KEY = "scyzorykTheme";

  function getStoredTheme() {
    try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
  }

  function applyTheme(theme) {
    if (theme === "dark" || theme === "light") {
      document.documentElement.setAttribute("data-theme", theme);
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
  }

  // Natychmiast, zanim przegladarka namaluje strone.
  applyTheme(getStoredTheme());

  function currentEffectiveTheme() {
    const stored = getStoredTheme();
    if (stored === "dark" || stored === "light") return stored;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function updateToggleIcon(btn) {
    const isDark = currentEffectiveTheme() === "dark";
    const icon = btn.querySelector("use");
    if (icon) icon.setAttribute("href", isDark ? "/shared/icons.svg#i-sun" : "/shared/icons.svg#i-moon");
    btn.setAttribute("aria-label", isDark ? "Przełącz na jasny motyw" : "Przełącz na ciemny motyw");
    btn.setAttribute("title", isDark ? "Jasny motyw" : "Ciemny motyw");
  }

  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("[data-theme-toggle]").forEach(btn => {
      updateToggleIcon(btn);
      btn.addEventListener("click", () => {
        const next = currentEffectiveTheme() === "dark" ? "light" : "dark";
        try { localStorage.setItem(STORAGE_KEY, next); } catch { /* prywatna karta itp. - motyw dziala tylko na czas sesji */ }
        applyTheme(next);
        document.querySelectorAll("[data-theme-toggle]").forEach(updateToggleIcon);
      });
    });
  });
})();
