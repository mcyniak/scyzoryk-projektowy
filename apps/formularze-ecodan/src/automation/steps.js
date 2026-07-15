import path from 'path';
import sanitize from 'sanitize-filename';
import { SHORT_WAIT, MEDIUM_WAIT, STEP_TIMEOUT, SLOW_MODE } from '../config.js';
import { saveDebug } from '../debug.js';

export const CWU_Q1_RE = /Czy pompa ciepła ma podgrzewać ciepłą wodę użytkową/i;
export const CWU_Q2_RE = /Zasobnik ciepłej wody użytkowej zintegrowany z jednostką wewnętrzną/i;

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function waitForUiSettled(page, opts = {}) {
  const timeout = opts.timeout ?? (SLOW_MODE ? 3000 : 550);
  const stableMs = opts.stableMs ?? (SLOW_MODE ? 300 : 90);
  const started = Date.now();
  let lastSignature = '';
  let stableFor = 0;

  while (Date.now() - started < timeout) {
    if (page.isClosed()) throw new Error('Strona została zamknięta podczas oczekiwania na ustabilizowanie UI.');

    const signature = await page.evaluate(() => {
      const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
      const isVisible = el => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 2 && rect.height > 2 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      };
      const buttons = Array.from(document.querySelectorAll('button'))
        .filter(isVisible)
        .map(btn => {
          const s = window.getComputedStyle(btn);
          return [
            normalize(btn.innerText || btn.textContent),
            btn.getAttribute('aria-pressed') || '',
            btn.getAttribute('aria-selected') || '',
            String(btn.className || ''),
            s.color,
            s.borderColor,
            s.backgroundColor
          ].join('|');
        })
        .join('||');
      return `${location.pathname}::${buttons}`;
    });

    if (signature === lastSignature) {
      stableFor += 100;
      if (stableFor >= stableMs) break;
    } else {
      lastSignature = signature;
      stableFor = 0;
    }
    await page.waitForTimeout(100);
  }

  await page.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  }).catch(() => {});
}

export async function readLocatorVisualState(locator) {
  if (!locator) return { exists: false, visible: false, selected: false };
  const count = await locator.count().catch(() => 0);
  if (!count) return { exists: false, visible: false, selected: false };

  const target = locator.first();
  const box = await target.boundingBox().catch(() => null);
  const payload = await target.evaluate(el => {
    const style = window.getComputedStyle(el);
    return {
      text: String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(),
      outerHTML: el.outerHTML,
      className: String(el.className || ''),
      attrs: {
        ariaPressed: el.getAttribute('aria-pressed'),
        ariaSelected: el.getAttribute('aria-selected'),
        disabled: el.getAttribute('disabled'),
        currentitem: el.getAttribute('currentitem')
      },
      css: {
        color: style.color,
        borderColor: style.borderColor,
        backgroundColor: style.backgroundColor,
        opacity: style.opacity,
        fontWeight: style.fontWeight
      }
    };
  }).catch(() => null);

  if (!payload) return { exists: true, visible: !!box, selected: false, box };
  const styleBlob = `${payload.className} ${payload.css.color} ${payload.css.borderColor} ${payload.css.backgroundColor}`;
  const selected =
    payload.attrs.ariaPressed === 'true' ||
    payload.attrs.ariaSelected === 'true' ||
    /\b(Mui-selected|MuiButton-outlinedPrimary|selected|active)\b/i.test(payload.className) ||
    /245,\s*15,\s*16/.test(styleBlob);

  return { exists: true, visible: !!box, selected, box, ...payload };
}

export async function findNearestAnswerButton(page, questionRegex, answerText) {
  const question = page.getByText(questionRegex).first();
  await question.waitFor({ state: 'visible', timeout: 15000 });
  const qBox = await question.boundingBox();
  if (!qBox) throw new Error(`Nie udało się odczytać położenia pytania: ${questionRegex}`);

  const candidates = page.getByRole('button', { name: new RegExp(`^${escapeRegExp(answerText)}$`, 'i') });
  const count = await candidates.count();
  let best = null;
  const scanned = [];

  for (let i = 0; i < count; i++) {
    const loc = candidates.nth(i);
    const box = await loc.boundingBox().catch(() => null);
    if (!box) continue;

    const verticallyClose = box.y >= qBox.y - 20 && box.y <= qBox.y + qBox.height + 190;
    if (!verticallyClose) continue;

    const score = Math.abs(box.y - (qBox.y + qBox.height + 18)) * 10 + Math.abs(box.x - qBox.x);
    scanned.push({ index: i, box, score });
    if (!best || score < best.score) best = { index: i, locator: loc, box, score };
  }

  if (!best) throw new Error(`Nie znaleziono przycisku "${answerText}" w pobliżu pytania ${questionRegex}`);
  return { locator: candidates.nth(best.index), meta: { questionBox: qBox, chosenIndex: best.index, candidates: scanned } };
}

export async function captureQuestionState(page, questionRegex) {
  const question = page.getByText(questionRegex).first();
  const questionText = await question.evaluate(el => String(el.innerText || el.textContent || '')).catch(() => null);
  const questionBox = await question.boundingBox().catch(() => null);
  let yes = null;
  let no = null;

  try {
    const foundYes = await findNearestAnswerButton(page, questionRegex, 'TAK');
    yes = { meta: foundYes.meta, state: await readLocatorVisualState(foundYes.locator) };
  } catch (error) { yes = { error: String(error?.message || error) }; }

  try {
    const foundNo = await findNearestAnswerButton(page, questionRegex, 'NIE');
    no = { meta: foundNo.meta, state: await readLocatorVisualState(foundNo.locator) };
  } catch (error) { no = { error: String(error?.message || error) }; }

  return { questionText, questionBox, yes, no };
}

export async function findLeftTankTile(page, tankLitres) {
  const re = new RegExp(`^ZASOBNIK\\s*${escapeRegExp(String(tankLitres))}L$`, 'i');
  const viewport = page.viewportSize() || { width: 1536, height: 864 };
  const textCandidates = page.getByText(re);
  const count = await textCandidates.count();
  let best = null;
  const scanned = [];

  for (let i = 0; i < count; i++) {
    let loc = textCandidates.nth(i);
    let box = await loc.boundingBox().catch(() => null);
    if (!box) continue;

    const ancestor = loc.locator('xpath=ancestor-or-self::*[self::button or self::div][1]').first();
    const ancestorBox = await ancestor.boundingBox().catch(() => null);
    if (ancestorBox) { loc = ancestor; box = ancestorBox; }

    // tylko lewa lista, nie grafika po prawej stronie
    if (box.x > viewport.width * 0.58) continue;

    const score = box.x * 5 + box.y;
    scanned.push({ index: i, box, score });
    if (!best || score < best.score) best = { index: i, locator: loc, box, score };
  }

  if (!best) throw new Error(`Nie znaleziono lewego kafelka ZASOBNIK ${tankLitres}L`);
  return { locator: best.locator, meta: { chosenIndex: best.index, viewport, candidates: scanned } };
}

export async function captureTankState(page, tankLitres) {
  try {
    const found = await findLeftTankTile(page, tankLitres);
    return { meta: found.meta, state: await readLocatorVisualState(found.locator) };
  } catch (error) { return { error: String(error?.message || error) }; }
}

export async function ensureQuestionAnswer(page, questionRegex, answerText, opts = {}) {
  const retries = opts.retries ?? 3;
  let last = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    if (page.isClosed()) throw new Error(`Strona została zamknięta podczas ustawiania odpowiedzi "${answerText}".`);

    const found = await findNearestAnswerButton(page, questionRegex, answerText);
    const before = await readLocatorVisualState(found.locator);
    if (before.selected) return { attempt, changed: false, before, after: before, meta: found.meta };

    await found.locator.scrollIntoViewIfNeeded();
    await found.locator.click({ trial: true, timeout: 10000 });
    await found.locator.click({ timeout: 10000 });
    await waitForUiSettled(page);

    const verify = await findNearestAnswerButton(page, questionRegex, answerText);
    const after = await readLocatorVisualState(verify.locator);
    last = { attempt, changed: true, before, after, meta: verify.meta };
    if (after.selected) return last;
  }
  throw new Error(`Nie udało się ustawić odpowiedzi "${answerText}" dla pytania ${questionRegex}. Ostatni stan: ${JSON.stringify(last)}`);
}

export async function chooseLeftTankTile(page, tankLitres) {
  const found = await findLeftTankTile(page, tankLitres);
  const before = await readLocatorVisualState(found.locator);

  if (!before.selected) {
    await found.locator.scrollIntoViewIfNeeded();
    await found.locator.click({ trial: true, timeout: 10000 });
    await found.locator.click({ timeout: 10000 });
    await waitForUiSettled(page);
  }

  const verify = await findLeftTankTile(page, tankLitres);
  const after = await readLocatorVisualState(verify.locator);
  return { before, after, meta: verify.meta };
}

export async function captureCwuState(page, tankLitres) {
  const url = page && !page.isClosed() ? page.url() : 'PAGE_CLOSED';
  return {
    url,
    q1: await captureQuestionState(page, CWU_Q1_RE).catch(error => ({ error: String(error?.message || error) })),
    q2: await captureQuestionState(page, CWU_Q2_RE).catch(error => ({ error: String(error?.message || error) })),
    tank: await captureTankState(page, tankLitres).catch(error => ({ error: String(error?.message || error) }))
  };
}



export async function domClickByText(page, text, opts = {}) {
  const {
    occurrence = 0,
    exact = true,
    timeout = 15000,
    preferButton = true,
    name = String(text)
  } = opts;

  const deadline = Date.now() + timeout;
  let last = null;

  while (Date.now() < deadline) {
    if (page.isClosed()) throw new Error(`Strona została zamknięta podczas klikania: ${name}`);

    const result = await page.evaluate(({ text, occurrence, exact, preferButton }) => {
      const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
      const needle = normalize(text).toLowerCase();
      const isVisible = el => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 2 && rect.height > 2 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      };
      const score = el => {
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role') || '';
        let s = 0;
        if (tag === 'button') s -= 1000;
        if (role === 'button') s -= 900;
        if (preferButton && (tag === 'button' || role === 'button')) s -= 500;
        const rect = el.getBoundingClientRect();
        s += rect.width * rect.height / 100000;
        s += rect.top / 10000;
        return s;
      };

      let elements = Array.from(document.querySelectorAll('button, [role="button"], a, label, div, span, p'))
        .filter(isVisible)
        .map(el => ({ el, txt: normalize(el.innerText || el.textContent) }))
        .filter(item => {
          const txt = item.txt.toLowerCase();
          return exact ? txt === needle : txt.includes(needle);
        });

      // Usuń duże kontenery, które tylko zawierają właściwy przycisk.
      elements = elements.filter(item => {
        const rect = item.el.getBoundingClientRect();
        return rect.width < window.innerWidth * 0.95 && rect.height < window.innerHeight * 0.75;
      });

      elements.sort((a, b) => {
        const as = score(a.el);
        const bs = score(b.el);
        if (as !== bs) return as - bs;
        const ar = a.el.getBoundingClientRect();
        const br = b.el.getBoundingClientRect();
        return (ar.top - br.top) || (ar.left - br.left);
      });

      const chosen = elements[occurrence];
      if (!chosen) return { ok: false, count: elements.length, wanted: text };

      const rect = chosen.el.getBoundingClientRect();
      chosen.el.scrollIntoView({ block: 'center', inline: 'center' });
      chosen.el.click();
      return {
        ok: true,
        count: elements.length,
        clickedText: chosen.txt,
        tag: chosen.el.tagName,
        role: chosen.el.getAttribute('role') || '',
        rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height }
      };
    }, { text, occurrence, exact, preferButton });

    last = result;
    if (result.ok) return result;
    await page.waitForTimeout(250);
  }

  await saveDebug(page, `dom-click-failed-${sanitize(name)}`, JSON.stringify(last, null, 2));
  throw new Error(`Nie znaleziono elementu do kliknięcia: ${name}`);
}

export async function domClickRegex(page, pattern, opts = {}) {
  const { timeout = 15000, occurrence = 0, name = String(pattern) } = opts;
  const source = pattern instanceof RegExp ? pattern.source : String(pattern);
  const flags = pattern instanceof RegExp ? pattern.flags : 'i';
  const deadline = Date.now() + timeout;
  let last = null;

  while (Date.now() < deadline) {
    if (page.isClosed()) throw new Error(`Strona została zamknięta podczas klikania regex: ${name}`);

    const result = await page.evaluate(({ source, flags, occurrence }) => {
      const re = new RegExp(source, flags);
      const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
      const isVisible = el => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 2 && rect.height > 2 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      };
      const elements = Array.from(document.querySelectorAll('button, [role="button"], a, label, div, span, p'))
        .filter(isVisible)
        .map(el => ({ el, txt: normalize(el.innerText || el.textContent) }))
        .filter(item => re.test(item.txt))
        .filter(item => {
          const rect = item.el.getBoundingClientRect();
          return rect.width < window.innerWidth * 0.95 && rect.height < window.innerHeight * 0.75;
        })
        .sort((a, b) => {
          const ar = a.el.getBoundingClientRect();
          const br = b.el.getBoundingClientRect();
          const ab = (a.el.tagName.toLowerCase() === 'button' || a.el.getAttribute('role') === 'button') ? -1000 : 0;
          const bb = (b.el.tagName.toLowerCase() === 'button' || b.el.getAttribute('role') === 'button') ? -1000 : 0;
          return (ab - bb) || (ar.top - br.top) || (ar.left - br.left) || ((ar.width * ar.height) - (br.width * br.height));
        });

      const chosen = elements[occurrence];
      if (!chosen) return { ok: false, count: elements.length };
      const rect = chosen.el.getBoundingClientRect();
      chosen.el.scrollIntoView({ block: 'center', inline: 'center' });
      chosen.el.click();
      return { ok: true, count: elements.length, clickedText: chosen.txt, rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } };
    }, { source, flags, occurrence });

    last = result;
    if (result.ok) return result;
    await page.waitForTimeout(250);
  }

  await saveDebug(page, `dom-click-regex-failed-${sanitize(name)}`, JSON.stringify(last, null, 2));
  throw new Error(`Nie znaleziono elementu regex do kliknięcia: ${name}`);
}

async function findVisibleLocator(page, locators, timeout = 8000) {
  const deadline = Date.now() + timeout;
  let lastCount = 0;

  while (Date.now() < deadline) {
    for (const locator of locators) {
      const count = await locator.count().catch(() => 0);
      lastCount += count;
      for (let i = count - 1; i >= 0; i--) {
        const item = locator.nth(i);
        if (await item.isVisible().catch(() => false)) {
          return item;
        }
      }
    }
    await page.waitForTimeout(150);
  }

  throw new Error(`Nie znaleziono widocznego elementu. Ostatnia liczba kandydatów: ${lastCount}`);
}

export async function clickNext(page, expectedUrlRegex = null) {
  const oldUrl = page.url();

  if (expectedUrlRegex) {
    const alreadyOk = await page.evaluate(({ source, flags }) => {
      const re = new RegExp(source, flags);
      return re.test(location.href) || re.test(location.pathname);
    }, {
      source: expectedUrlRegex instanceof RegExp ? expectedUrlRegex.source : String(expectedUrlRegex),
      flags: expectedUrlRegex instanceof RegExp ? expectedUrlRegex.flags : ''
    }).catch(() => false);
    if (alreadyOk) return;
  }

  // Uwaga: tekst na stronie wizualnie jest uppercase przez CSS, ale w DOM jest często "Dalej".
  // Dlatego matcher musi być case-insensitive i musi obsłużyć wariant <a><button>Dalej</button></a>.
  const nextButton = await findVisibleLocator(page, [
    page.getByRole('button', { name: /^\s*dalej\s*$/i }),
    page.locator('a[href] button').filter({ hasText: /^\s*dalej\s*$/i }),
    page.locator('button').filter({ hasText: /^\s*dalej\s*$/i }),
    page.locator('a[href]').filter({ hasText: /^\s*dalej\s*$/i })
  ], 10000);

  await nextButton.scrollIntoViewIfNeeded().catch(() => {});
  await nextButton.click({ timeout: 8000 });

  if (expectedUrlRegex) {
    const source = expectedUrlRegex instanceof RegExp ? expectedUrlRegex.source : String(expectedUrlRegex);
    const flags = expectedUrlRegex instanceof RegExp ? expectedUrlRegex.flags : '';

    await Promise.race([
      page.waitForURL(expectedUrlRegex, { timeout: STEP_TIMEOUT }),
      page.waitForFunction(({ source, flags, oldUrl }) => {
        const re = new RegExp(source, flags);
        return re.test(location.href) || (location.href !== oldUrl && re.test(location.pathname));
      }, { source, flags, oldUrl }, { timeout: STEP_TIMEOUT })
    ]).catch(async () => {
      await page.waitForTimeout(SHORT_WAIT);
    });
  } else {
    await page.waitForTimeout(SHORT_WAIT);
  }
}

export async function fillVisibleField(page, locator, value, opts = {}) {
  const { timeout = 15000 } = opts;
  const field = locator.filter({ visible: true }).first();
  await field.waitFor({ state: 'visible', timeout });
  await field.scrollIntoViewIfNeeded().catch(() => {});
  await field.fill(String(value ?? ''));
  return field;
}

export async function fillLocationField(page, location) {
  const value = String(location || '62-561 Ślesin').trim();
  const fields = page.locator('input[placeholder*="lokal" i], input[placeholder*="kod" i], input[aria-label*="lokal" i], input, textarea');
  const field = await fillVisibleField(page, fields, value);

  // Strona po wpisaniu kodu nie przechodzi dalej, dopóki nie zostanie wybrana
  // konkretna pozycja z podpowiedzi/autocomplete. Sam Enter bywa za szybki.
  await page.waitForTimeout(350);

  const selected = await selectLocationSuggestion(page, value).catch(() => false);
  if (!selected) {
    await field.focus().catch(() => {});
    await page.keyboard.press('ArrowDown').catch(() => {});
    await page.waitForTimeout(120);
    await page.keyboard.press('Enter').catch(() => {});
  }

  await page.waitForTimeout(350);
  return field;
}

export async function selectLocationSuggestion(page, location) {
  const wanted = normalizeText(location);
  const suggestion = await page.evaluate(({ wanted }) => {
    const normalize = value => String(value || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    const isVisible = el => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 2 && rect.height > 2 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    };
    const scoreElement = el => {
      const text = normalize(el.innerText || el.textContent || '');
      if (!text) return null;
      const role = el.getAttribute('role') || '';
      const tag = el.tagName.toLowerCase();
      const rect = el.getBoundingClientRect();
      let score = rect.top / 1000;
      if (role === 'option') score -= 200;
      if (tag === 'li') score -= 120;
      if (tag === 'button') score -= 80;
      if (text === wanted) score -= 1000;
      if (wanted && text.includes(wanted)) score -= 500;
      if (/strefa|wojewodztwo|województwo|wielkopolskie|slesin|ślesin|62-561/.test(text)) score -= 80;
      if (rect.width > window.innerWidth * 0.95 || rect.height > window.innerHeight * 0.55) score += 10000;
      return { text, score, rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } };
    };

    const selectors = [
      '[role="option"]',
      '[role="listbox"] li',
      '.MuiAutocomplete-option',
      '.pac-item',
      'li',
      'button',
      '[role="button"]',
      'div'
    ];
    const seen = new Set();
    const candidates = [];
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (seen.has(el) || !isVisible(el)) continue;
        seen.add(el);
        const item = scoreElement(el);
        if (!item) continue;
        const useful = item.text.includes(wanted) || /strefa|wojewodztwo|województwo|wielkopolskie|slesin|ślesin|62-561/.test(item.text);
        if (!useful) continue;
        candidates.push({ el, ...item, selector });
      }
    }
    candidates.sort((a, b) => a.score - b.score);
    const chosen = candidates[0];
    if (!chosen) return { ok: false, candidates: candidates.slice(0, 8).map(({ el, ...rest }) => rest) };
    chosen.el.scrollIntoView({ block: 'center', inline: 'center' });
    chosen.el.click();
    return { ok: true, clickedText: chosen.text, selector: chosen.selector, score: chosen.score, rect: chosen.rect, candidates: candidates.slice(0, 8).map(({ el, ...rest }) => rest) };
  }, { wanted });

  if (!suggestion?.ok) return false;
  await waitForUiSettled(page, { timeout: 1200, stableMs: 150 });
  return true;
}

export function normalizeText(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export async function fillHeatingLoadField(page, ozc) {
  const panel = page.locator('#simple-tabpanel-mocPompy');
  const panelInputs = panel.locator('input').filter({ visible: true });
  if (await panelInputs.count().catch(() => 0)) {
    return fillVisibleField(page, panelInputs, ozc);
  }
  const bodyInput = page.locator('input').filter({ visible: true });
  return fillVisibleField(page, bodyInput, ozc);
}

async function goToPowerStepFromClimate(page) {
  const beforeUrl = page.url();

  // Na kroku Strefa klimatyczna strona my-ecodan potrafi nie mieć dolnego
  // przycisku DALEJ. Wtedy przejście robi się przez pasek kroków u góry
  // (link /szacowanie-mocy). Dlatego DALEJ jest tylko pierwszą próbą,
  // a nie wymaganym elementem.
  const nextButton = page.locator('button').filter({ hasText: /^\s*dalej\s*$/i }).last();
  const hasNext = await nextButton.count().catch(() => 0);

  if (hasNext > 0 && await nextButton.isVisible().catch(() => false)) {
    const disabled = await nextButton.evaluate(el => el.disabled || el.getAttribute('aria-disabled') === 'true' || /disabled/i.test(String(el.className || ''))).catch(() => false);
    if (!disabled) {
      await nextButton.scrollIntoViewIfNeeded().catch(() => {});
      await nextButton.click({ timeout: 5000 }).catch(() => {});
      const movedByNext = await page.waitForURL(/\/szacowanie-mocy/, { timeout: 4000 }).then(() => true).catch(() => false);
      if (movedByNext || /\/szacowanie-mocy/.test(page.url())) return;
    }
  }

  const stepLink = page.locator('a[href="/szacowanie-mocy"], a[href*="szacowanie-mocy"]').first();
  if (await stepLink.count().catch(() => 0)) {
    await stepLink.waitFor({ state: 'visible', timeout: 10000 });
    await stepLink.scrollIntoViewIfNeeded().catch(() => {});
    await stepLink.click({ timeout: 5000 });
  } else {
    await page.goto(new URL('/szacowanie-mocy', page.url()).toString(), { waitUntil: 'domcontentloaded', timeout: 15000 });
  }

  const moved = await page.waitForURL(/\/szacowanie-mocy/, { timeout: 12000 }).then(() => true).catch(() => false);
  if (!moved && !/\/szacowanie-mocy/.test(page.url())) {
    await saveDebug(page, 'location-did-not-advance', `Po wybraniu lokalizacji nie udało się przejść do Szacowanie mocy. Przed: ${beforeUrl}, teraz: ${page.url()}`);
    throw new Error('Po wybraniu lokalizacji strona nie przeszła do kroku Szacowanie mocy.');
  }
}

export async function chooseLocation(page, location) {
  await fillLocationField(page, location || '62-561 Ślesin');
  await waitForUiSettled(page, { timeout: 1600, stableMs: 180 });
  await goToPowerStepFromClimate(page);

  if (!/\/szacowanie-mocy/.test(page.url())) {
    await saveDebug(page, 'location-still-not-on-power-step', `Po chooseLocation aktualny URL to: ${page.url()}`);
    throw new Error(`Po wybraniu lokalizacji nie jesteśmy na /szacowanie-mocy, tylko na: ${page.url()}`);
  }
}

export async function choosePowerMethodAndOzc(page, result) {
  await page.waitForURL(/\/szacowanie-mocy/, { timeout: 30000 }).catch(() => {});
  await page.waitForSelector('button.mocPompy, [role="tab"]', { state: 'visible', timeout: 20000 });

  let tab = page.locator('button.mocPompy').first();
  if (await tab.count().catch(() => 0) === 0) {
    tab = page.getByRole('tab', { name: /^Moc pompy$/i }).first();
  }

  await tab.waitFor({ state: 'visible', timeout: 15000 });
  await tab.scrollIntoViewIfNeeded();
  await tab.click({ timeout: 10000 });

  await page.waitForFunction(() => {
    const tabEl = document.querySelector('button.mocPompy');
    const panel = document.querySelector('#simple-tabpanel-mocPompy');
    const tabSelected = !!tabEl && (
      tabEl.getAttribute('aria-selected') === 'true' ||
      String(tabEl.className || '').includes('Mui-selected')
    );
    const panelVisible = !!panel && !panel.hasAttribute('hidden') && window.getComputedStyle(panel).display !== 'none';
    const text = document.body.innerText || '';
    return tabSelected || panelVisible || /Obciążenie\s+cieplne/i.test(text);
  }, { timeout: 15000 });

  await page.waitForTimeout(SHORT_WAIT);
  await fillHeatingLoadField(page, result.input.ozc);
  await page.waitForTimeout(SHORT_WAIT);

  // Strona czasem sama przechodzi dalej po zmianie OZC albo po poprzednim stanie sesji.
  // Nie wolno wtedy klikać przycisku DALEJ z następnego kroku, bo przeskoczymy za daleko.
  if (/\/dane-instalacji/.test(page.url()) || /\/podgrzewanie-wody/.test(page.url())) {
    return;
  }

  await clickNext(page, /\/(dane-instalacji|podgrzewanie-wody)/);
}

async function goToInstallationStep(page) {
  if (/\/dane-instalacji/.test(page.url())) return;

  const link = page.locator('a[href="/dane-instalacji"], a[href*="dane-instalacji"]').first();
  if (await link.count().catch(() => 0)) {
    await link.waitFor({ state: 'visible', timeout: 10000 });
    await link.scrollIntoViewIfNeeded().catch(() => {});
    await link.click({ timeout: 8000 });
    await page.waitForURL(/\/dane-instalacji/, { timeout: 15000 }).catch(() => {});
  } else {
    await page.goto(new URL('/dane-instalacji', page.url()).toString(), { waitUntil: 'domcontentloaded', timeout: 15000 });
  }

  if (!/\/dane-instalacji/.test(page.url())) {
    await saveDebug(page, 'receiver-not-on-installation-step', `Nie udało się przejść na Dane instalacji. Aktualny URL: ${page.url()}`);
    throw new Error(`Nie udało się przejść na krok Dane instalacji. Aktualny URL: ${page.url()}`);
  }
}

export async function chooseReceiver(page, result) {
  await goToInstallationStep(page);

  const receiverText = result.calculated.receiver.toUpperCase();
  const receiver = page.getByText(new RegExp(`^\\s*${escapeRegExp(receiverText)}\\s*$`, 'i')).first();
  await receiver.waitFor({ state: 'visible', timeout: 15000 });
  await receiver.scrollIntoViewIfNeeded().catch(() => {});
  await receiver.click({ timeout: 10000 });
  await page.waitForTimeout(SHORT_WAIT);
  await clickNext(page, /\/podgrzewanie-wody/);
}

export async function chooseCwu(page, result) {
  const tankLitres = Number(result.calculated.tankLitres || 200);
  const integratedChoice = result.calculated.integratedTank === 'TAK' ? 'TAK' : 'NIE';

  await page.waitForURL(/\/podgrzewanie-wody/, { timeout: 30000 }).catch(() => {});
  await page.getByText(CWU_Q1_RE).first().waitFor({ state: 'visible', timeout: 20000 });
  await waitForUiSettled(page);

  try {
    await ensureQuestionAnswer(page, CWU_Q1_RE, 'TAK');

    // Zasobnik potrafi przeliczyć/odświeżyć część formularza, dlatego po nim walidujemy pytania jeszcze raz.
    await chooseLeftTankTile(page, tankLitres);

    await ensureQuestionAnswer(page, CWU_Q2_RE, integratedChoice);
    await ensureQuestionAnswer(page, CWU_Q1_RE, 'TAK');
    await ensureQuestionAnswer(page, CWU_Q2_RE, integratedChoice);

    const finalState = await captureCwuState(page, tankLitres);
    const q1YesSelected = !!finalState?.q1?.yes?.state?.selected;
    const q2YesSelected = !!finalState?.q2?.yes?.state?.selected;
    const q2NoSelected = !!finalState?.q2?.no?.state?.selected;

    if (!q1YesSelected) throw new Error('Po finalnej weryfikacji pytanie CWU nie ma zaznaczonego TAK.');
    if (integratedChoice === 'TAK' && !q2YesSelected) {
      throw new Error('Po finalnej weryfikacji pytanie o zasobnik zintegrowany nie ma zaznaczonego TAK.');
    }
    if (integratedChoice === 'NIE' && !q2NoSelected) {
      throw new Error('Po finalnej weryfikacji pytanie o zasobnik zintegrowany nie ma zaznaczonego NIE.');
    }

    await waitForUiSettled(page);
    await clickNext(page, /\/wynik/);
  } catch (error) {
    const state = await captureCwuState(page, tankLitres).catch(() => null);
    await saveDebug(page, 'cwu-state-failed', String(error?.stack || error?.message || error), {
      expected: { q1: 'TAK', q2: integratedChoice, tankLitres },
      state
    });
    throw error;
  }
}


export async function downloadReport(page, result, input, outputDir) {
  await page.waitForURL(/\/raport/, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(MEDIUM_WAIT);

  const downloadText = /Pobierz raport/i;
  await page.getByText(downloadText).first().waitFor({ state: 'visible', timeout: 45000 });
  const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
  await page.getByText(downloadText).first().click({ timeout: 10000 });
  const download = await downloadPromise;

  const filename = sanitize(`${input.address || 'raport'} - ${input.name || 'dobor'}.pdf`);
  const savePath = path.join(outputDir, filename);
  await download.saveAs(savePath);
  return savePath;
}
