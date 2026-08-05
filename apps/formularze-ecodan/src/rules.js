export function num(value) {
  if (value === undefined || value === null || value === '') return 0;
  return Number(String(value).replace(',', '.').replace(/[^0-9.-]/g, '')) || 0;
}

// Wspolny, scislejszy parser liczbowy - num() po prostu wycina wszystko
// oprocz cyfr/kropki/minusa, wiec wieloznaczny zapis z kilkoma liczbami
// ("7/8", "50/50", "200/300") sklejalby sie w jedna pozornie poprawna
// liczbe ("78", "5050", "200300"). Audyt v1.0.8 P4: to samo ryzyko co przy
// mocy pompy (patrz parsePowerKw nizej) dotyczy TAKZE OZC, udzialow
// ogrzewania, zbiornika CWU, bufora i wysokosci kotlowni - wieloznaczny
// zapis (kilka liczb, "/" albo "+") jest tu jawnie odrzucany zamiast po
// cichu sklejany w jedna cyfre.
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

// Osobny, scislejszy parser mocy (kW) - patrz komentarz przy
// parseStrictDecimal powyzej (ten sam problem: "9/12 kW" -> 912,
// "10+6 kW" -> 106).
export function parsePowerKw(value) {
  const r = parseStrictDecimal(value);
  return { kw: r.value, raw: r.raw, present: r.present, valid: r.valid, error: r.error };
}

export function parseOzc(value) {
  const r = parseStrictDecimal(value);
  return { ozc: r.value, raw: r.raw, present: r.present, valid: r.valid, error: r.error ? `Nie rozumiem wartości OZC: ${r.error}.` : null };
}

// Wspolny parser dla obu udzialow ogrzewania (grzejnikowego/podlogowego) -
// fieldLabel trafia do komunikatu bledu, zeby bylo wiadomo, ktorego pola
// dotyczy (ten sam wzorzec co osobne komunikaty dla "Moc pompy z gminy" /
// "Moc dobrana" w calculate() nizej).
export function parseHeatingSharePercent(value, fieldLabel) {
  const r = parseStrictDecimal(value);
  return { percent: r.value, raw: r.raw, present: r.present, valid: r.valid, error: r.error ? `Nie rozumiem wartości "${fieldLabel}": ${r.error}.` : null };
}

export function parseBufferLitres(value) {
  const r = parseStrictDecimal(value);
  return { litres: r.value, raw: r.raw, present: r.present, valid: r.valid, error: r.error ? `Nie rozumiem wielkości bufora: ${r.error}.` : null };
}

export function parseBoilerRoomHeight(value) {
  const r = parseStrictDecimal(value);
  return { metres: r.value, raw: r.raw, present: r.present, valid: r.valid, error: r.error ? `Nie rozumiem wysokości kotłowni: ${r.error}.` : null };
}

// tankValue: surowa zawartosc komorki "Wielkosc zbiornika CWU" - TYLKO to
// jest scisle parsowane jako liczba litrow. markerText (domyslnie =
// tankValue) sluzy WYLACZNIE do wykrywania slow kluczowych SOLAR/ROZŁ i w
// realnym przeplywie (excel.js) bywa polaczeniem tankValue + tresci uwag
// (np. "300 l ROZŁĄCZNY - działka nr 45") - gdyby scisly parser liczby
// dzialal na TYM polaczonym tekscie, dodatkowa liczba z niepowiazanych uwag
// ("45") falszywie oznaczalaby caly wiersz jako niejednoznaczny, mimo ze sam
// rozmiar zbiornika jest czytelny. Dlatego liczba i wykrywanie slow
// kluczowych czytaja z DWOCH oddzielnych zrodel (patrz audyt v1.0.8 P4,
// decyzja wlasciciela: waliduj tylko komorke zbiornika osobno).
export function parseTank(tankValue, markerText) {
  const text = String(markerText ?? tankValue ?? '').toUpperCase();
  const r = parseStrictDecimal(tankValue);
  return {
    raw: String(tankValue ?? ''),
    litres: r.value,
    // present=false = komorka byla naprawde pusta (tabela w ogole nie zbiera
    // zbiornika CWU dla tego typu adresow) - odrozniamy to od present=true
    // + litres<=0 (ktos wpisal cos, co po scislym parsowaniu daje 0/ujemna/
    // niejednoznaczna wartosc - to nadal ma blokowac, patrz decyzja
    // wlasciciela nizej).
    present: r.present,
    litresValid: r.valid,
    litresError: r.error ? `Nie rozumiem wielkości zbiornika CWU: ${r.error}.` : null,
    hasSolarMarker: text.includes('SOLAR'),
    hasSplitMarker: text.includes('ROZ') || text.includes('ROZL') || text.includes('ROZŁ')
  };
}

export function choosePower(inputKw) {
  const thresholds = [6, 8, 10, 12, 16, 18];
  for (const kw of thresholds) {
    if (inputKw <= kw) return kw;
  }
  return null;
}

export function outdoorConfig(powerKw) {
  const map = {
    6: { model: 'PUZ-SHWM60VAA', count: 1 },
    8: { model: 'PUZ-SHWM80YAA', count: 1 },
    10: { model: 'PUZ-SHWM100YAA', count: 1 },
    12: { model: 'PUZ-SHWM120YAA', count: 1 },
    16: { model: 'PUZ-SHWM80YAA', count: 2 },
    18: { model: 'PUZ-SHWM100YAA', count: 2 }
  };

  const item = map[powerKw];
  if (!item) return { model: '', count: 0, display: '' };

  return {
    model: item.model,
    count: item.count,
    display: item.count > 1 ? `${item.count} x ${item.model}` : item.model
  };
}

// Stara nazwa zostaje, bo inne fragmenty programu mogą jej używać.
export function outdoorUnit(powerKw) {
  return outdoorConfig(powerKw).display;
}

export function calculate(input) {
  const ozcParsed = parseOzc(input.ozc);
  const ozc = ozcParsed.ozc;
  const municipalityPowerParsed = parsePowerKw(input.municipalityPower);
  const chosenPowerParsed = parsePowerKw(input.chosenPower);
  const municipalityPower = municipalityPowerParsed.kw;
  const chosenPower = chosenPowerParsed.kw;
  const location = String(input.location || '').trim();
  const radiatorsShareParsed = parseHeatingSharePercent(input.radiatorsShare, 'Udział ogrzewania grzejnikowego');
  const floorShareParsed = parseHeatingSharePercent(input.floorShare, 'Udział ogrzewania podłogowego');
  const radiatorsShare = radiatorsShareParsed.percent;
  const floorShare = floorShareParsed.percent;
  const boilerRoomHeightParsed = parseBoilerRoomHeight(input.boilerRoomHeight);
  const boilerRoomHeight = boilerRoomHeightParsed.metres;
  const bufferParsed = parseBufferLitres(input.buffer);
  // cwuTankRaw = surowa komorka zbiornika (bez doklejonych uwag) - patrz
  // komentarz przy parseTank powyzej. Gdy nie zostanie podana osobno (np.
  // wywolania calculate() bez przejscia przez excel.js), input.cwuTank samo
  // sluzy za oba argumenty, dokladnie jak przed ta zmiana.
  const tank = parseTank(input.cwuTankRaw ?? input.cwuTank, input.cwuTank);
  const forceSplit = String(input.forceSplit || '').toLowerCase() === 'tak' || tank.hasSplitMarker;

  // Bledy blokujace - w odroznieniu od "reasons" ponizej, NIE wolno z nimi
  // kontynuowac doboru przez cichy fallback (6 kW, Slesin, grzejniki,
  // zbiornik 200 l). Kazdy z nich musi zatrzymac operacje i wymagac
  // uzupelnienia/poprawienia danych wejsciowych - patrz runAutomation*
  // w jobs.js, ktore odmawia uruchomienia automatyzacji, gdy errors.length > 0.
  const errors = [];
  if (!municipalityPowerParsed.valid) errors.push(`Nie rozumiem wartości "Moc pompy z gminy": "${municipalityPowerParsed.raw}" - podaj jedną liczbę (np. "12 kW"), nie zakres/sumę.`);
  if (!chosenPowerParsed.valid) errors.push(`Nie rozumiem wartości "Moc dobrana": "${chosenPowerParsed.raw}" - podaj jedną liczbę (np. "12 kW"), nie zakres/sumę.`);

  // Jeżeli w Excelu jest wypełniona kolumna "Moc dobrana", to ona decyduje
  // o doborze pompy. Jeśli jest pusta/0, wracamy do starego liczenia
  // z "Moc pompy z gminy", żeby nic nie przestało działać dla starych wierszy.
  const powerForSelection = chosenPower > 0 ? chosenPower : municipalityPower;
  if (powerForSelection <= 0 && municipalityPowerParsed.valid && chosenPowerParsed.valid) {
    errors.push('Brak mocy - puste pola "Moc dobrana" i "Moc pompy z gminy". Uzupełnij dane przed doborem.');
  }
  if (!location) errors.push('Brak lokalizacji (miejscowość/kod pocztowy) - wymagana do doboru na stronie Ecodan.');
  if (!ozcParsed.valid) errors.push(ozcParsed.error);
  if (ozc <= 0 && ozcParsed.valid) errors.push('Brak OZC (obciążenia cieplnego) - uzupełnij dane przed doborem.');
  if (!radiatorsShareParsed.valid) errors.push(radiatorsShareParsed.error);
  if (!floorShareParsed.valid) errors.push(floorShareParsed.error);
  if (radiatorsShare <= 0 && floorShare <= 0 && radiatorsShareParsed.valid && floorShareParsed.valid) {
    errors.push('Brak udziału ogrzewania (puste pola "grzejniki" i "podłogówka") - uzupełnij dane przed doborem.');
  }
  if (tank.litresValid === false) errors.push(tank.litresError);
  // Wlasciciel (2026-08-05): gdy komorka zbiornika jest NAPRAWDE pusta (tabela
  // w ogole nie zbiera tej danej dla tego typu adresow, np. "Kazimierz
  // Biskupi"), NIE blokujemy - przyjmujemy domyslnie 200 l (tankLitres
  // ponizej juz i tak ma ten sam fallback dla doboru urzadzenia, to tylko
  // przestaje byc zablokowane bledem). Jesli komorka MA cos wpisane, ale po
  // scislym parsowaniu wychodzi 0 (np. ktos jawnie wpisal "0"), to dalej
  // blokuje - to realna, podejrzana wartosc, nie brak danych.
  if (tank.present && tank.litres <= 0 && tank.litresValid) {
    errors.push(`Nie rozumiem wielkości zbiornika CWU: "${tank.raw}" - uzupełnij/popraw dane przed doborem.`);
  }

  const selectedPower = powerForSelection > 0 ? choosePower(powerForSelection) : null;
  const receiver = radiatorsShare >= floorShare ? 'Grzejniki płytowe' : 'Ogrzewanie podłogowe';
  const outdoor = outdoorConfig(selectedPower);
  const reasons = [];

  if (powerForSelection > 0 && !selectedPower) reasons.push(`${chosenPower > 0 ? 'Moc dobrana' : 'Moc pompy z gminy'} powyżej 18 kW - ręczne sprawdzenie`);
  if (chosenPower > 0) reasons.push(`Dobór na podstawie ręcznie wpisanej mocy dobranej (${chosenPower} kW), nie z gminy`);
  // Wysokosc kotlowni (i bufor nizej) sa OSTRZEZENIEM, nie blokada - tak bylo
  // przed audytem v1.0.8 P4 i to swiadomie zostaje (patrz zachowania celowe:
  // nie zmieniamy istniejacej surowosci reguly tylko dlatego, ze dodajemy
  // scislejsze parsowanie samej liczby).
  if (!boilerRoomHeightParsed.valid) reasons.push(boilerRoomHeightParsed.error);
  else if (boilerRoomHeight <= 0) reasons.push('Wysokość kotłowni nieznana - zweryfikuj ręcznie przed montażem.');
  if (!bufferParsed.valid) reasons.push(bufferParsed.error);

  // Zgodnie z instrukcją: 16 kW i 18 kW to kaskada dwóch jednostek zewnętrznych,
  // ale sama kaskada NIE oznacza automatycznie układu rozłącznego.
  // Jednostka wewnętrzna nadal wynika ze zbiornika 200/300 l i wysokości kotłowni.
  if (outdoor.count > 1) reasons.push(`Kaskada ${outdoor.count} x ${outdoor.model}`);

  let indoorUnit = 'ERST20F-YM9E';
  let integratedTank = true;
  let tankLitres = tank.litres > 0 ? tank.litres : 200;
  const splitReasons = [];

  if (forceSplit) splitReasons.push('Wymuszony układ rozłączny / oznaczenie ROZŁ');
  if (tank.hasSolarMarker) splitReasons.push('Oznaczenie SOLAR w polu zbiornika');

  // Instrukcja urządzeń wewnętrznych:
  // ERST20F-YM9E = zintegrowany zasobnik 200 l, min. wysokość pomieszczenia 2.00 m.
  // ERST30F-YM9EE = zintegrowany zasobnik 300 l, min. wysokość pomieszczenia 2.45 m.
  // ERSF-YM9E = jednostka rozłączna, bez wbudowanego zbiornika.
  if (tankLitres >= 300 && tankLitres < 400) {
    tankLitres = 300;
    indoorUnit = 'ERST30F-YM9EE';
    if (boilerRoomHeight > 0 && boilerRoomHeight < 2.45) {
      splitReasons.push('Za niska kotłownia dla ERST30F-YM9EE min. 2.45 m');
    }
  } else if (tankLitres <= 200) {
    tankLitres = 200;
    indoorUnit = 'ERST20F-YM9E';
    if (boilerRoomHeight > 0 && boilerRoomHeight < 2.0) {
      splitReasons.push('Za niska kotłownia dla ERST20F-YM9E min. 2.00 m');
    }
  } else {
    // 400/500 l nie są jednostkami zintegrowanymi ERST20/ERST30 z instrukcji,
    // więc traktujemy je jako układ rozłączny z ERSF-YM9E i osobnym zasobnikiem.
    splitReasons.push(`Zbiornik ${tankLitres} l wymaga układu rozłącznego`);
  }

  if (splitReasons.length > 0 || !selectedPower) {
    integratedTank = false;
    indoorUnit = 'ERSF-YM9E';
  }

  const productSearchText = outdoor.display && indoorUnit ? `${outdoor.display} + ${indoorUnit}` : '';

  return {
    input: {
      name: input.name || '',
      address: input.address || '',
      location: input.location || '',
      plotNumber: input.plotNumber || '',
      ozc,
      municipalityPower,
      chosenPower,
      tank: tank.raw,
      boilerRoomHeight
    },
    calculated: {
      receiver,
      buildingTemperature: 20,
      selectedPowerKw: selectedPower,
      cascadeCount: outdoor.count,
      outdoorUnitModel: outdoor.model,
      outdoorUnit: outdoor.display,
      indoorUnit,
      integratedTank: integratedTank ? 'TAK' : 'NIE',
      errors,
      valid: errors.length === 0,
      tankLitres,
      bufferLitres: bufferParsed.litres,
      productSearchText,
      reasons: [...reasons, ...splitReasons].length ? [...reasons, ...splitReasons] : ['Standardowy zestaw']
    }
  };
}
