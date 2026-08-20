// Kanoniczny schemat pol formularza audytu (klucz, etykieta kolumny,
// rodzaj, slownik checkboxow/materialow) + budowa wyniku ekstrakcji.
//
// Do 2026-08-12 ten plik zawieral tez geometryczne dopasowanie wartosci
// (Document AI formFields/tabele -> wartosc pola przez wzorce regex per
// etykieta, patrz git history) - zastapione przez model jezykowy (Gemini
// albo, od 2026-08-19, OpenAI - patrz src/aiProvider.js): model dostaje
// caly blok dokumentu i TEN SAM schemat pol na raz, sam semantycznie
// przypisuje wartosci, bez naszej wlasnej logiki 'znajdz etykiete -> zgadnij
// sasiednia wartosc'. FIELD_DEFS zostaje jedynym zrodlem prawdy o zestawie
// pol/etykietach/slowniku checkboxow-materialow - uzywane do budowy promptu
// (src/aiEngineShared.js#buildExtractionPrompt, wspolny dla obu silnikow)
// oraz do eksportu Excela (COLUMN_ORDER/COLUMN_LABELS).
//
// kind: 'text' | 'checkbox' | 'titleDerived' | 'material' | 'manual'.
// 'manual' (obecnie tylko 'demontaz') NIGDY nie jest wysylane do modelu -
// zawsze trafia do recznego przegladu, tak jak wczesniej.
const FIELD_DEFS = [
  {
    key: 'imieNazwisko',
    columnLabel: 'Imię i nazwisko',
    kind: 'text',
    valueKind: 'name'
  },
  {
    key: 'adresInstalacji',
    columnLabel: 'Adres miejsca instalacji',
    kind: 'text'
  },
  {
    key: 'rodzajPompy',
    columnLabel: 'Rodzaj pompy',
    kind: 'titleDerived',
    options: [
      {
        label: 'Gruntowa'
      },
      {
        label: 'Powietrzna'
      }
    ]
  },
  {
    key: 'demontaz',
    columnLabel: 'Demontaż',
    kind: 'manual'
  },
  {
    key: 'telefon',
    columnLabel: 'Telefon',
    kind: 'text',
    valueKind: 'numeric'
  },
  {
    key: 'rokBudowy',
    columnLabel: 'Rok budowy budynku',
    kind: 'text',
    valueKind: 'numeric'
  },
  {
    key: 'liczbaOsob',
    columnLabel: 'Liczba osób w gospodarstwie',
    kind: 'text',
    valueKind: 'numeric'
  },
  {
    key: 'powierzchnia',
    columnLabel: 'Powierzchnia ogrzewana',
    kind: 'text',
    valueKind: 'numeric'
  },
  {
    key: 'powierzchniaDzialki',
    columnLabel: 'Powierzchnia działki (dolne źródło)',
    kind: 'text',
    valueKind: 'numeric'
  },
  {
    key: 'dataMontażuDrzwiZewn',
    columnLabel: 'Data montażu drzwi zewnętrznych',
    kind: 'text',
    valueKind: 'numeric'
  },
  {
    key: 'udzialGrzejnikowy',
    columnLabel: 'Udział ogrzewania grzejnikowego (%)',
    kind: 'text',
    valueKind: 'percent'
  },
  {
    key: 'udzialPlaszczyznowy',
    columnLabel: 'Udział ogrzewania płaszczyznowego (%)',
    kind: 'text',
    valueKind: 'percent'
  },
  {
    key: 'temperaturaPomieszczenia',
    columnLabel: 'Żądana temperatura w pomieszczeniach',
    kind: 'text',
    valueKind: 'numeric'
  },
  {
    key: 'temperaturaCwu',
    columnLabel: 'Żądana temperatura c.w.u.',
    kind: 'text',
    valueKind: 'numeric'
  },
  {
    key: 'wysokoscKotlowniPC',
    columnLabel: 'Wysokość kotłowni (m)',
    kind: 'text',
    valueKind: 'numeric'
  },
  {
    key: 'mocPompyZGminy',
    columnLabel: 'Moc pompy z gminy',
    kind: 'checkbox',
    valueKind: 'numeric',
    options: [
      {
        label: '7'
      },
      {
        label: '8'
      },
      {
        label: '9'
      },
      {
        label: '10'
      },
      {
        label: '12'
      },
      {
        label: '13'
      }
    ]
  },
  {
    key: 'zrodloCiepla',
    columnLabel: 'Źródło ciepła',
    kind: 'checkbox',
    options: [
      {
        label: 'Kocioł na paliwo stałe'
      },
      {
        label: 'Kocioł na biomasę'
      },
      {
        label: 'Kocioł na gaz/olej – jednofunkcyjny'
      },
      {
        label: 'Kocioł na gaz/olej – dwufunkcyjny'
      },
      {
        label: 'Kocioł z wbudowanym zasobnikiem cwu'
      },
      {
        label: 'Podgrzewacz elektryczny/gazowy'
      },
      {
        label: 'Inny'
      },
      {
        label: 'Brak instalacji c.w.u.'
      }
    ]
  },
  {
    // Gdy 'zrodloCiepla' = "Inny", dopisany odrecznie tekst dotad NIGDZIE nie
    // byl przechwytywany (checkbox zwracal tylko wybrana etykiete opcji).
    // Wlasciciel potrzebuje tej wartosci do wyliczenia kolumny "kolektory" w
    // tabeli adresowej (patrz tabelaAdresowaColumns.js#deriveFromKeyword) -
    // np. "Inny: kolektor sloneczny" -> kolektory = "tak".
    key: 'zrodloCieplaInnyOpis',
    columnLabel: 'Źródło ciepła - opis "Inny"',
    kind: 'text',
    note: 'wypelnij WYLACZNIE jesli pole "zrodloCiepla" ma zaznaczone "Inny" - przepisz dokladnie dopisany obok tekst, w kazdym innym przypadku zwroc null',
    // dependsOn: to samo zrodlo prawdy, ktorego uzywa zarowno frontend
    // (CONDITIONAL_FIELDS w app.js - chowa ten wiersz, gdy warunek nie jest
    // spelniony) jak i backend (isFieldApplicable ponizej, uzywane w
    // server.js przy finalizacji) - real bug 2026-08-19: bez tego backend
    // NIC nie wiedzial o warunkowosci tego pola i blokowal pobranie KAZDEGO
    // pliku (needsReview zawsze true dla ukrytego pola, ktorego uzytkownik
    // fizycznie nie moze uzupelnic, bo nigdy go nie widzi), nawet gdy
    // uzytkownik uzupelnil kompletnie wszystkie widoczne pola.
    dependsOn: { key: 'zrodloCiepla', equals: 'Inny' }
  },
  {
    key: 'wentylacja',
    columnLabel: 'Wentylacja',
    kind: 'checkbox',
    options: [
      {
        label: 'Grawitacyjna'
      },
      {
        label: 'Mechaniczna'
      },
      {
        label: 'Odzysk ciepła'
      }
    ]
  },
  {
    key: 'typKonstrukcji',
    columnLabel: 'Typ konstrukcji',
    kind: 'checkbox',
    options: [
      {
        label: 'Lekka'
      },
      {
        label: 'Średnia'
      },
      {
        label: 'Ciężka'
      }
    ]
  },
  {
    key: 'stopienSzczelnosci',
    columnLabel: 'Stopień szczelności',
    kind: 'checkbox',
    options: [
      {
        label: 'Niski'
      },
      {
        label: 'Średni'
      },
      {
        label: 'Wysoki'
      }
    ]
  },
  {
    key: 'klasaOslonieciaBudynku',
    columnLabel: 'Klasa osłonięcia budynku',
    kind: 'checkbox',
    options: [
      {
        label: 'Brak'
      },
      {
        label: 'Średnie'
      },
      {
        label: 'Dobre'
      }
    ]
  },
  {
    key: 'rodzajDachu',
    columnLabel: 'Rodzaj dachu',
    kind: 'checkbox',
    options: [
      {
        label: 'Płaski'
      },
      {
        label: 'Skośny'
      }
    ]
  },
  {
    key: 'pokrycieDachu',
    columnLabel: 'Pokrycie dachu',
    kind: 'checkbox',
    options: [
      {
        label: 'Blachodachówka'
      },
      {
        label: 'Papa'
      },
      {
        label: 'Dachówka ceramiczna'
      },
      {
        label: 'Membrana'
      }
    ]
  },
  {
    key: 'ksztaltBudynku',
    columnLabel: 'Kształt budynku',
    kind: 'checkbox',
    options: [
      {
        label: 'Regularny'
      },
      {
        label: 'Nieregularny'
      }
    ]
  },
  {
    key: 'scianaZewnMaterial',
    columnLabel: 'Ściana zewnętrzna (materiał, grubość)',
    kind: 'material',
    options: [
      {
        label: 'Cegła ceramiczna pełna'
      },
      {
        label: 'Cegła dziurawka'
      },
      {
        label: 'Bloczki z betonu komórkowego'
      },
      {
        label: 'Bloczki silikatowe'
      },
      {
        label: 'Pustak keramzytobetonowe'
      },
      {
        label: 'Drewno'
      },
      {
        label: 'Żużel'
      },
      {
        label: 'Inne'
      }
    ]
  },
  {
    key: 'ocieplenieScianyZewn',
    columnLabel: 'Ocieplenie ściany zewnętrznej (materiał, grubość)',
    kind: 'material',
    options: [
      {
        label: 'Styropian'
      },
      {
        label: 'Wełna mineralna'
      },
      {
        label: 'Pustka powietrzna'
      },
      {
        label: 'Pianka PUR'
      },
      {
        label: 'Brak'
      }
    ]
  },
  {
    key: 'scianaFundamentowaMaterial',
    columnLabel: 'Ściana fundamentowa (materiał, grubość)',
    kind: 'material',
    options: [
      {
        label: 'Beton'
      },
      {
        label: 'Żużel'
      },
      {
        label: 'Cegła pełna'
      },
      {
        label: 'Pustak'
      },
      {
        label: 'Kamień'
      },
      {
        label: 'Bloczek betonowy'
      }
    ]
  },
  {
    key: 'stropOgrzewane',
    columnLabel: 'Strop nad ogrzewanymi (materiał, grubość)',
    kind: 'material',
    options: [
      {
        label: 'Strop żelbetowy monolityczny'
      },
      {
        label: 'Strop gęsto żebrowy'
      },
      {
        label: 'Strop drewniany'
      }
    ]
  },
  {
    key: 'stropNieogrzewane',
    columnLabel: 'Strop nad nieogrzewanymi (materiał, grubość)',
    kind: 'material',
    options: [
      {
        label: 'Strop żelbetowy monolityczny'
      },
      {
        label: 'Strop gęsto żebrowy'
      },
      {
        label: 'Strop drewniany'
      }
    ]
  },
  {
    key: 'izolacjaScianyFundamentowej',
    columnLabel: 'Izolacja ściany fundamentowej (grubość)',
    kind: 'material',
    options: [
      {
        label: 'Tak'
      },
      {
        label: 'Nie'
      }
    ]
  },
  {
    key: 'izolacjaDachu',
    columnLabel: 'Izolacja dachu (grubość)',
    kind: 'material',
    options: [
      {
        label: 'Tak'
      },
      {
        label: 'Nie'
      }
    ]
  },
  {
    key: 'dlugoscBudynku',
    columnLabel: 'Długość budynku (regularny)',
    kind: 'text',
    valueKind: 'numeric'
  },
  {
    key: 'szerokoscBudynku',
    columnLabel: 'Szerokość budynku (regularny)',
    kind: 'text',
    valueKind: 'numeric'
  },
  {
    key: 'dlugoscScianPolnocnej',
    columnLabel: 'Długość ścian od strony północnej',
    kind: 'text',
    valueKind: 'numeric'
  },
  {
    key: 'dlugoscScianPoludniowej',
    columnLabel: 'Długość ścian od strony południowej',
    kind: 'text',
    valueKind: 'numeric'
  },
  {
    key: 'dlugoscScianWschodniej',
    columnLabel: 'Długość ścian od strony wschodniej',
    kind: 'text',
    valueKind: 'numeric'
  },
  {
    key: 'dlugoscScianZachodniej',
    columnLabel: 'Długość ścian od strony zachodniej',
    kind: 'text',
    valueKind: 'numeric'
  },
  {
    key: 'elewacjaAPowierzchniaOkien',
    columnLabel: 'Elewacja A (Północna) - powierzchnia okien',
    kind: 'text',
    valueKind: 'numeric'
  },
  {
    key: 'elewacjaBPowierzchniaOkien',
    columnLabel: 'Elewacja B (Wschodnia) - powierzchnia okien',
    kind: 'text',
    valueKind: 'numeric'
  },
  {
    key: 'elewacjaCPowierzchniaOkien',
    columnLabel: 'Elewacja C (Południowa) - powierzchnia okien',
    kind: 'text',
    valueKind: 'numeric'
  },
  {
    key: 'elewacjaDPowierzchniaOkien',
    columnLabel: 'Elewacja D (Zachodnia) - powierzchnia okien',
    kind: 'text',
    valueKind: 'numeric'
  },
  {
    key: 'kotlyMocKotla',
    columnLabel: 'Moc kotła',
    kind: 'checkbox',
    options: [
      {
        label: '10 kW'
      },
      {
        label: '15 kW'
      },
      {
        label: '20 kW'
      },
      {
        label: '25 kW'
      },
      {
        label: '30 kW'
      }
    ]
  },
  {
    key: 'kotlyMocIstniejacegoZrodla',
    columnLabel: 'Moc istniejącego źródła ciepła',
    kind: 'text',
    valueKind: 'numeric'
  },
  {
    key: 'kotlyZasobnikCwu',
    columnLabel: 'Zasobnik c.w.u. (pojemność)',
    kind: 'text',
    valueKind: 'numeric'
  },
  {
    key: 'solaryRodzajZestawu',
    columnLabel: 'Rodzaj zestawu',
    kind: 'checkbox',
    options: [
      {
        label: '2/250'
      },
      {
        label: '3/300'
      },
      {
        label: '4/400'
      }
    ]
  },
  {
    key: 'solaryTypBudynku',
    columnLabel: 'Typ budynku',
    kind: 'checkbox',
    options: [
      {
        label: 'Bud. mieszkalny'
      },
      {
        label: 'Bud. gospodarczy'
      }
    ]
  },
  {
    key: 'solaryTypKonstrukcji',
    columnLabel: 'Typ konstrukcji',
    kind: 'checkbox',
    options: [
      {
        label: 'Dach płaski'
      },
      {
        label: 'Dach skośny'
      },
      {
        label: 'Elewacja'
      }
    ]
  },
  {
    key: 'solaryMiejsceMontazu',
    columnLabel: 'Miejsce montażu',
    kind: 'checkbox',
    options: [
      {
        label: 'Dach płaski lub zbliżony'
      },
      {
        label: 'Balkon, taras'
      },
      {
        label: 'Dach skośny'
      },
      {
        label: 'Grunt'
      },
      {
        label: 'Elewacja budynku, wysoko'
      },
      {
        label: 'Elewacja budynku, nisko'
      }
    ]
  },
  {
    key: 'solaryPokrycieDachu',
    columnLabel: 'Pokrycie dachu',
    kind: 'text'
  },
  {
    key: 'solaryWysokoscKotlowni',
    columnLabel: 'Wysokość kotłowni',
    kind: 'text',
    valueKind: 'numeric'
  }
];


const COLUMN_ORDER = ['adres', ...FIELD_DEFS.map((f) => f.key)];
const COLUMN_LABELS = { adres: 'Adres' };
for (const f of FIELD_DEFS) COLUMN_LABELS[f.key] = f.columnLabel;

// Etykiety opcji per pole (checkbox/titleDerived/material) - ekran przegladu
// (public/app.js) renderuje te pola jako <select>, nie wolne pole tekstowe,
// zeby uzytkownik nie mogl wpisac wartosci spoza dozwolonej listy (i tak
// zostalaby oflagowana needsReview przez toFieldResult ponizej).
const COLUMN_OPTIONS = {};
for (const f of FIELD_DEFS) {
  if (f.options && f.options.length) COLUMN_OPTIONS[f.key] = f.options.map((o) => o.label);
}

// --- Walidacja/needsReview: zastepuje dawny confidence z dopasowania
// geometrycznego. Gemini nie daje wiarygodnego per-pola confidence (liczba
// wygenerowana przez model nie jest skalibrowanym prawdopodobienstwem -
// potwierdzone w obu researchowanych raportach, patrz pamiec projektu
// 2026-08-12), wiec needsReview to teraz prosta, deterministyczna reguła w
// Node.js zamiast progu ufnosci silnika:
//   - wartosc pusta/null -> zawsze needsReview
//   - checkbox/titleDerived/material z wartoscia SPOZA listy options ->
//     needsReview (lapie halucynacje/literowki modelu)
//   - pole numeric/percent bez zadnej cyfry w wartosci -> needsReview
//   - reszta -> needsReview:false, ale WARTOSC ZOSTAJE WIDOCZNA - nic nigdy
//     nie znika calkowicie z ekranu przegladu, tylko wyroznienie sie zmienia.
function isPlausibleNumeric(value) {
  return /\d/.test(String(value ?? ''));
}

function toFieldResult(rawValue, def) {
  const value = rawValue === null || rawValue === undefined ? '' : String(rawValue).trim();
  let needsReview = false;
  if (!value) {
    needsReview = true;
  } else if (def.options && def.options.length) {
    const allowed = def.options.some((o) => o.label.toLowerCase() === value.toLowerCase());
    if (!allowed) needsReview = true;
  } else if (def.valueKind === 'numeric' || def.valueKind === 'percent') {
    if (!isPlausibleNumeric(value)) needsReview = true;
  }
  return { value, confidence: null, pageIndex: null, needsReview, resolved: !needsReview };
}

// Buduje wynik dla wszystkich pol z FIELD_DEFS (ograniczonych do
// allowedKeys, jesli podane) na podstawie plaskiego obiektu { key: value|null }
// zwroconego przez geminiFieldEngine.extractFieldsForBlock. Pola typu
// 'manual' nigdy nie sa wysylane do Gemini (patrz filterExtractableFields) -
// zawsze wracaja jako puste + needsReview:true.
function buildFieldsFromExtraction(rawValues, allowedKeys = null) {
  const result = {};
  for (const def of FIELD_DEFS) {
    if (allowedKeys && !allowedKeys.has(def.key)) continue;
    if (def.kind === 'manual') {
      result[def.key] = { value: '', confidence: null, pageIndex: null, needsReview: true, resolved: false };
      continue;
    }
    result[def.key] = toFieldResult(rawValues ? rawValues[def.key] : null, def);
  }
  return result;
}

// Zwraca podzbior FIELD_DEFS, ktory faktycznie ma trafic do Gemini - bez
// kind:'manual' (nigdy automatycznie ekstrahowane) i ograniczony do
// allowedKeys, jesli podane (patrz tabelaAdresowaColumns.js#allowedKeysForFamily).
function filterExtractableFields(allowedKeys = null) {
  return FIELD_DEFS.filter((f) => f.kind !== 'manual' && (!allowedKeys || allowedKeys.has(f.key)));
}

// Rozstrzyga JEDNO pole recznie (patrz POST /api/ocr/resolve-field w
// server.js) - jawna wartosc od uzytkownika, wiec zawsze resolved:true,
// needsReview:false, niezaleznie od tego co zwrocilby toFieldResult.
function resolvedFieldResult(value) {
  return { value: value || '', confidence: null, pageIndex: null, needsReview: false, resolved: true };
}

// Czy pole faktycznie DOTYCZY tego bloku - pola z "dependsOn" (patrz
// zrodloCieplaInnyOpis w FIELD_DEFS) sa nieistotne, gdy warunkowa wartosc
// nie jest spelniona (np. "zrodloCiepla" != "Inny"). Uzywane przy
// finalizacji (server.js) do wykluczenia takich pol z bramki "czy wszystko
// uzupelnione" - bez tego pole, ktorego uzytkownik NIGDY nie widzi (bo
// odpowiadajacy mu wiersz jest ukryty w UI, patrz CONDITIONAL_FIELDS w
// app.js), zostawaloby needsReview:true na zawsze i blokowaloby pobranie
// KAZDEGO pliku, niezaleznie od tego, ile pol uzytkownik faktycznie uzupelnil.
function isFieldApplicable(fields, key) {
  const def = FIELD_DEFS.find((d) => d.key === key);
  if (!def || !def.dependsOn) return true;
  return fields?.[def.dependsOn.key]?.value === def.dependsOn.equals;
}

module.exports = { FIELD_DEFS, COLUMN_ORDER, COLUMN_LABELS, COLUMN_OPTIONS, buildFieldsFromExtraction, filterExtractableFields, toFieldResult, resolvedFieldResult, isFieldApplicable };
