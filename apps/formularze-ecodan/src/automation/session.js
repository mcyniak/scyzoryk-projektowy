import fs from 'fs/promises';
import path from 'path';
import { chromium } from 'playwright';
import { BROWSER_VIEWPORT, BLOCK_HEAVY_ASSETS, SLOW_MODE, HEADLESS_DEFAULT } from '../config.js';

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

export async function closeAutomationSession(session) {
  if (!session) return;
  await session.context?.close().catch(() => {});
  await session.browser?.close().catch(() => {});
}
