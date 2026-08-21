// Konfiguracja - wzorowana na apps/formularze-ecodan/src/config.js (ten sam
// zestaw zmiennych srodowiskowych tam gdzie ma to sens, zeby zachowac
// spojnosc miedzy obiema appkami napedzanymi Playwrightem).
export const APP_VERSION = process.env.APP_VERSION || '0.1.0';
export const PORT = Number(process.env.PORT || 3012);

export const DEBUG_MODE = String(process.env.DEBUG || '').toLowerCase() === 'true';
export const HEADLESS_DEFAULT = String(process.env.HEADLESS || 'true').toLowerCase() !== 'false';
export const BROWSER_VIEWPORT = { width: 1600, height: 1000 };

// Domyslnie 1 - w odroznieniu od Ecodana (domyslnie tez 1, max 4), tutaj
// kazdy wiersz i tak czeka na przychodzacy mail PO zgloszeniu (patrz plan:
// faza "awaiting-email"), wiec rownoleglosc nie przyspiesza calosci, za to
// komplikuje dopasowanie "ktory mail nalezy do ktorego wiersza".
export const BATCH_CONCURRENCY_DEFAULT = Math.max(1, Math.min(2, Number(process.env.BATCH_CONCURRENCY || 1)));
export const BATCH_CONCURRENCY_MAX = Math.max(1, Math.min(2, Number(process.env.BATCH_CONCURRENCY_MAX || 2)));

export const RECORD_TIMEOUT_MS = Math.max(60000, Number(process.env.RECORD_TIMEOUT_MS || 8 * 60 * 1000));
// Wylacznik calej paczki po N zgloszeniach z rzedu, ktore skonczyly sie
// bledem (audyt 2026-08-21) - bez tego, jesli strona Varmero sie zmieni albo
// IMAP przestanie dzialac, KAZDY pozostaly wiersz i tak wysyla REALNE
// zgloszenie do zewnetrznego kalkulatora, zanim identyczny blad zostanie
// wykryty - ten sam wzorzec co MAX_JOB_CLOSED_SESSION_STREAK w
// apps/formularze-ecodan/src/config.js, tylko liczony po prostu po bledach,
// nie po konkretnej przyczynie (Varmero nie ma dzis odpowiednika "zamknieta
// sesja Chrome" jako osobnej kategorii bledu).
export const MAX_CONSECUTIVE_FAILURES = Math.max(1, Number(process.env.VARMERO_MAX_CONSECUTIVE_FAILURES || 3));
// Katalog ikon CAPTCHY (automation/captcha.js) ma dzis niepelne pokrycie
// (~40%, zweryfikowane w tej sesji) - zamiast poddawac caly wiersz po
// pierwszej nieznanej ikonie, probujemy ponownie (nowe zaladowanie strony =
// nowe, losowe wyzwanie) az do tego limitu PRZED zgloszeniem prawdziwego
// bledu. To NIE jest zgadywanie - kazda proba to osobne, w pelni
// zweryfikowane dopasowanie po katalogu, albo kolejna proba.
export const CAPTCHA_MAX_ATTEMPTS = Math.max(1, Number(process.env.CAPTCHA_MAX_ATTEMPTS || 6));
// Ile czekac na mail z karta po udanym zgloszeniu, zanim wiersz zostanie
// oznaczony jako blad ("mail nie przyszedl na czas") - patrz src/mailbox.js.
export const EMAIL_WAIT_TIMEOUT_MS = Math.max(30000, Number(process.env.EMAIL_WAIT_TIMEOUT_MS || 3 * 60 * 1000));
