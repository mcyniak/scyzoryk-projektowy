// Czysta logika doboru - bez Excela, bez przegladarki. Parser liczb
// wzorowany 1:1 na apps/formularze-ecodan/src/rules.js#parseStrictDecimal:
// wieloznaczny zapis typu "7/8" albo "10+6" jest jawnie odrzucany zamiast po
// cichu sklejany w jedna cyfre (ten sam realny blad, ktory tamta appka juz
// raz zlapala - patrz komentarz w oryginale).
function parseStrictDecimal(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return { value: 0, raw, present: false, valid: true, error: null };
  const normalized = raw.replace(/,/g, '.');
  const numberGroups = normalized.match(/-?\d+(?:\.\d+)?/g) || [];
  if (/[/+]/.test(normalized) || numberGroups.length > 1) {
    return { value: 0, raw, present: true, valid: false, error: `niejednoznaczna wartość "${raw}" - podaj jedną liczbę, nie zakres/sumę` };
  }
  if (numberGroups.length !== 1) {
    return { value: 0, raw, present: true, valid: false, error: `nie rozpoznaję liczby w wartości "${raw}"` };
  }
  const parsed = Number(numberGroups[0]);
  if (parsed < 0) {
    return { value: 0, raw, present: true, valid: false, error: `wartość ujemna "${raw}" nie jest tu dopuszczalna` };
  }
  return { value: parsed, raw, present: true, valid: true, error: null };
}

export function parseOzc(value) {
  const r = parseStrictDecimal(value);
  return { ozcKw: r.value, raw: r.raw, present: r.present, valid: r.valid, error: r.error ? `Nie rozumiem wartości OZC: ${r.error}.` : null };
}

export function parseHeatingSharePercent(value, fieldLabel) {
  const r = parseStrictDecimal(value);
  return { percent: r.value, raw: r.raw, present: r.present, valid: r.valid, error: r.error ? `Nie rozumiem wartości "${fieldLabel}": ${r.error}.` : null };
}

// Rodzaj ogrzewania na kalkulatorze Varmero to wybor binarny (podlogowe 35C
// / sredniotemperaturowe 55C), a tabela adresowa ma dwie osobne kolumny
// procentowe (grzejnikowe/podlogowe) - wiekszosc grzejnikowa = 55C,
// wiekszosc/rownowaga podlogowa = 35C. Prog 50% jest tymczasowy - do
// potwierdzenia z wlascicielem przy realnym wdrozeniu (patrz plan).
export function chooseHeatingType(radiatorsPercent, floorPercent) {
  if (radiatorsPercent > floorPercent) return 'ogrzewanie średniotemperaturowe 55 ℃';
  return 'ogrzewanie podłogowe 35 ℃';
}

// UWAGA: progi mocy ponizej sa TYMCZASOWE, wywnioskowane wylacznie z nazw
// modeli (VPM 9008/9012/9020 ~ 8/12/20 kW), NIE z realnej karty katalogowej
// Varmero - do potwierdzenia przed pierwszym prawdziwym uzyciem (patrz plan,
// sekcja "Wybor urzadzenia"). Dlatego kazdy wynik niesie needsConfirmation:true
// - UI/finalizacja musi to pokazac uzytkownikowi, nie ufac po cichu.
const VPM_MODELS = [
  { model: 'VPM 9008', capacityKw: 8 },
  { model: 'VPM 9012', capacityKw: 12 },
  { model: 'VPM 9020', capacityKw: 20 }
];

export function chooseVpmModel(ozcKw) {
  const fit = VPM_MODELS.find(m => m.capacityKw >= ozcKw);
  const chosen = fit || VPM_MODELS[VPM_MODELS.length - 1];
  return {
    model: chosen.model,
    needsConfirmation: true,
    reason: fit
      ? `Dobrano najmniejszy model pokrywający ${ozcKw} kW (progi mocy tymczasowe, do potwierdzenia).`
      : `Zapotrzebowanie ${ozcKw} kW przekracza największy skatalogowany model - wymaga ręcznego sprawdzenia.`
  };
}

// Druga warstwa obrony (jak w Ecodanie) - nigdy nie pozwalamy automatyzacji
// ruszyc do przegladarki z niepelnymi/niepewnymi danymi, nawet jesli jakas
// inna sciezka (np. pojedyncze /api/calculate) ominie walidacje w excel.js.
export function calculate(input) {
  const ozc = parseOzc(input?.ozc);
  const radiators = parseHeatingSharePercent(input?.radiatorsPercent, 'Ogrzewanie grzejnikowe');
  const floor = parseHeatingSharePercent(input?.floorPercent, 'Ogrzewanie podłogowe');
  const errors = [ozc.error, radiators.error, floor.error].filter(Boolean);
  if (!ozc.present) errors.push('Brak wartości OZC - nie da się dobrać urządzenia bez zapotrzebowania budynku.');
  if (!errors.length && ozc.ozcKw <= 0) errors.push('Wartość OZC musi być większa od zera.');

  const valid = errors.length === 0;
  const heatingType = valid ? chooseHeatingType(radiators.percent, floor.percent) : null;
  const device = valid ? chooseVpmModel(ozc.ozcKw) : null;

  return {
    input: { ozcKw: ozc.ozcKw, radiatorsPercent: radiators.percent, floorPercent: floor.percent },
    calculated: { heatingType, device, errors, valid }
  };
}
