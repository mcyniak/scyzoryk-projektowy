// Wspólna konfiguracja automatyzacji i wydania produkcyjnego.
export const APP_VERSION = process.env.APP_VERSION || '1.0.0-rc5';
export const PORT = Number(process.env.PORT || 3000);

export const DEBUG_MODE = String(process.env.DEBUG || '').toLowerCase() === 'true';
export const TRACE_MODE = String(process.env.TRACE || '').toLowerCase() === 'true';
export const SLOW_MODE = String(process.env.SLOW || '').toLowerCase() === 'true';

// Domyślnie nie blokujemy obrazów/mapy, bo krok lokalizacji korzysta z mapy/autocomplete.
export const BLOCK_HEAVY_ASSETS = String(process.env.BLOCK_ASSETS || 'false').toLowerCase() === 'true';

// Domyślnie finalna wersja pracuje w tle. Do diagnostyki ustaw: $env:HEADLESS="false".
export const HEADLESS_DEFAULT = String(process.env.HEADLESS || 'true').toLowerCase() !== 'false';

// Stały wirtualny ekran dla widocznego Chrome i HEADLESS=true.
export const BROWSER_VIEWPORT = { width: 1600, height: 1000 };

export const SHORT_WAIT = SLOW_MODE ? 700 : 50;
export const MEDIUM_WAIT = SLOW_MODE ? 1200 : 120;
export const STEP_TIMEOUT = SLOW_MODE ? 20000 : 7000;

// Tryb masowy.
export const BATCH_RESTART_EVERY = Math.max(0, Number(process.env.BATCH_RESTART_EVERY || 5));
export const BATCH_RETRY_CLOSED_SESSION = String(process.env.BATCH_RETRY_CLOSED_SESSION || 'true').toLowerCase() !== 'false';
export const BATCH_CONCURRENCY_DEFAULT = Math.max(1, Math.min(4, Number(process.env.BATCH_CONCURRENCY || 1)));
export const BATCH_CONCURRENCY_MAX = Math.max(1, Math.min(4, Number(process.env.BATCH_CONCURRENCY_MAX || 4)));

// Bezpieczniki stabilności.
export const MAX_CLOSED_SESSION_STREAK = Math.max(1, Number(process.env.MAX_CLOSED_SESSION_STREAK || 3));
export const MAX_JOB_CLOSED_SESSION_STREAK = Math.max(1, Number(process.env.MAX_JOB_CLOSED_SESSION_STREAK || 8));
export const RECORD_TIMEOUT_MS = Math.max(60000, Number(process.env.RECORD_TIMEOUT_MS || 8 * 60 * 1000));

// Ile "ciezkich" (Playwright/Chromium) zadan - pojedynczych /api/run ORAZ calych
// paczek /api/batch/start - moze realnie dzialac naraz w tym procesie. Wczesniej
// nie bylo tu ZADNEGO limitu (heavyJobLimiter w server.js ogranicza tylko CZESTOSC
// requestow, nie ich rownolegle wykonanie) - druga karta/zakladka albo odswiezona
// strona mogla odpalic kolejna paczke rownolegle z juz trwajaca, mnozac liczbe
// jednoczesnych procesow Chromium. Nowe zadania NIE dostaja bledu gdy limit jest
// osiagniety - czekaja w kolejce (status zadania zostaje "queued", UI juz to
// pokazuje) i ruszaja same, gdy zwolni sie miejsce - jesli nic innego nie dziala,
// zadanie startuje od razu, tak jak dzis.
export const MAX_ECODAN_JOBS = Math.max(1, Number(process.env.MAX_ECODAN_JOBS || 1));

// Sprzatanie mapy `jobs` (server.js/jobs.js) - dotad rosla w nieskonczonosc (zero
// TTL/limitu), a ta apka ma dzialac tygodniami. Sprzatamy WYLACZNIE zadania w
// stanie koncowym (finished/finished-with-errors/fatal-error/cancelled) - nigdy
// queued/running/cancelling, zeby nie dotknac czegokolwiek aktywnego.
export const JOB_TTL_MS = Math.max(3600000, Number(process.env.ECODAN_JOB_TTL_MS || 24 * 60 * 60 * 1000));
export const JOB_MAX_TERMINAL = Math.max(10, Number(process.env.ECODAN_JOB_MAX_TERMINAL || 200));
