export function num(value) {
  if (value === undefined || value === null || value === '') return 0;
  return Number(String(value).replace(',', '.').replace(/[^0-9.-]/g, '')) || 0;
}

// Osobny, scislejszy parser mocy (kW) - num() po prostu wycina wszystko
// oprocz cyfr i sklejalby np. "9/12 kW" w 912, albo "10+6 kW" w 106, co
// wygladaloby jak prawdopodobna, ale calkowicie zmyslona wartosc. Tutaj
// wieloznaczny zapis (kilka liczb, "/" albo "+") jest jawnie odrzucany
// zamiast po cichu sklejany w jedna cyfre.
export function parsePowerKw(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return { kw: 0, raw, present: false, valid: true };
  const normalized = raw.replace(',', '.');
  const numberGroups = normalized.match(/\d+(?:\.\d+)?/g) || [];
  if (/[/+]/.test(normalized) || numberGroups.length > 1) {
    return { kw: 0, raw, present: true, valid: false };
  }
  if (numberGroups.length !== 1) return { kw: 0, raw, present: true, valid: false };
  return { kw: Number(numberGroups[0]), raw, present: true, valid: true };
}

export function parseTank(value) {
  const text = String(value || '').toUpperCase();
  const litres = num(text);
  return {
    raw: String(value || ''),
    litres,
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
  const ozc = num(input.ozc);
  const municipalityPowerParsed = parsePowerKw(input.municipalityPower);
  const chosenPowerParsed = parsePowerKw(input.chosenPower);
  const municipalityPower = municipalityPowerParsed.kw;
  const chosenPower = chosenPowerParsed.kw;
  const location = String(input.location || '').trim();
  const radiatorsShare = num(input.radiatorsShare);
  const floorShare = num(input.floorShare);
  const boilerRoomHeight = num(input.boilerRoomHeight);
  const tank = parseTank(input.cwuTank);
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
  if (ozc <= 0) errors.push('Brak OZC (obciążenia cieplnego) - uzupełnij dane przed doborem.');
  if (radiatorsShare <= 0 && floorShare <= 0) {
    errors.push('Brak udziału ogrzewania (puste pola "grzejniki" i "podłogówka") - uzupełnij dane przed doborem.');
  }
  if (tank.litres <= 0) {
    errors.push(`Nie rozumiem wielkości zbiornika CWU: "${tank.raw}" - uzupełnij/popraw dane przed doborem.`);
  }

  const selectedPower = powerForSelection > 0 ? choosePower(powerForSelection) : null;
  const receiver = radiatorsShare >= floorShare ? 'Grzejniki płytowe' : 'Ogrzewanie podłogowe';
  const outdoor = outdoorConfig(selectedPower);
  const reasons = [];

  if (powerForSelection > 0 && !selectedPower) reasons.push(`${chosenPower > 0 ? 'Moc dobrana' : 'Moc pompy z gminy'} powyżej 18 kW - ręczne sprawdzenie`);
  if (chosenPower > 0) reasons.push(`Dobór na podstawie ręcznie wpisanej mocy dobranej (${chosenPower} kW), nie z gminy`);
  if (boilerRoomHeight <= 0) reasons.push('Wysokość kotłowni nieznana - zweryfikuj ręcznie przed montażem.');

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
      bufferLitres: num(input.buffer),
      productSearchText,
      reasons: [...reasons, ...splitReasons].length ? [...reasons, ...splitReasons] : ['Standardowy zestaw']
    }
  };
}
