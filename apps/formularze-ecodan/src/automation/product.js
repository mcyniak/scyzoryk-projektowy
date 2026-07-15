import { SHORT_WAIT } from '../config.js';
import { saveDebug } from '../debug.js';
import { clickNext, waitForUiSettled } from './steps.js';

function isClosedSessionText(value = '') {
  return /Target page, context or browser has been closed|Page closed|Browser has been closed|browser.*closed|context.*closed|page.*closed/i.test(String(value || ''));
}

function assertPageStillOpen(page, place = 'operacja') {
  if (!page || page.isClosed()) {
    throw new Error(`Target page, context or browser has been closed podczas: ${place}`);
  }
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeProductToken(value) {
  return String(value || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/Ł/g, 'L')
    .replace(/[^A-Z0-9]/g, '');
}

export function normalizeProductReadable(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .replace(/[–—]/g, '-')
    .trim();
}

export function expectedProductParts(result) {
  const calculated = result?.calculated || {};
  return {
    expectedText: calculated.productSearchText || '',
    outdoorModel: calculated.outdoorUnitModel || calculated.outdoorUnit || '',
    indoorUnit: calculated.indoorUnit || '',
    cascadeCount: Number(calculated.cascadeCount || 1)
  };
}

export function extractSelectedProductFromText(text) {
  const source = String(text || '').replace(/\r/g, '');
  const match = source.match(/Wybrany produkt:\s*([^\n]+)/i);
  return match ? match[1].trim() : '';
}

export function buildProductMismatchMessage(pdfText, result) {
  const { expectedText, outdoorModel, indoorUnit } = expectedProductParts(result);
  const found = extractSelectedProductFromText(pdfText) || 'nie udało się odczytać pola "Wybrany produkt"';
  return `PDF ma zły produkt. Oczekiwano: ${expectedText || `${outdoorModel} + ${indoorUnit}`}. W PDF jest: ${found}`;
}

export function productMatchesExpectation(rawText, result, options = {}) {
  const { outdoorModel, indoorUnit } = expectedProductParts(result);
  const norm = normalizeProductToken(rawText);
  const outdoorNorm = normalizeProductToken(outdoorModel);
  const indoorNorm = normalizeProductToken(indoorUnit);

  if (!norm || !outdoorNorm || !indoorNorm) return false;
  if (options.forceOnlyShwm !== false && !norm.includes('PUZSHWM')) return false;
  if (/PUZWZ|ERPT|EHPT|ERPX/.test(norm)) return false;

  return norm.includes(outdoorNorm) && norm.includes(indoorNorm);
}

export async function readSelectedProductOnResultPage(page) {
  return await page.evaluate(() => {
    const readable = value => String(value || '').replace(/\s+/g, ' ').trim();
    const normalize = value => readable(value)
      .toUpperCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/Ł/g, 'L')
      .replace(/[^A-Z0-9]/g, '');
    const isVisible = el => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 2 && rect.height > 2 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    };

    // Najpewniejsze źródło prawdy na ekranie Wynik: karta produktu ma klasę selected.
    const selectedCards = Array.from(document.querySelectorAll('.wynik-products-productCard.selected'))
      .filter(isVisible)
      .map(card => {
        const heading = card.querySelector('.wynik-products-productCard-heading');
        const txt = readable(heading?.innerText || heading?.textContent || card.innerText || card.textContent || '');
        const rect = card.getBoundingClientRect();
        return { txt, norm: normalize(txt), area: rect.width * rect.height };
      })
      .filter(item => /PUZ|ERST|ERSF|ERPT|EHPT|ERPX/.test(item.norm))
      .sort((a, b) => b.area - a.area);

    if (selectedCards[0]) return selectedCards[0].txt;

    // Fallback tylko diagnostyczny: lewy panel raportu/wyboru, jeśli strona tak go renderuje.
    const bodyText = document.body.innerText || '';
    const bodyMatch = bodyText.match(/Wybrany produkt:\s*([^\n]+)/i);
    if (bodyMatch && readable(bodyMatch[1])) return readable(bodyMatch[1]);

    return '';
  });
}

export async function assertSelectedExpectedProduct(page, result, opts = {}) {
  const timeout = opts.timeout ?? 2500;
  const deadline = Date.now() + timeout;
  let last = '';

  while (Date.now() < deadline) {
    if (page.isClosed()) throw new Error('Strona została zamknięta podczas sprawdzania zaznaczonego produktu.');
    last = await readSelectedProductOnResultPage(page).catch(() => '');
    if (productMatchesExpectation(last, result, opts)) {
      return { ok: true, selected: last };
    }
    await page.waitForTimeout(150);
  }

  throw new Error(`Nie potwierdzono wyboru oczekiwanego produktu na stronie Wynik. Odczytano: ${last || '(brak)'}`);
}


export async function snapshotProductCards(page, expectedPayload = null) {
  return await page.evaluate(({ expectedNorm } = {}) => {
    const readable = value => String(value || '').replace(/\s+/g, ' ').trim();
    const normalize = value => readable(value)
      .toUpperCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/Ł/g, 'L')
      .replace(/[^A-Z0-9]/g, '');
    const isVisible = el => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 2 && rect.height > 2 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    };

    return Array.from(document.querySelectorAll('.wynik-products-productCard'))
      .map((card, index) => {
        const heading = card.querySelector('.wynik-products-productCard-heading');
        const button = card.closest('button, [role="button"], a');
        const text = readable(heading?.innerText || heading?.textContent || '');
        const norm = normalize(text);
        const rect = card.getBoundingClientRect();
        return {
          index,
          text,
          norm,
          visible: isVisible(card) && !!button,
          selected: String(card.className || '').includes('selected'),
          exactExpected: expectedNorm ? norm === expectedNorm : false,
          rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
          buttonTag: button ? button.tagName.toLowerCase() : null,
          buttonClass: button ? String(button.className || '') : ''
        };
      })
      .filter(item => item.text)
      .slice(0, 80);
  }, expectedPayload || {}).catch(error => {
    if (isClosedSessionText(error?.message || error)) throw error;
    return [];
  });
}

export async function confirmExpectedProductCardSelected(page, result, timeout = 3500) {
  const { expectedText, outdoorModel, indoorUnit } = expectedProductParts(result);
  const targetCardText = `${outdoorModel} + ${indoorUnit}`;
  const targetNorm = normalizeProductToken(targetCardText);
  const deadline = Date.now() + timeout;
  let last = [];

  while (Date.now() < deadline) {
    last = await snapshotProductCards(page, { expectedNorm: targetNorm });
    const selectedExpected = last.find(card => card.visible && card.selected && card.norm === targetNorm);
    if (selectedExpected) return { ok: true, selected: selectedExpected, cards: last };
    await page.waitForTimeout(120);
  }

  const selected = last.filter(card => card.selected).map(card => card.text).join(' | ') || '(brak zaznaczonej karty)';
  throw new Error(`Nie potwierdzono zaznaczenia karty ${targetCardText} (oczekiwany zestaw: ${expectedText}). Aktualnie zaznaczone: ${selected}`);
}

export async function applyProductFilters(page, result) {
  const { outdoorModel } = expectedProductParts(result);

  // Filtry nie są źródłem prawdy, ale zmniejszają ryzyko, że strona sama trzyma monoblok R290.
  // Klikamy tylko konkretne przyciski filtrów, bez zgadywania po współrzędnych.
  const tryToggle = async (label) => {
    const btn = page.getByRole('button', { name: new RegExp(`^${escapeRegExp(label)}$`, 'i') }).first();
    if (await btn.count().catch(() => 0) === 0) return false;
    const className = await btn.evaluate(el => String(el.className || '')).catch(() => '');
    const aria = await btn.getAttribute('aria-pressed').catch(() => null);
    const already = /Mui-selected|selected|active/i.test(className) || aria === 'true';
    if (!already) {
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await btn.click({ timeout: 3000 }).catch(() => {});
      await waitForUiSettled(page, { timeout: 1200, stableMs: 120 }).catch(() => {});
    }
    return true;
  };

  if (/SHWM/i.test(outdoorModel)) {
    await tryToggle('ZUBADAN INVERTER');
  }
  if (/YAA/i.test(outdoorModel)) {
    await tryToggle('TRZY FAZY (400 V)');
  } else if (/VAA/i.test(outdoorModel)) {
    await tryToggle('JEDNA FAZA (230 V)');
  }
}

export async function clickExpectedProductCard(page, result) {
  const { expectedText, outdoorModel, indoorUnit } = expectedProductParts(result);
  const targetCardText = `${outdoorModel} + ${indoorUnit}`;
  const targetNorm = normalizeProductToken(targetCardText);

  if (!outdoorModel || !indoorUnit || !targetNorm) {
    throw new Error('Brak modelu zewnętrznego lub wewnętrznego do wyboru produktu.');
  }

  assertPageStillOpen(page, 'start wyboru produktu');
  await page.waitForURL(/\/wynik/, { timeout: 30000 }).catch(error => {
    if (isClosedSessionText(error?.message || error)) throw error;
  });
  assertPageStillOpen(page, 'oczekiwanie na stronę wynik');
  await page.waitForSelector('.wynik-products-productCard-heading', { state: 'attached', timeout: 30000 });
  assertPageStillOpen(page, 'po załadowaniu listy produktów');
  await applyProductFilters(page, result).catch(error => {
    if (isClosedSessionText(error?.message || error)) throw error;
  });
  assertPageStillOpen(page, 'po filtrach produktu');

  const headingRegex = new RegExp(`^\\s*${escapeRegExp(outdoorModel)}\\s*\\+\\s*${escapeRegExp(indoorUnit)}\\s*$`, 'i');
  const heading = page.locator('.wynik-products-productCard-heading').filter({ hasText: headingRegex }).first();

  try {
    await heading.waitFor({ state: 'attached', timeout: 20000 });
  } catch (error) {
    // W trybie równoległym my-ecodan/Chrome potrafi czasem zamknąć stronę.
    // Tego nie traktujemy jako "brak produktu", tylko jako błąd sesji, żeby jobs.js zrobił restart i ponowił ten sam wiersz.
    if (page.isClosed() || isClosedSessionText(error?.message || error)) {
      throw new Error(`Target page, context or browser has been closed podczas szukania karty produktu: ${targetCardText}`);
    }
    const cards = await snapshotProductCards(page, { expectedNorm: targetNorm });
    await saveDebug(page, 'product-card-not-found', JSON.stringify({ expected: targetCardText, cards }, null, 2), {
      expected: { expectedText, targetCardText, outdoorModel, indoorUnit, expectedNorm: targetNorm },
      cards
    });
    throw new Error(`Nie znaleziono dokładnej karty produktu: ${targetCardText}. Nie pobieram PDF.`);
  }

  const card = heading.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " wynik-products-productCard ")][1]');
  const button = card.locator('xpath=ancestor-or-self::button[1]');

  assertPageStillOpen(page, `przed kliknięciem karty produktu ${targetCardText}`);
  await button.scrollIntoViewIfNeeded();
  await page.waitForTimeout(SHORT_WAIT);
  assertPageStillOpen(page, `po przewinięciu karty produktu ${targetCardText}`);
  await button.click({ timeout: 10000 });

  try {
    const confirmed = await confirmExpectedProductCardSelected(page, result, 4000);
    const selectedRead = await assertSelectedExpectedProduct(page, result, { forceOnlyShwm: true, timeout: 2000 });
    return {
      ok: true,
      method: 'exact-product-card-locator-click',
      expected: { expectedText, targetCardText, outdoorModel, indoorUnit, expectedNorm: targetNorm },
      confirmed,
      selectedRead
    };
  } catch (error) {
    const cards = await snapshotProductCards(page, { expectedNorm: targetNorm });
    await saveDebug(page, 'product-selection-not-confirmed', String(error?.stack || error?.message || error), {
      expected: { expectedText, targetCardText, outdoorModel, indoorUnit, expectedNorm: targetNorm },
      selectedOnPage: await readSelectedProductOnResultPage(page).catch(() => ''),
      cards
    });
    throw new Error(`Kliknięto kartę ${targetCardText}, ale strona nie potwierdziła zaznaczenia. Nie pobieram PDF.`);
  }
}


export async function chooseProduct(page, result) {
  await page.waitForURL(/\/wynik/, { timeout: 30000 }).catch(() => {});
  await clickExpectedProductCard(page, result);
  await clickNext(page, /\/raport/);
}
