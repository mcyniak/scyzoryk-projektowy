// Wypelnianie kalkulatora Varmero - w odroznieniu od Ecodana (niesemantyczny
// MUI, wymaga heurystycznego "klikania po tekscie"), formularz Varmero to
// zwykle, semantyczne <select>/<input>/<label> - da sie uzywac
// page.getByLabel() wprost, bez ciezkich helperow z Ecodana steps.js.
// Wszystkie etykiety/opcje ponizej sa dokladnie tymi, ktore potwierdzilem
// na zywej stronie w tej sesji (patrz plan).
const CALCULATOR_URL = 'https://varmero.pl/instalator/kalkulator-doboru-urzadzenia/';

const ZONE_OPTION_TEXT = {
  1: 'Strefa I (-16 ℃)',
  2: 'Strefa II (-18 ℃)',
  3: 'Strefa III (-20 ℃)',
  4: 'Strefa IV (-22 ℃)',
  5: 'Strefa V (-24 ℃)'
};

export async function gotoCalculator(page) {
  await page.goto(CALCULATOR_URL, { waitUntil: 'domcontentloaded' });
}

// Dwa realne problemy zlapane na zywej stronie w tej sesji (patrz plan):
// (1) staly navbar przechwytuje standardowe locator.click(), jesli element
// wyladuje blisko gory po domyslnym (wysrodkowujacym) scrollIntoView -
// naprawione recznym przewinieciem strony na bezpieczna pozycje (y=400);
// (2) checkboxy CF7 maja wlasny stylowany <span> na wierzchu natywnego
// <input>, wiec locator.click() (ktory celuje w srodek elementu i czeka na
// brak przeszkadzajacych elementow) nigdy sie nie kwalifikuje jako "stabilny
// klik" - dziala tylko surowy klik myszy po wspolrzednych, dokladnie tak jak
// zweryfikowane recznie podczas prawdziwego zgloszenia testowego.
async function clickBelowNavbar(locator, page) {
  const handle = await locator.elementHandle();
  const box = await page.evaluate(el => {
    const rect = el.getBoundingClientRect();
    window.scrollBy(0, rect.top - 400);
    const after = el.getBoundingClientRect();
    return { x: after.x + after.width / 2, y: after.y + after.height / 2 };
  }, handle);
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.up();
}

// `input` to ksztalt z excel.js#readTabelaAdresowa: {name, address, ozcKw,
// heatingType (z rules.js#calculate), postalCode, wojewodztwo, zone, device}.
// `email` jest osobnym argumentem (nie z Excela) - to adres/alias
// instalatora, na ktory ma przyjsc karta (patrz plan, sekcja "Skrzynka
// pocztowa").
export async function fillCalculatorForm(page, { input, calculated }, email) {
  await page.getByLabel(/Imię/).fill(input.name || '');
  if (email) await page.getByLabel(/Adres e-mail/).fill(email);
  await page.getByLabel(/Kod pocztowy/).fill(input.postalCode || '');
  // "Chcę umówić spotkanie z konsultantem" CELOWO nigdy nie zaznaczane -
  // wyrazna decyzja wlasciciela z tej sesji: automatyzacja nie moze
  // wywolywac prawdziwego telefonu od konsultanta.
  if (input.wojewodztwo) await page.getByLabel(/Województwo/).selectOption(input.wojewodztwo);
  if (input.address) await page.getByLabel(/Miasto/).fill(input.address);

  // "Czy znasz zapotrzebowanie na moc grzewcza budynku?" zostaje na
  // domyslnym "tak" - zawsze mamy juz policzone OZC z tabeli adresowej.
  await page.getByLabel(/Zapotrzebowanie na moc grzewczą budynku/).fill(String(input.ozcKw));
  if (calculated.heatingType) await page.getByLabel(/Rodzaj ogrzewania/).selectOption(calculated.heatingType);
  if (input.zone) {
    const zoneText = ZONE_OPTION_TEXT[input.zone];
    if (!zoneText) throw new Error(`Nieznana strefa klimatyczna: ${input.zone}`);
    await page.getByLabel(/strefę klimatyczną/).selectOption(zoneText);
  }
  if (calculated.device?.model) await page.getByLabel(/Dostępne urządzenia/).selectOption(calculated.device.model);

  // Wymagana zgoda RODO/marketingowa - bez niej formularz nie pozwoli
  // wyslac. Zawsze zaznaczana (w odroznieniu od "umow spotkanie" powyzej).
  const consent = page.getByLabel(/Wyrażam zgodę na przetwarzanie/);
  if (!(await consent.isChecked())) await clickBelowNavbar(consent, page);
}

// Klika "Wyslij" i czeka na przekierowanie na strone podziekowania - NIE
// rozwiazuje CAPTCHY (patrz src/automation/captcha.js#solveCaptcha,
// wywolywane osobno PRZED tym krokiem przez wywolujacego).
export async function submitForm(page) {
  const button = page.getByRole('button', { name: 'Wyślij' });
  await clickBelowNavbar(button, page);
  await page.waitForURL(/wyniki-kalkulatora-doboru-urzadzenia/, { timeout: 15000 });
}

export function isThankYouPage(page) {
  return /wyniki-kalkulatora-doboru-urzadzenia/.test(page.url());
}
