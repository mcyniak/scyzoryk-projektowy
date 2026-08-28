// CAPTCHA na varmero.pl (wtyczka WordPressa "cf7-image-captcha-pro") pokazuje
// 2-4 ikonki i prosi "wybierz X" (np. "wybierz flagę"). WAZNE, zweryfikowane
// bezposrednio w tej sesji (patrz plan): to sa surowe wektory SVG
// (<path d="...">) wprost w HTML-u strony, NIE bitmapy - wiec dopasowanie
// dziala przez porownanie tekstu sciezki, bez zadnego OCR/AI w locie i bez
// zadnego kosztu/limitu przy kazdym zgloszeniu.
//
// Katalog ponizej jest CELOWO NIEPELNY - podczas researchu w tej sesji
// (2026-08-10) potwierdzilem wizualnie (zrzuty ekranu) tylko 4 ikonki:
// dom/lupa/flaga/gwiazda. Formularz pokazuje tez inne slowa (samolot,
// samochod, filizanka, klucz, ciezarowka), ktorych ksztaltow NIE
// potwierdzilem wizualnie z pewnoscia (tylko czesciowe, sprzeczne
// dopasowanie po skroconych prefiksach) - celowo pominiete zamiast zgadywac.
//
// Klucze to PREFIKSY (60 pierwszych znakow) atrybutu `d` sciezki SVG, nie
// pelne sciezki - male ryzyko kolizji miedzy dwoma roznymi ikonkami o
// identycznym poczatku ksztaltu, akceptowalne przy tak malej puli ikon, ale
// warte dopisania pelnych sciezek przy rozszerzaniu katalogu.
// Test na 30 zywych zaladowan strony (2026-08-10): ~40% trafien w katalog
// (dom/flage/gwiazde), reszta (samochod/drzewo/serce/filizanke/klucz/
// ciezarowke) NIE zostala dodana mimo ze sie pojawily - proba
// zidentyfikowania ich przez eliminacje (kilka asynchronicznych zaladowan
// naraz, bez dedykowanego, pojedynczego potwierdzenia kazdego slowa z
// osobna) dala SPRZECZNE wyniki (ten sam ksztalt wygladal raz na "auto", raz
// na "dom" w zaleznosci od interpretacji) - lepiej zostawic je jako
// nieznane (needsReview) niz ryzykowac cichy zly klik. Rozszerzanie
// katalogu wymaga jednego, dedykowanego zaladowania NA KAZDE nowe slowo
// osobno, ze zrzutem ekranu natychmiast po zaladowaniu tego konkretnego
// wyzwania - nie partii kilku naraz.
export const ICON_CATALOG = [
  { label: 'dom', pathPrefix: 'M1472 992v480q0 26-19 45t-45 19h-384v-384h-256v384h-384q-26' },
  // Nizsza pewnosc niz dom/flage/gwiazde - potwierdzona wylacznie przez
  // czytanie skladni sciezki SVG ("okragly ksztalt + uchwyt" = lupa), NIE
  // przez bezposredni zrzut ekranu z widocznym slowem "wybierz lupe". Warta
  // ponownego, dedykowanego potwierdzenia przy najblizszej okazji.
  { label: 'lupę', pathPrefix: 'M832 512q0-80-56-136t-136-56-136 56-56 136q0 42 19 83-41-19-' },
  { label: 'flagę', pathPrefix: 'M320 256q0 72-64 110v1266q0 13-9.5 22.5t-22.5 9.5h-64q-13 0-' },
  { label: 'gwiazdę', pathPrefix: 'M1728 647q0 22-26 48l-363 354 86 500q1 7 1 20 0 21-10.5 35.5' }
];

export class UnknownCaptchaIconError extends Error {
  constructor(word, pathPrefixes) {
    super(`Nieznana ikona CAPTCHY dla słowa "${word}" - brak w katalogu (prefiksy: ${pathPrefixes.join(', ')}).`);
    this.name = 'UnknownCaptchaIconError';
    this.word = word;
    this.pathPrefixes = pathPrefixes;
  }
}

// Wyciaga slowo docelowe ("wybierz FLAGĘ") + liste kandydatow (ref do
// <input type=radio> + prefiks sciezki SVG) z aktualnie wyswietlonej
// CAPTCHY. Zwraca null, jesli widzet jeszcze sie nie zaladowal (AJAX,
// patrz komentarz w fieldExtraction... nie, patrz: cf7ic-loader w DOM).
export async function readCaptchaChallenge(page) {
  return page.evaluate(() => {
    const instructions = document.querySelector('.cf7ic_instructions');
    if (!instructions) return null;
    const match = instructions.textContent.match(/wybierając\s+([^.]+?)\s*\./i);
    const word = match ? match[1].trim() : null;
    const labels = [...document.querySelectorAll('.cf7ic-icon-wrapper label')];
    if (!word || !labels.length) return null;
    // WAZNE: `index` musi byc pozycja radia w kolekcji
    // '.cf7ic-icon-wrapper input[type=radio]', bo solveCaptcha klika przez
    // .nth(index). Numerowanie po WSZYSTKICH labelach bylo bledne - jeden
    // label bez radia przesuwal caly indeks i klikana byla zla ikona.
    // Labelom bez radia dajemy index -1 (nieklikalne).
    let radioIndex = 0;
    const options = labels.map(label => {
      const input = label.querySelector('input[type=radio]');
      const path = label.querySelector('path');
      const hasInput = Boolean(input);
      const index = hasInput ? radioIndex++ : -1;
      return { index, pathPrefix: path ? path.getAttribute('d').slice(0, 60) : null, hasInput };
    });
    return { word, options };
  });
}

// Widget CAPTCHY laduje sie asynchronicznie (wlasny AJAX wtyczki, patrz
// cf7ic-loader) DOPIERO PO zaznaczeniu zgody RODO - realny blad zlapany
// podczas pierwszego proby prawdziwego zgloszenia w tej sesji: pojedyncze
// sprawdzenie od razu po fillCalculatorForm trafialo na jeszcze pusty
// widget. Odpytuje co 300ms przez maks. `timeoutMs`, zamiast sprawdzac raz.
async function waitForCaptchaChallenge(page, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const challenge = await readCaptchaChallenge(page);
    if (challenge) return challenge;
    await page.waitForTimeout(300);
  }
  return null;
}

// Rozwiazuje CAPTCHE i klika wlasciwy radio - rzuca UnknownCaptchaIconError,
// jesli zadna z pokazanych ikon nie jest w katalogu (NIGDY nie zgaduje /nie
// klika losowej opcji). Zwraca etykiete dopasowanej ikony do logow.
export async function solveCaptcha(page) {
  const challenge = await waitForCaptchaChallenge(page);
  if (!challenge) throw new Error('CAPTCHA jeszcze się nie załadowała (widget pusty) po odczekaniu.');

  const wantedWord = challenge.word.toLowerCase();
  const catalogEntry = ICON_CATALOG.find(entry => wantedWord.includes(entry.label.toLowerCase()));
  if (!catalogEntry) {
    throw new UnknownCaptchaIconError(challenge.word, challenge.options.map(o => o.pathPrefix).filter(Boolean));
  }
  const matchedOption = challenge.options.find(o => o.hasInput && o.pathPrefix && o.pathPrefix.startsWith(catalogEntry.pathPrefix.slice(0, 40)));
  if (!matchedOption) {
    throw new UnknownCaptchaIconError(challenge.word, challenge.options.map(o => o.pathPrefix).filter(Boolean));
  }
  const matchIndex = matchedOption.index;

  const radios = page.locator('.cf7ic-icon-wrapper input[type=radio]');
  const target = radios.nth(matchIndex);
  // Ten sam dwuczesciowy problem co przy zaznaczaniu zgody w steps.js#clickBelowNavbar:
  // staly navbar przechwytuje standardowe locator.click() blisko gory strony,
  // a sam radio ma wlasny stylowany <label>/svg na wierzchu - dziala tylko
  // surowy klik myszy po wspolrzednych, zweryfikowane bezposrednio w tej
  // sesji podczas prawdziwego zgloszenia testowego.
  const handle = await target.elementHandle();
  const box = await page.evaluate(el => {
    const rect = el.getBoundingClientRect();
    window.scrollBy(0, rect.top - 400);
    const after = el.getBoundingClientRect();
    return { x: after.x + after.width / 2, y: after.y + after.height / 2 };
  }, handle);
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.up();

  // Klik po wspolrzednych moze chybic (przesuniecie layoutu, nakladka, zmiana
  // pozycji po scrollu), a bez tego sprawdzenia submitForm wyslalby formularz
  // z nierozwiazana CAPTCHA i zmarnowal realne zgloszenie. Weryfikujemy wiec,
  // ze docelowy radio faktycznie jest zaznaczony.
  await page.waitForTimeout(150);
  const checked = await target.isChecked().catch(() => false);
  if (!checked) {
    throw new Error(`Klik w CAPTCHE nie zaznaczyl opcji "${catalogEntry.label}" (radio nr ${matchIndex + 1}) - przerwano przed wyslaniem formularza.`);
  }

  return catalogEntry.label;
}
