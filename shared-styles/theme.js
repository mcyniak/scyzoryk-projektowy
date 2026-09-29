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

  // Przeglad 2026-09-29: kazde narzedzie dziala na WLASNYM porcie, a
  // localStorage jest osobny dla kazdego portu - tryb ciemny wlaczony w
  // panelu nie obowiazywal w zadnym narzedziu. Ciasteczko nie zalezy od portu
  // (ten sam host), wiec jeden wybor dziala wszedzie; localStorage zostaje
  // jako zapas (np. gdy ciasteczka sa zablokowane).
  function readCookieTheme() {
    try {
      const m = document.cookie.match(/(?:^|;\s*)scyzorykTheme=(dark|light)/);
      return m ? m[1] : null;
    } catch { return null; }
  }

  function getStoredTheme() {
    const fromCookie = readCookieTheme();
    if (fromCookie) return fromCookie;
    try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
  }

  function storeTheme(theme) {
    try { document.cookie = `${STORAGE_KEY}=${theme}; path=/; max-age=31536000; SameSite=Lax`; } catch { /* ignore */ }
    try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* prywatna karta itp. */ }
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
        storeTheme(next);
        applyTheme(next);
        document.querySelectorAll("[data-theme-toggle]").forEach(updateToggleIcon);
      });
    });
  });
})();

// Wspolne drobiazgi UI dla wszystkich narzedzi (przeglad 2026-09-29) - ten
// plik i tak jest ladowany na kazdej stronie, wiec nie trzeba dopisywac
// nowego <script> w 30 plikach HTML.
(function () {
  function plural(n, one, few, many) {
    const abs = Math.abs(Number(n) || 0);
    const mod10 = abs % 10, mod100 = abs % 100;
    const word = abs === 1 ? one : (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many);
    return `${n} ${word}`;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Techniczne/angielskie bledy -> polski komunikat z podpowiedzia, co zrobic.
  const RULES = [
    [/failed to fetch|networkerror|load failed|econnrefused|econnreset|socket hang up/i, 'Brak połączenia z narzędziem. Sprawdź, czy Scyzoryk działa (panel główny), i spróbuj ponownie.'],
    [/ebusy|resource busy or locked/i, 'Plik jest otwarty w innym programie (np. Excel, Acrobat). Zamknij go i spróbuj ponownie.'],
    [/eperm|eacces|operation not permitted|permission denied/i, 'Brak uprawnień do pliku lub folderu albo plik jest otwarty w innym programie. Zamknij go albo sprawdź uprawnienia.'],
    [/enoent|no such file or directory/i, 'Nie znaleziono pliku lub folderu - sprawdź ścieżkę (dysk sieciowy może być niepodłączony).'],
    [/enospc|no space left/i, 'Brak miejsca na dysku.'],
    [/enametoolong|name too long/i, 'Ścieżka lub nazwa pliku jest za długa - skróć nazwę folderu.'],
    [/too many files/i, 'Za dużo plików naraz - wybierz mniej plików.'],
    [/file too large/i, 'Plik jest za duży.'],
    [/unexpected end of json|unexpected token .* in json|is not valid json/i, 'Narzędzie zwróciło nieoczekiwaną odpowiedź (mogło się właśnie restartować). Spróbuj ponownie za chwilę.'],
  ];
  function friendlyError(error) {
    const raw = String((error && error.message) || error || '').trim();
    if (!raw) return 'Wystąpił nieoczekiwany błąd. Spróbuj ponownie.';
    for (const [re, text] of RULES) if (re.test(raw)) return text;
    return raw;
  }

  window.ScyzorykUI = { plural, escapeHtml, friendlyError };

  // Upuszczenie pliku POZA strefa upuszczania powodowalo, ze przegladarka
  // otwierala ten plik zamiast narzedzia (utrata calej pracy na stronie).
  // Strefy upuszczania same wywoluja preventDefault - tu lapiemy tylko
  // reszte strony. Natywne <input type=file> zostawiamy w spokoju.
  function isFileInput(target) {
    return target && target.tagName === 'INPUT' && String(target.type).toLowerCase() === 'file';
  }
  function hasFiles(e) {
    return e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  }
  window.addEventListener('dragover', e => {
    if (!e.defaultPrevented && hasFiles(e) && !isFileInput(e.target)) { e.preventDefault(); e.dataTransfer.dropEffect = 'none'; }
  });
  window.addEventListener('drop', e => {
    if (!e.defaultPrevented && hasFiles(e) && !isFileInput(e.target)) e.preventDefault();
  });
})();
