// Klient HTTP do wolania innych apek Scyzoryka - dokladnie to samo, co robi
// dzis przegladarka, tylko automatycznie i po kolei (patrz plan "Pipeline
// inwestycji", Faza 1). Zaden import kodu innych apek - kazda apka zostaje
// w pelni niezalezna, tak jak reszta architektury tego repo.
const fs = require('fs/promises');
const path = require('path');

// Wszystkie mutujace zadania w tym repo wymagaja tego naglowka (patrz
// lib/localRequestSecurity.js) - bez niego kazda apka odrzuci zadanie 403.
const MUTATION_GUARD_HEADER = 'X-Scyzoryk-Request';

// multipartFields: { pole: string } albo { pole: { filePath, filename } } (plik
// z dysku, wczytywany tutaj) - ten sam ksztalt co uzywaja testy w tym repo
// (new FormData() + Blob), tylko budowany raz, wspolnie dla kazdego wywolania.
async function buildFormData(multipartFields) {
  const form = new FormData();
  for (const [key, value] of Object.entries(multipartFields || {})) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'object' && value.filePath) {
      const buffer = await fs.readFile(value.filePath);
      form.append(key, new Blob([buffer]), value.filename || path.basename(value.filePath));
    } else {
      form.append(key, String(value));
    }
  }
  return form;
}

// Audyt zuzycia RAM 2026-08-21 (lazy-start): apki-dzieci JUZ NIE startuja
// automatycznie przy starcie Scyzoryka - startuja dopiero na zadanie (patrz
// server.js#ensureChildStarted). Pipeline samo w sobie jest "dzieckiem", ale
// tez WOLA INNE dzieci przez ich prawdziwe API (karty-katalogowe,
// tworzenie-folderow, dokumenty-seryjne, myEcodan, varmero) - bez tej
// warstwy kazdy pierwszy krok przebiegu dla apki, ktorej uzytkownik nigdy
// wczesniej recznie nie otworzyl, konczylby sie "connection refused".
// Dlatego przed KAZDYM prawdziwym wywolaniem prosimy panel glowny o start
// (idempotentne - panel sam pilnuje, zeby nie startowac drugi raz) i krotko
// czekamy, az /api/health zacznie odpowiadac - `ensuredSlugs` pamieta, ze
// juz to zrobilismy, zeby nie pytac panelu przy KAZDYM kolejnym wywolaniu w
// tym samym przebiegu.
const PANEL_BASE_URL = process.env.SCYZORYK_PANEL_URL || `http://127.0.0.1:${process.env.SCYZORYK_PANEL_PORT || 3000}`;
const PORT_TO_PANEL_SLUG = {
  [Number(process.env.TWORZENIE_FOLDEROW_PORT || 3013)]: 'tworzenie-folderow',
  [Number(process.env.KARTY_PORT || 3006)]: 'karty-katalogowe',
  [Number(process.env.SERYJNE_PORT || 3004)]: 'dokumenty-seryjne',
  [Number(process.env.FORMULARZE_PORT || 3003)]: 'formularze-ecodan',
  [Number(process.env.FORMULARZE_VARMERO_PORT || 3012)]: 'formularze-varmero',
  3001: 'drukarka', 3002: 'pieczatki-pdf', 3005: 'wnioski-powykonawcze', 3007: 'nazywarka-skanow',
  3010: 'drukarka-projekty', 3011: 'ocr-audytow', 3014: 'protokoly'
};
const ensuredSlugs = new Set();

async function ensureChildAppRunning(url) {
  let port;
  try { port = Number(new URL(url).port); } catch { return; }
  const slug = PORT_TO_PANEL_SLUG[port];
  if (!slug || ensuredSlugs.has(slug)) return;
  ensuredSlugs.add(slug);
  try {
    await fetch(`${PANEL_BASE_URL}/api/apps/${slug}/start`, { method: 'POST', headers: { [MUTATION_GUARD_HEADER]: '1' } });
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const statusRes = await fetch(`${PANEL_BASE_URL}/api/apps`).catch(() => null);
      const statusData = await statusRes?.json().catch(() => null);
      if (statusData?.apps?.find(a => a.slug === slug)?.running) return;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } catch (_) {
    // Panel niedostepny/start zawiodl - nie przerywamy tutaj, prawdziwe
    // wywolanie nizej i tak dostanie czytelny blad (friendlyFetchError),
    // jesli apka faktycznie nie odpowiada.
  }
}

// Audyt UX 2026-08-21: jesli docelowa apka po prostu nie dziala (proces nie
// wstal, port zajety przez cos innego), sam fetch() odrzuca sie z surowym
// bledem silnika (np. "fetch failed"/"ECONNREFUSED") - bez tego opakowania
// ten tekst leciał 1:1 do panelu przebiegu, bez zadnej wskazowki co zrobic.
function friendlyFetchError(error, url) {
  const wiadomosc = String(error?.message || error);
  if (/fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/i.test(wiadomosc)) {
    return new Error(`Nie udało się połączyć z narzędziem pod adresem ${url}. Sprawdź na panelu głównym (http://127.0.0.1:3000), czy ta aplikacja działa - jeśli nie, uruchom ponownie Scyzoryka.`);
  }
  return error;
}

async function postMultipart(url, multipartFields) {
  await ensureChildAppRunning(url);
  const form = await buildFormData(multipartFields);
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: { [MUTATION_GUARD_HEADER]: '1' }, body: form });
  } catch (error) {
    throw friendlyFetchError(error, url);
  }
  const data = await res.json().catch(() => ({}));
  // Audyt 2026-08-21: wymagamy JAWNEGO "ok: true", nie tylko "ok nie jest
  // false" - odpowiedz 2xx z pustym/niepoprawnym cialem (np. .json().catch()
  // dajace {}, albo apka child ktora kiedys zapomni ustawic "ok") byla
  // wczesniej po cichu traktowana jako sukces zamiast bledu, co dla krokow
  // doboru mogloby oznaczac falszywe "zgloszono" dla realnego zgloszenia,
  // ktore w rzeczywistosci sie nie udalo.
  if (!res.ok || data.ok !== true) {
    throw new Error(data.message || data.error || `${url} zwrocilo nieoczekiwana odpowiedz (HTTP ${res.status}).`);
  }
  return data;
}

async function getJson(url) {
  await ensureChildAppRunning(url);
  let res;
  try {
    res = await fetch(url);
  } catch (error) {
    throw friendlyFetchError(error, url);
  }
  const data = await res.json().catch(() => ({}));
  // Audyt 2026-08-21: wymagamy JAWNEGO "ok: true", nie tylko "ok nie jest
  // false" - odpowiedz 2xx z pustym/niepoprawnym cialem (np. .json().catch()
  // dajace {}, albo apka child ktora kiedys zapomni ustawic "ok") byla
  // wczesniej po cichu traktowana jako sukces zamiast bledu, co dla krokow
  // doboru mogloby oznaczac falszywe "zgloszono" dla realnego zgloszenia,
  // ktore w rzeczywistosci sie nie udalo.
  if (!res.ok || data.ok !== true) {
    throw new Error(data.message || data.error || `${url} zwrocilo nieoczekiwana odpowiedz (HTTP ${res.status}).`);
  }
  return data;
}

// Wspolny ksztalt jobow trzech apek job-based (dokumenty-seryjne,
// formularze-ecodan, formularze-varmero, patrz Faza 1 planu): status
// endpoint zwraca { ok, job: { status, ... } }, status konczy sie na
// 'done'/'error' (dokumenty-seryjne) - inne apki moga uzywac innych nazw
// koncowych statusow, stad `terminalni` jest konfigurowalny per wywolanie.
async function pollJob({ statusUrl, isDone, isError, intervalMs = 3000, timeoutMs = 30 * 60 * 1000, onTick = () => {} }) {
  const start = Date.now();
  for (;;) {
    const data = await getJson(statusUrl);
    onTick(data.job || data);
    const job = data.job || data;
    if (isDone(job)) return job;
    if (isError(job)) throw new Error(job.errorMessage || job.message || 'Zadanie zakonczylo sie bledem.');
    if (Date.now() - start > timeoutMs) throw new Error(`Przekroczono limit czasu oczekiwania na ${statusUrl}.`);
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

module.exports = {
  MUTATION_GUARD_HEADER,
  postMultipart,
  getJson,
  pollJob,
  ensureChildAppRunning,
  PORT_TO_PANEL_SLUG
};
