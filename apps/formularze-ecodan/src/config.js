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
