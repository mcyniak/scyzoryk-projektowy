import fs from 'fs/promises';
import path from 'path';
import { chromium } from 'playwright';
import { BROWSER_VIEWPORT, BLOCK_HEAVY_ASSETS, SLOW_MODE, HEADLESS_DEFAULT } from '../config.js';
import { getProjectRoot } from '../debug.js';
import { appendJsonLine } from '../../../../lib/hardening.js';

export async function createAutomationSession(outputDir) {
  const debugDir = path.join(outputDir, 'debug');
  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(debugDir, { recursive: true });
  await fs.mkdir(path.join(outputDir, 'downloads'), { recursive: true });

  const headless = HEADLESS_DEFAULT;
  const browser = await chromium.launch({
    headless,
    slowMo: SLOW_MODE ? 120 : 0,
    downloadsPath: path.join(outputDir, 'downloads'),
    args: ['--lang=pl-PL', '--disable-features=Translate,TranslateUI']
  });

  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: BROWSER_VIEWPORT,
    deviceScaleFactor: 1,
    locale: 'pl-PL',
    permissions: ['geolocation'],
    geolocation: { latitude: 52.2297, longitude: 21.0122, accuracy: 1000 }
  });

  context.setDefaultTimeout(SLOW_MODE ? 15000 : 8000);
  context.setDefaultNavigationTimeout(SLOW_MODE ? 45000 : 25000);

  await context.addInitScript(() => {
    const inject = () => {
      if (!document.documentElement) return;
      if (document.getElementById('__ecodan_no_anim')) return;
      const style = document.createElement('style');
      style.id = '__ecodan_no_anim';
      style.textContent = '*{scroll-behavior:auto!important;animation-duration:0.001s!important;transition-duration:0.001s!important;}';
      document.documentElement.appendChild(style);
    };
    inject();
    document.addEventListener('DOMContentLoaded', inject, { once: true });
  }).catch(() => {});

  const page = await context.newPage();
  page.__ecodanOutputRoot = outputDir;

  if (BLOCK_HEAVY_ASSETS) {
    await page.route('**/*', route => {
      const req = route.request();
      const url = req.url();
      const type = req.resourceType();
      if (['image', 'font', 'media'].includes(type)) return route.abort();
      if (/googletagmanager|google-analytics|doubleclick|googleadservices/i.test(url)) return route.abort();
      return route.continue();
    });
  }

  const runtimeEvents = [];
  const pushEvent = (type, payload = {}) => {
    runtimeEvents.push({ at: new Date().toISOString(), type, ...payload });
    if (runtimeEvents.length > 500) runtimeEvents.shift();
  };

  page.on('console', msg => pushEvent('console', { level: msg.type(), text: msg.text() }));
  page.on('pageerror', err => pushEvent('pageerror', { message: String(err?.message || err) }));
  page.on('dialog', dialog => pushEvent('dialog', { dialogType: dialog.type(), message: dialog.message() }));
  page.on('crash', () => pushEvent('crash'));
  page.on('close', () => pushEvent('close'));

  return { browser, context, page, debugDir, runtimeEvents };
}

// Playwright nie udostepnia publicznego dostepu do PID lokalnie uruchomionej
// przegladarki (moze tez byc podlaczona zdalnie przez CDP), wiec nie da sie
// stad zrobic celowanego SIGKILL na zawieszonym procesie Chromium. To, co
// faktycznie DA sie zrobic bezpiecznie: nigdy nie czekac na close() w
// nieskonczonosc - jesli przegladarka nie zamyka sie w rozsadnym czasie
// (np. renderer padl w polowie), i tak zwalniamy miejsce w kolejce
// (heavyJobQueue) zamiast blokowac WSZYSTKIE kolejne zadania na zawsze, i
// jawnie logujemy to zdarzenie, zeby bylo widoczne w diagnostyce/panelu
// admina zamiast cicho zniknac. Supervisor w korzennym server.js i tak
// restartuje caly proces formularze-ecodan po awarii, co ostatecznie
// sprzata kazdy zombie-proces potomny.
async function closeWithTimeout(closeable, timeoutMs = 8000) {
  if (!closeable) return false;
  let timedOut = false;
  const timeout = new Promise(resolve => {
    setTimeout(() => { timedOut = true; resolve(); }, timeoutMs);
  });
  try {
    await Promise.race([closeable.close(), timeout]);
  } catch (_) {
    // Samo zamkniecie rzucilo blad - i tak idziemy dalej, nic wiecej nie da
    // sie tu zrobic bez dostepu do PID.
  }
  return timedOut;
}

export async function closeAutomationSession(session) {
  if (!session) return;
  const contextTimedOut = await closeWithTimeout(session.context);
  const browserTimedOut = await closeWithTimeout(session.browser);
  if (contextTimedOut || browserTimedOut) {
    appendJsonLine(path.join(getProjectRoot(), 'logs', 'formularze-ecodan.jsonl'), {
      level: 'warn',
      event: 'browser-close-timeout',
      contextTimedOut,
      browserTimedOut,
    });
  }
}
