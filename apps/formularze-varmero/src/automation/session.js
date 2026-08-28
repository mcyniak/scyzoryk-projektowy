// 1:1 wzor z apps/formularze-ecodan/src/automation/session.js - launch
// Chromium, kontekst z zablokowanymi animacjami, ring-buffer runtime
// eventow do debugu. Geolokalizacja/mapa zostawiona z tego samego wzorca,
// mimo ze kalkulator Varmero jej nie uzywa (nieszkodliwa, spojnosc z
// Ecodanem wazniejsza niz oszczedzenie kilku linii).
import fs from 'fs/promises';
import path from 'path';
import { chromium } from 'playwright';
import { BROWSER_VIEWPORT, HEADLESS_DEFAULT } from '../config.js';

export async function createAutomationSession(outputDir) {
  const debugDir = path.join(outputDir, 'debug');
  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(debugDir, { recursive: true });
  await fs.mkdir(path.join(outputDir, 'downloads'), { recursive: true });

  const browser = await chromium.launch({
    headless: HEADLESS_DEFAULT,
    downloadsPath: path.join(outputDir, 'downloads'),
    args: ['--lang=pl-PL', '--disable-features=Translate,TranslateUI']
  });

  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: BROWSER_VIEWPORT,
    deviceScaleFactor: 1,
    locale: 'pl-PL'
  });

  context.setDefaultTimeout(8000);
  context.setDefaultNavigationTimeout(25000);

  await context.addInitScript(() => {
    const inject = () => {
      if (!document.documentElement) return;
      if (document.getElementById('__varmero_no_anim')) return;
      const style = document.createElement('style');
      style.id = '__varmero_no_anim';
      style.textContent = '*{scroll-behavior:auto!important;animation-duration:0.001s!important;transition-duration:0.001s!important;}';
      document.documentElement.appendChild(style);
    };
    inject();
    document.addEventListener('DOMContentLoaded', inject, { once: true });
  }).catch(() => {});

  const page = await context.newPage();
  page.__varmeroOutputRoot = outputDir;

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

// Jak w apps/formularze-ecodan/src/automation/session.js: bez limitu czasu
// zawieszony close() blokowalby zakonczenie i anulowanie zadania na zawsze.
// Blad samego close() nadal celowo polykamy.
const CLOSE_TIMEOUT_MS = Number(process.env.SCYZORYK_CLOSE_TIMEOUT_MS) || 12000;

async function closeWithTimeout(closable) {
  if (!closable) return;
  let timer = null;
  try {
    await Promise.race([
      closable.close().catch(() => {}),
      new Promise(resolve => { timer = setTimeout(resolve, CLOSE_TIMEOUT_MS); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function closeAutomationSession(session) {
  if (!session) return;
  await closeWithTimeout(session.context);
  await closeWithTimeout(session.browser);
}
