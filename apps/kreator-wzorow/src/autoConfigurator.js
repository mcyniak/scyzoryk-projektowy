// Auto-konfiguracja kandydatow Kreatora - lokalny, deterministyczny silnik
// (zero AI/sieci). Ten modul jest CZYSTY: nigdy nie mutuje draftu, nie
// zapisuje do pamieci, nie dotyka dysku poza odczytem przekazanego juz w
// pamieci arkusza. Mutacja draftu na podstawie wyniku analizy zyje w
// autoConfigApply.js.
//
// Priorytet: zero blednych auto-mappingow > wyjasnialnosc > coverage. Progi i
// marginesy sa celowo konserwatywne - lepiej wiecej kandydatow w "review" niz
// choc jeden zly "auto". Zrodla:
//   PROMPT_CLAUDE_AUTO_KONFIGURACJA_KREATORA.md (pierwsza wersja)
//   PROMPT_CLAUDE_HARDENING_AUTO_KONFIGURACJI_KREATORA.md (hardening, unit-aware
//     matching, analyze-only-unresolved, concept-aware grouping, previously-
//     rejected guard, wazone aliasy, negative domain tokens)
const {
  normalizeValue, tokenize, isTrivialValue, columnTokenCoverage, guessValueType,
  parseNumericValue, numericMatchKey, compareValues,
} = require('./textNormalize');
const domainAliases = require('./domainAliases');

const AUTO_APPLY_THRESHOLD = 0.95;
const REVIEW_THRESHOLD = 0.75;
const MIN_MARGIN_FOR_AUTO = 15; // punkty na skali 0-100, przed kara za kolizje
const COLLISION_BAND = 8; // inna kolumna w tym promieniu od zwyciezcy liczy sie jako kolidujaca

// --- profilowanie kolumn Excela i indeks wartosci ---------------------------

// Runtime-only (NIGDY nie zapisywane na dysk) - per-kolumnowy profil + DWA
// indeksy wartosci: `valueIndex` (tekstowy/"slaby", normalizeValue - dalej
// obcina jednostke, bo to jest ogolny normalizator tekstu uzywany tez np.
// przez context matching) i `strictValueIndex` (liczbowy Z jednostka,
// hardening sekcja 5 - "10 kWh" i "10 kWp" MUSZA miec inne klucze).
function profileWorkbookColumns(sheet) {
  return sheet.columns.map((name) => {
    const valueIndex = new Map();
    const strictValueIndex = new Map();
    let nonEmptyCount = 0;
    const typeCounts = {};
    const examples = [];

    for (const row of sheet.rows) {
      const raw = row[name];
      if (raw === undefined || raw === null || String(raw).trim() === '') continue;
      nonEmptyCount++;
      if (examples.length < 5) examples.push(raw);
      const norm = normalizeValue(raw);
      const list = valueIndex.get(norm) || [];
      list.push({ recordNumber: row._record, rawValue: raw });
      valueIndex.set(norm, list);

      const parsed = parseNumericValue(raw);
      if (parsed) {
        const key = numericMatchKey(parsed);
        const strictList = strictValueIndex.get(key) || [];
        strictList.push({ recordNumber: row._record, rawValue: raw });
        strictValueIndex.set(key, strictList);
      }

      const type = guessValueType(norm) || 'free-text';
      typeCounts[type] = (typeCounts[type] || 0) + 1;
    }

    const dominantType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'free-text';
    return {
      name,
      normalizedTokens: tokenize(normalizeValue(name)),
      totalCount: sheet.rows.length,
      emptyCount: sheet.rows.length - nonEmptyCount,
      uniqueCount: valueIndex.size,
      uniquenessRatio: nonEmptyCount ? valueIndex.size / nonEmptyCount : 0,
      dominantType,
      examples,
      valueIndex,
      strictValueIndex,
    };
  });
}

// Indeks GLOBALNY (wszystkie kolumny razem) - uzywany wylacznie do detekcji
// wiersza wzorcowego. Rowniez dwa warianty: strict (unit-aware) i weak.
function buildValueIndex(sheet) {
  const index = new Map();
  for (const row of sheet.rows) {
    for (const columnName of sheet.columns) {
      const raw = row[columnName];
      if (raw === undefined || raw === null || String(raw).trim() === '') continue;
      const norm = normalizeValue(raw);
      const list = index.get(norm) || [];
      list.push({ recordNumber: row._record, columnName, rawValue: raw });
      index.set(norm, list);
    }
  }
  return index;
}

function buildStrictValueIndex(sheet) {
  const index = new Map();
  for (const row of sheet.rows) {
    for (const columnName of sheet.columns) {
      const raw = row[columnName];
      if (raw === undefined || raw === null || String(raw).trim() === '') continue;
      const parsed = parseNumericValue(raw);
      if (!parsed) continue;
      const key = numericMatchKey(parsed);
      const list = index.get(key) || [];
      list.push({ recordNumber: row._record, columnName, rawValue: raw });
      index.set(key, list);
    }
  }
  return index;
}

// --- detekcja wiersza wzorcowego ---------------------------------------------

// Unit-aware (hardening sekcja 6): STRICT trafienie (liczba+jednostka albo
// identyczny tekst) liczy sie pelnym wynikiem, WEAK trafienie (sama liczba
// bez pewnosci co do jednostki) liczy sie ULAMKIEM wyniku i - kluczowe -
// NIGDY samodzielnie nie wystarcza do wykrycia wiersza: wymagany jest
// przynajmniej jeden STRICT match wsrod dopasowanych kandydatow.
function detectSampleRow(candidates, valueIndex, strictValueIndex) {
  const nonTrivial = candidates.filter((c) => !isTrivialValue(normalizeValue(c.text)));
  const rowScores = new Map(); // recordNumber -> { score, matched: Set, strongMatched: Set }

  for (const candidate of nonTrivial) {
    const candNorm = normalizeValue(candidate.text);
    const parsed = parseNumericValue(candidate.text);
    // Niejednoznacznosc jednostki dotyczy WYLACZNIE liczb - zwykly tekst
    // ("Testowa 1" == "Testowa 1") nie ma tego problemu i zawsze jest
    // "silnym" trafieniem. Dla liczb: strict (zgodna jednostka/brak
    // jednostki po obu stronach) = silne, WYLACZNIE-tekstowe trafienie przy
    // rozjezdzie jednostek = slabe.
    let isStrong = false;
    let hits = [];
    if (parsed) {
      const strictHits = strictValueIndex.get(numericMatchKey(parsed)) || [];
      if (strictHits.length > 0) { isStrong = true; hits = strictHits; } else {
        const weakHits = valueIndex.get(candNorm) || [];
        if (weakHits.length > 0) { isStrong = false; hits = weakHits; }
      }
    } else {
      const textHits = valueIndex.get(candNorm) || [];
      if (textHits.length > 0) { isStrong = true; hits = textHits; }
    }
    if (!hits.length) continue;

    const distinctivenessBonus = hits.length <= 1 ? 2 : hits.length <= 3 ? 1 : 0;
    const baseScore = isStrong ? (3 + distinctivenessBonus) : 2; // weak = nizsza, stala waga (nie zero - realny sygnal, tylko slabszy)
    const countedRecords = new Set();
    for (const hit of hits) {
      if (countedRecords.has(hit.recordNumber)) continue;
      countedRecords.add(hit.recordNumber);
      const entry = rowScores.get(hit.recordNumber) || { score: 0, matched: new Set(), strongMatched: new Set() };
      entry.score += baseScore;
      entry.matched.add(candidate.id);
      if (isStrong) entry.strongMatched.add(candidate.id);
      rowScores.set(hit.recordNumber, entry);
    }
  }

  const ranked = [...rowScores.entries()]
    .map(([recordNumber, e]) => ({ recordNumber, score: e.score, matchedCount: e.matched.size, strongMatchedCount: e.strongMatched.size }))
    .sort((a, b) => b.score - a.score || b.matchedCount - a.matchedCount);

  if (!ranked.length) return { recordNumber: null, confidence: 0, matchedCandidateCount: 0, reason: 'no-matches' };

  const [top1, top2] = ranked;
  // 7, nie 9 (przed hardeningiem unit-aware) - obnizone tak, zeby 1 silne
  // (5 pkt) + 1 slabe (2 pkt) dopasowanie razem dalej wystarczaly do
  // wykrycia, skoro slabe samo w sobie juz nie ma "podciagnietej" wagi co
  // silne (patrz baseScore wyzej) - strongMatchedCount>=1 ponizej i tak
  // pilnuje, zeby SAM slaby sygnal nigdy nie wystarczyl.
  const MIN_SCORE = 7;
  const MIN_MATCHED_CANDIDATES = 2;
  const MIN_MARGIN_RATIO = 1.5;
  const MIN_MARGIN_ABS = 4;

  if (top1.score < MIN_SCORE || top1.matchedCount < MIN_MATCHED_CANDIDATES) {
    return { recordNumber: null, confidence: 0, matchedCandidateCount: top1.matchedCount, reason: 'below-minimum' };
  }
  // Hardening sekcja 6: sam "weak" (numeric bez pewnosci co do jednostki)
  // nigdy nie wystarcza - wymagany co najmniej jeden STRICT match.
  if (top1.strongMatchedCount < 1) {
    return { recordNumber: null, confidence: 0, matchedCandidateCount: top1.matchedCount, reason: 'weak-only' };
  }

  const runnerUp = top2 ? top2.score : 0;
  const marginOk = (top1.score - runnerUp) >= MIN_MARGIN_ABS && (runnerUp === 0 || top1.score / runnerUp >= MIN_MARGIN_RATIO);
  if (!marginOk) {
    return { recordNumber: null, confidence: 0, matchedCandidateCount: top1.matchedCount, reason: 'ambiguous-top2' };
  }

  return {
    recordNumber: top1.recordNumber,
    confidence: clamp(top1.score / (top1.score + 6), 0, 1),
    matchedCandidateCount: top1.matchedCount,
    reason: 'ok',
  };
}

// --- kontekst kandydata -------------------------------------------------------

// Wszystkie pola kontekstu sa opcjonalne (kompatybilnosc wsteczna z jobami
// zeskanowanymi przed rozszerzeniem CandidateDto o kontekst strukturalny) -
// brakujace pole to po prostu brak wkladu do tokenow, nigdy wyjatek.
//
// CELOWO bez candidate.before/after (caly poprzedni/nastepny akapit/wiersz,
// az do 80 znakow, z MarkScanner.GetSurroundingContext) - te pola sa z
// zalozenia LUZNYM fingerprintem do weryfikacji "czy dokument sie zmienil od
// skanu" (patrz komentarz przy GetSurroundingContext w C#: "nie musi byc
// idealnie precyzyjny"), nie sygnalem semantycznym. Znaleziono na zywym
// dokumencie (Wzor PV.docx): akapit "Panele fotowoltaiczne zaprojektowano na
// polaci dachu..." nie wspomina falownika ani razu, ale JEGO "after" to caly
// NASTEPNY akapit "Falownik i magazyn zostana zamontowane w garazu" -
// wystarczylo to samo w sobie, zeby CONTEXT_HEADER_SIMILARITY dala 100% dla
// kolumny "falownik", mimo ze kandydat mowi o orientacji dachu. Ten sam blad
// juz raz naprawiono w classifyManualCandidate (patrz nizej) - tu byl
// przeoczony. paragraphPrefix/paragraphSuffix (z tego samego akapitu co
// kandydat) sa bezpieczne i wystarczajace.
function collectContextTokens(candidate) {
  const parts = [candidate.paragraphPrefix, candidate.paragraphSuffix, candidate.leftCellText, candidate.rightCellText];
  const tokens = [];
  for (const part of parts) {
    if (!part) continue;
    tokens.push(...tokenize(normalizeValue(part)));
  }
  return tokens;
}

function collectContextText(candidate) {
  return [candidate.paragraphPrefix, candidate.paragraphSuffix, candidate.leftCellText, candidate.rightCellText]
    .filter(Boolean).join(' ');
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// --- scoring kandydat -> kolumna ----------------------------------------------

const VALUE_MATCH_STRONG_CODES = new Set(['SAMPLE_ROW_EXACT', 'EXACT_VALUE_AND_UNIT', 'EXACT_MATCH_ANYWHERE']);

function scoreCandidateColumn(candidate, column, { sampleRowRecord, mappingPriors } = {}) {
  const candNorm = normalizeValue(candidate.text);
  const trivial = isTrivialValue(candNorm);
  let score = 0;
  const reasons = [];

  // --- dopasowanie WARTOSCI, unit-aware (hardening sekcja 5/6) -------------
  let sampleCmp = null;
  if (sampleRowRecord) sampleCmp = compareValues(candidate.text, sampleRowRecord[column.name]);

  if (sampleCmp === 'strong') {
    score += 65;
    reasons.push({ code: 'SAMPLE_ROW_EXACT', weight: 65, message: `Wartość (z jednostką, jeśli była) zgodna z wykrytym wierszem wzorcowym w kolumnie "${column.name}".` });
  } else if (sampleCmp === 'weak') {
    score += 40;
    reasons.push({ code: 'NUMERIC_VALUE_COMPATIBLE', weight: 40, message: `Ta sama liczba co w wykrytym wierszu wzorcowym w kolumnie "${column.name}", ale bez pewności co do jednostki.` });
  } else {
    if (sampleCmp === 'conflict') {
      reasons.push({ code: 'UNIT_CONFLICT', weight: 0, message: `Ta sama liczba, ale inna jednostka niż w wykrytym wierszu wzorcowym kolumny "${column.name}" - to raczej inne pole.` });
    }
    const parsed = parseNumericValue(candidate.text);
    if (parsed) {
      const strictHits = column.strictValueIndex.get(numericMatchKey(parsed)) || [];
      if (strictHits.length > 0) {
        score += 30;
        reasons.push({ code: 'EXACT_VALUE_AND_UNIT', weight: 30, message: `Wartość i jednostka znalezione w ${strictHits.length} wierszu/wierszach kolumny "${column.name}".` });
      } else {
        const weakHits = column.valueIndex.get(candNorm) || [];
        if (weakHits.length > 0) {
          score += 15;
          reasons.push({ code: 'NUMERIC_VALUE_COMPATIBLE', weight: 15, message: `Sama liczba (bez pewności co do jednostki) znaleziona w kolumnie "${column.name}".` });
        }
      }
    } else {
      const hits = column.valueIndex.get(candNorm) || [];
      if (hits.length > 0) {
        score += 30;
        reasons.push({ code: 'EXACT_MATCH_ANYWHERE', weight: 30, message: `Wartość znaleziona w ${hits.length} wierszu/wierszach kolumny "${column.name}".` });
      }
    }
  }

  // --- kontekst / naglowek ---------------------------------------------------
  const ctxTokens = collectContextTokens(candidate);
  const sim = columnTokenCoverage(ctxTokens, column.normalizedTokens);
  if (sim > 0) {
    const w = Math.round(sim * 42);
    score += w;
    reasons.push({ code: 'CONTEXT_HEADER_SIMILARITY', weight: w, message: `Podobieństwo kontekstu do nazwy kolumny: ${Math.round(sim * 100)}%.` });
  }

  // --- pojecie domenowe, wazone (hardening sekcja 16) ------------------------
  const ctxText = ctxTokens.join(' ');
  const colText = column.normalizedTokens.join(' ');
  const candConcepts = domainAliases.findConceptsForText(ctxText);
  const colConcepts = domainAliases.findConceptsForText(colText);
  let sharedConcept = null;
  for (const cc of candConcepts) {
    const match = colConcepts.find((x) => x.concept === cc.concept);
    if (!match) continue;
    const combinedWeight = Math.min(cc.weight, match.weight);
    if (!sharedConcept || combinedWeight > sharedConcept.weight) sharedConcept = { concept: cc.concept, weight: combinedWeight };
  }
  if (sharedConcept) {
    const w = Math.round(24 * sharedConcept.weight);
    if (w > 0) {
      score += w;
      reasons.push({ code: 'DOMAIN_ALIAS_MATCH', weight: w, message: `Kontekst i nazwa kolumny pasują do pojęcia "${sharedConcept.concept}" (siła ${Math.round(sharedConcept.weight * 100)}%).` });
    }
  }

  // --- konflikt domenowy, negative tokens (hardening sekcja 17) -------------
  if (domainAliases.hasDomainConflict(ctxText, colText)) {
    score -= 20;
    reasons.push({ code: 'DOMAIN_CONFLICT', weight: -20, message: `Kontekst i nazwa kolumny "${column.name}" wyglądają na różne domeny (np. PV vs PC) - prawdopodobnie inne pole.` });
  }

  // --- pamiec, signed prior (hardening sekcja 2) -----------------------------
  // getPriors() zwraca WSZYSTKIE kolumny majace historie dla tego kontekstu
  // (nie jedna "najlepsza") - kazda kolumna sprawdza WYLACZNIE WLASNY wpis,
  // zeby dwie rozne kolumny o przeciwnym znaku priorytetu (jedna czesto
  // akceptowana, druga czesto odrzucana dla tego samego kontekstu) obie
  // poprawnie wplywaly na SWOJ wynik, zamiast jednej z nich znikac przez
  // globalne "zwyciestwo" drugiej (naprawiony bug).
  const mappingPrior = (mappingPriors || []).find((p) => p.columnName === column.name);
  if (mappingPrior && mappingPrior.weight) {
    score += mappingPrior.weight;
    const total = mappingPrior.accepted + mappingPrior.rejected;
    if (mappingPrior.weight > 0) {
      reasons.push({ code: 'MEMORY_ACCEPTED_PRIOR', weight: mappingPrior.weight, message: `Wcześniej zaakceptowano to mapowanie ${mappingPrior.accepted}/${total} razy.` });
    } else {
      reasons.push({ code: 'MEMORY_REJECTED_PRIOR', weight: mappingPrior.weight, message: `To mapowanie było wcześniej częściej odrzucane niż akceptowane (${mappingPrior.rejected}/${total}).` });
    }
  }

  // --- typ / trywialnosc / unikalnosc -----------------------------------------
  const candType = guessValueType(candNorm);
  if (candType && candType === column.dominantType) {
    score += 8;
    reasons.push({ code: 'TYPE_MATCH', weight: 8, message: 'Typ wartości zgodny z kolumną.' });
  } else if ((candType === 'numeric' && column.dominantType === 'free-text') || (candType === 'free-text' && column.dominantType === 'numeric')) {
    score -= 10;
    reasons.push({ code: 'TYPE_MISMATCH', weight: -10, message: 'Typ wartości NIE pasuje do kolumny.' });
  }

  if (trivial) {
    score -= 15;
    reasons.push({ code: 'TRIVIAL_VALUE', weight: -15, message: 'Wartość zbyt ogólna do wiarygodnego dopasowania.' });
  } else if (column.uniquenessRatio > 0.8) {
    score += 6;
    reasons.push({ code: 'HIGH_UNIQUENESS', weight: 6, message: 'Kolumna ma wysoką unikalność wartości.' });
  }

  return { column: column.name, score: clamp(score, 0, 100), reasons, concept: sharedConcept ? sharedConcept.concept : null };
}

function scoreCandidate(candidate, columns, ctx = {}) {
  const perColumn = columns.map((col) => scoreCandidateColumn(candidate, col, ctx)).sort((a, b) => b.score - a.score);
  const [top1, top2] = perColumn;
  if (!top1) {
    return {
      bestColumn: null, score: 0, finalScore: 0, rawTopScore: 0, rawRunnerUpScore: 0, margin: 0,
      reasons: [], alternatives: [], concept: null, hasStrongCurrentEvidence: false,
    };
  }

  const colliders = perColumn.filter((p) => p !== top1 && p.score > 0 && top1.score - p.score <= COLLISION_BAND);
  let score = top1.score;
  const reasons = [...top1.reasons];
  if (colliders.length) {
    const penalty = Math.min(20, colliders.length * 6);
    score -= penalty;
    reasons.push({ code: 'MULTI_COLUMN_COLLISION', weight: -penalty, message: `Pasuje niemal równie dobrze do ${colliders.length} innej/innych kolumn.` });
  }

  const hasStrongCurrentEvidence = top1.reasons.some((r) => VALUE_MATCH_STRONG_CODES.has(r.code));

  // Hardening sekcja 21/22: sugestia zablokowana z poprzedniej sesji (user ja
  // jawnie odrzucil DLA TEGO SAMEGO kandydata i TEJ SAMEJ kolumny) nie moze
  // wrocic jako "auto" bez NOWEGO, silnego dowodu z BIEZACEGO dokumentu -
  // sama pamiec (MEMORY_*_PRIOR, max +-15) nigdy nie wystarczy do jej
  // odblokowania, potrzebne jest realne dopasowanie wartosci teraz.
  const previouslyRejectedForThisColumn = Boolean(
    ctx.previouslyRejectedColumns && ctx.previouslyRejectedColumns.has(top1.column)
  );

  return {
    bestColumn: top1.column,
    score: clamp(score, 0, 100),
    finalScore: clamp(score, 0, 100),
    rawTopScore: top1.score,
    rawRunnerUpScore: top2 ? top2.score : 0,
    margin: top1.score - (top2 ? top2.score : 0),
    reasons,
    alternatives: perColumn.slice(0, 3),
    concept: top1.concept || null,
    hasStrongCurrentEvidence,
    previouslyRejectedForThisColumn,
  };
}

// "Wspomina temat" (kontekst/alias domenowy) to o wiele slabszy dowod niz
// "wartosc faktycznie gdzies wystepuje w tej kolumnie" albo "user juz kiedys
// zaakceptowal to samo mapowanie". Zlapane na zywym dokumencie (Wzor PV.docx,
// 2026-09-15): caly akapit o doborze kabla/zabezpieczenia dla falownika
// sprawial, ze KAZDA podswietlona liczba w tym akapicie (prad, przekroj
// kabla) dostawala sugestie "falownik" tylko dlatego, ze slowo "falownik"
// padlo GDZIES w tym samym akapicie - CONTEXT_HEADER_SIMILARITY (do 42) +
// DOMAIN_ALIAS_MATCH (do 24) + TYPE_MATCH (8) + HIGH_UNIQUENESS (6) = do 80
// pkt, ponad prog review (75), bez ZADNEGO potwierdzenia w samej wartosci.
const VALUE_OR_MEMORY_EVIDENCE_CODES = new Set([...VALUE_MATCH_STRONG_CODES, 'NUMERIC_VALUE_COMPATIBLE', 'MEMORY_ACCEPTED_PRIOR']);

function classifyTier(scored) {
  const confidence = scored.score / 100;
  let tier = 'unresolved';
  if (confidence >= AUTO_APPLY_THRESHOLD && scored.margin >= MIN_MARGIN_FOR_AUTO) tier = 'auto';
  else if (confidence >= REVIEW_THRESHOLD) tier = 'review';

  // Array.isArray guard: kilka istniejacych testow woła classifyTier() z
  // recznie sklejonym {score, margin} bez pola reasons, zeby przetestowac
  // WYLACZNIE logike progu/marginesu w izolacji - w takim przypadku bramka
  // ponizej jest pomijana (nie ma czego sprawdzic), nigdy nie demotuje.
  // Prawdziwe wywolania z scoreCandidate() zawsze maja reasons (choc moze
  // byc puste).
  if (tier !== 'unresolved' && Array.isArray(scored.reasons)) {
    const hasEvidence = scored.reasons.some((r) => VALUE_OR_MEMORY_EVIDENCE_CODES.has(r.code) && r.weight > 0);
    if (!hasEvidence) tier = 'unresolved';
  }

  // Hardening sekcja 21: nigdy "auto" na mapowaniu wczesniej jawnie odrzuconym
  // przez uzytkownika DLA TEGO SAMEGO kandydata, chyba ze biezacy dokument daje
  // nowy, silny dowod (SAMPLE_ROW_EXACT/EXACT_VALUE_AND_UNIT/EXACT_MATCH_ANYWHERE).
  if (tier === 'auto' && scored.previouslyRejectedForThisColumn && !scored.hasStrongCurrentEvidence) {
    tier = 'review';
  }
  return tier;
}

// --- klasyfikator "DO PROJEKTANTA" (konserwatywny) ---------------------------

// Slowa "mocne" - same, w dlugim bloku, wystarczaja do auto; slowa "zwykle"
// zawsze ladują co najwyzej w review. Formy juz bez polskich diakrytykow
// (porownywane z normalizeValue, ktore je usuwa).
const MANUAL_STRONG_KEYWORDS = ['obliczenia', 'obliczenie', 'spadek napiecia', 'prad zwarciowy', 'pv*sol', 'pvsol'];
// "dobor przewodu"/"zabezpieczenie" (rzeczownik) obok "dobrano przewod"/
// "dobrano wylacznik" (czasownik) - realne dokumenty (REFERENCJE_Excel_Word,
// 2026-09-15) opisuja dobor kabla/zabezpieczenia czasownikowo ("Dla falownika
// dobrano przewod YDY 5x4mm2 ... W celu zabezpieczenia Falownika dobrano
// wylacznik nadpradowy..."), a "zabezpieczenia" (dopelniacz) nie zawiera w
// sobie podciagu "zabezpieczenie" (rozne koncowki) - substring-match sam z
// siebie tego nie zlapie, wiec cale zdanie z prądem/przekrojem kabla dla
// falownika zostawalo bez klasyfikacji zamiast trafic do projektanta.
const MANUAL_KEYWORDS = ['dobor przewodu', 'dobor kabla', 'dobrano przewod', 'dobrano kabel', 'dobrano wylacznik', 'dobrano zabezpieczenie', 'dobrano bezpiecznik', 'wylacznik nadpradowy', 'obciazenie', 'snieg', 'wiatr', 'nosnosc', 'konstrukcja', 'zabezpieczenie', 'zabezpieczenia', 'symulacja', 'schemat', 'analiza statyczna'];
const MANUAL_MIN_BLOCK_LENGTH = 40;
const MANUAL_STRONG_MIN_LENGTH = 80;

// Drugi parametr to JUZ POLICZONY classifyTier(scored) dla tego samego
// kandydata (nie surowy wynik per-kolumnowy) - blad zlapany na zywym
// dokumencie 2026-09-15: wczesniejsza wersja liczyla wlasny "czy juz dobrze
// pasuje do kolumny" prog na SUROWYM top1.score (przed bramka dowodowa w
// classifyTier), wiec kandydat typu "Iz = 27A" (surowy wynik 78 z samego
// kontekstu/aliasu, bez zadnego dowodu wartosci - dokladnie ten przypadek,
// ktory classifyTier juz poprawnie zdemotowal do 'unresolved') nigdy nie
// dostawal szansy na klasyfikacje manualna, bo "wygladal" na dobrze
// dopasowany do kolumny "falownik", mimo ze finalnie i tak ladowal jako
// unresolved. Uzywajac tej samej, juz przefiltrowanej decyzji co reszta
// systemu, obie klasyfikacje sa spojne.
function classifyManualCandidate(candidate, fieldTier) {
  // Wyraznie dopasowane do kolumny Excela (auto/review z realnym dowodem) -
  // to dane, nie tresc do projektanta, niezaleznie od tego, jakie slowo
  // akurat pada w kontekscie.
  if (fieldTier === 'auto' || fieldTier === 'review') return { tier: 'none' };

  // Celowo TYLKO wlasna tresc bloku (nie sasiedni akapit/naglowek z before/
  // after) - real bug zlapany na zywym dokumencie: "before" bywa naglowkiem
  // SEKCJI, ktory zawiera mocne slowo-klucz mimo ze SAM kandydat to tylko
  // nazwa modelu urzadzenia. Zakres wyszukiwania slow-kluczy musi byc SPOJNY
  // ze zakresem sprawdzanym przez MANUAL_MIN_BLOCK_LENGTH ponizej.
  const blockText = candidate.paragraphText || candidate.text || '';
  const contextText = normalizeValue(blockText);
  const hasStrong = MANUAL_STRONG_KEYWORDS.some((k) => contextText.includes(k));
  const hasWeak = MANUAL_KEYWORDS.some((k) => contextText.includes(k));
  if (!hasStrong && !hasWeak) return { tier: 'none' };

  // Krotki fragment dzielacy TYLKO slowo-klucz (np. samo "konstrukcja" w
  // niezwiazanym zdaniu) nie ma stac sie automatycznie "Do projektanta".
  if (blockText.trim().length < MANUAL_MIN_BLOCK_LENGTH) return { tier: 'none' };

  const reasons = [{ code: 'MANUAL_KEYWORD_CONTEXT', weight: 0, message: 'Kontekst zawiera język typowy dla obliczeń/opisu technicznego.' }];
  if (hasStrong && blockText.trim().length >= MANUAL_STRONG_MIN_LENGTH) {
    return { tier: 'auto', reasons };
  }
  return { tier: 'review', reasons };
}

// --- detekcja stalych (konserwatywna, nigdy auto w tej turze) ----------------

function detectConstantCandidate(candidate, scoredColumns, repeatCount = 1, fieldTier = null) {
  const bestScore = scoredColumns && scoredColumns.length ? scoredColumns[0].score : 0;
  // Jak w classifyManualCandidate - "wyraznie dynamiczne" znaczy realny dowod
  // (auto/review PO bramce dowodowej classifyTier), nie sam surowy top1.score
  // (kontekst/alias same w sobie moga dac >=75 bez zadnego dopasowania
  // wartosci). Gdy fieldTier nie jest podany (kompatybilnosc wsteczna/testy
  // izolowane), zachowanie spada do starego progu na surowym wyniku.
  if (fieldTier !== null ? (fieldTier === 'auto' || fieldTier === 'review') : bestScore >= REVIEW_THRESHOLD * 100) return { tier: 'none' }; // wyraznie dynamiczne

  const norm = normalizeValue(candidate.text);
  if (!norm || isTrivialValue(norm)) return { tier: 'none' };

  if (repeatCount > 1 && bestScore < 20) {
    return {
      tier: 'review',
      reasons: [{ code: 'CONSTANT_REPEATED_NO_MATCH', weight: 0, message: 'Tekst powtarza się w dokumencie i nie pasuje do żadnej kolumny Excela - może być stałym tekstem.' }],
    };
  }
  return { tier: 'none' };
}

// --- grupowanie powtarzajacych sie pol ----------------------------------------

function sanitizeForId(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '') || 'col';
}

// Grupuje TYLKO kandydatow, ktorzy trafili w te sama kolumne PRZEZ SILNE
// dopasowanie WARTOSCI (sample-row exact/weak/exact-value-and-unit/exact-
// match-anywhere - NIE samym kontekstem/aliasem) I majacych ZGODNE pojecie
// domenowe (hardening sekcja 15 - "10 przy Liczba modulow" i "10 przy
// Magazyn energii" nigdy nie moga stac sie jednym polem nawet gdyby przez
// przypadek trafily w ta sama kolumne). Brak pojecia (`null`) grupuje sie
// TYLKO z innymi kandydatami tez bez pojecia, nigdy z majacymi jakiekolwiek
// konkretne pojecie.
const VALUE_MATCH_CODES = new Set(['SAMPLE_ROW_EXACT', 'NUMERIC_VALUE_COMPATIBLE', 'EXACT_VALUE_AND_UNIT', 'EXACT_MATCH_ANYWHERE']);

function groupRepeatedFields(candidateSuggestions) {
  const byColumn = new Map();
  for (const s of candidateSuggestions) {
    if (s.kind !== 'field' || !s.bestColumn) continue;
    const hasValueMatch = (s.reasons || []).some((r) => VALUE_MATCH_CODES.has(r.code));
    if (!hasValueMatch) continue;
    const list = byColumn.get(s.bestColumn) || [];
    list.push(s);
    byColumn.set(s.bestColumn, list);
  }

  const groups = [];
  let seq = 0;
  for (const [column, members] of byColumn.entries()) {
    const byConcept = new Map();
    for (const m of members) {
      const key = m.concept || '(none)';
      const list = byConcept.get(key) || [];
      list.push(m);
      byConcept.set(key, list);
    }
    for (const [, sameConceptMembers] of byConcept.entries()) {
      if (sameConceptMembers.length < 2) continue;
      seq++;
      const groupId = `grp_${seq}_${sanitizeForId(column)}`;
      for (const member of sameConceptMembers) member.fieldGroupId = groupId;
      groups.push({ groupId, label: column, column, candidateIds: sameConceptMembers.map((m) => m.candidateId) });
    }
  }
  return groups;
}

// --- kompozycja: cala analiza --------------------------------------------------

// `options.previouslyRejectedByCandidate`: Map<candidateId, Set<columnName>>
// (albo plain object {candidateId: [columnName,...]}) - mapowania jawnie
// odrzucone przez uzytkownika WCZESNIEJ w TYM SAMYM jobie (hardening sekcja
// 8/21 - feedback NIE resetuje sie przy ponownej analizie).
function analyzeAutoConfiguration({ candidates, workbook, sheetName, draft, mappingMemory, options = {} }) {
  const resolvedSheetName = sheetName || (draft && draft.preferredSheet) || workbook.defaultSheet;
  const sheet = workbook.sheets[resolvedSheetName];
  if (!sheet) throw new Error(`Nieznany arkusz: ${resolvedSheetName}`);

  const columns = profileWorkbookColumns(sheet);
  const globalValueIndex = buildValueIndex(sheet);
  const globalStrictValueIndex = buildStrictValueIndex(sheet);
  const sampleRowResult = detectSampleRow(candidates, globalValueIndex, globalStrictValueIndex);
  const sampleRowRecord = sampleRowResult.recordNumber != null ? sheet.rows.find((r) => r._record === sampleRowResult.recordNumber) || null : null;
  const schemaFingerprint = mappingMemory && mappingMemory.buildSchemaFingerprint ? mappingMemory.buildSchemaFingerprint(sheet.columns) : '';

  // Hardening sekcja 7: analizuj TYLKO jeszcze nierozwiazanych kandydatow -
  // manual/field/block/constant juz ustawione (recznie albo z poprzedniej
  // rundy auto-konfiguracji) nigdy nie sa nadpisywane nowa analiza.
  const decisions = (draft && draft.candidates) || {};
  const allIds = candidates.map((c) => c.id);
  const unresolvedCandidates = candidates.filter((c) => {
    const d = decisions[c.id];
    return !d || d.status === 'unresolved';
  });
  const alreadyResolvedCount = allIds.length - unresolvedCandidates.length;

  const previouslyRejectedByCandidate = options.previouslyRejectedByCandidate || {};

  const textCounts = new Map();
  for (const c of unresolvedCandidates) {
    const key = normalizeValue(c.text);
    textCounts.set(key, (textCounts.get(key) || 0) + 1);
  }

  const candidateSuggestions = unresolvedCandidates.map((candidate) => {
    const contextKey = mappingMemory ? mappingMemory.buildContextKey(candidate) : '';
    const mappingPriors = mappingMemory ? mappingMemory.getPriors(contextKey, schemaFingerprint) : [];
    const rejectedRaw = previouslyRejectedByCandidate[candidate.id];
    const previouslyRejectedColumns = rejectedRaw ? new Set(Array.isArray(rejectedRaw) ? rejectedRaw : [...rejectedRaw]) : null;

    const scored = scoreCandidate(candidate, columns, { sampleRowRecord, mappingPriors, previouslyRejectedColumns });
    const fieldTier = classifyTier(scored);

    const manual = classifyManualCandidate(candidate, fieldTier);
    if (manual.tier !== 'none') {
      return {
        candidateId: candidate.id, kind: 'manual', tier: manual.tier,
        score: manual.tier === 'auto' ? 96 : 80, finalScore: manual.tier === 'auto' ? 96 : 80,
        rawTopScore: null, rawRunnerUpScore: null, margin: 0, bestColumn: null, fieldGroupId: null, concept: null,
        reasons: (manual.reasons || []).slice(0, 5),
      };
    }

    const constant = detectConstantCandidate(candidate, scored.alternatives, textCounts.get(normalizeValue(candidate.text)) || 1, fieldTier);
    if (constant.tier !== 'none') {
      return {
        candidateId: candidate.id, kind: 'constant', tier: constant.tier,
        score: 80, finalScore: 80, rawTopScore: null, rawRunnerUpScore: null, margin: 0, bestColumn: null, fieldGroupId: null, concept: null,
        reasons: (constant.reasons || []).slice(0, 5),
      };
    }

    return {
      candidateId: candidate.id, kind: 'field', tier: fieldTier,
      score: scored.finalScore, finalScore: scored.finalScore, rawTopScore: scored.rawTopScore, rawRunnerUpScore: scored.rawRunnerUpScore,
      margin: scored.margin, bestColumn: scored.bestColumn, fieldGroupId: null, concept: scored.concept,
      reasons: (scored.reasons || []).slice(0, 5),
    };
  });

  const fieldGroups = groupRepeatedFields(candidateSuggestions);

  const summary = candidateSuggestions.reduce((acc, s) => {
    if (s.tier === 'auto') acc.auto++;
    else if (s.tier === 'review') acc.review++;
    else acc.unresolved++;
    return acc;
  }, { auto: 0, review: 0, unresolved: 0 });
  summary.totalCandidates = allIds.length;
  summary.alreadyResolved = alreadyResolvedCount;
  summary.analyzed = unresolvedCandidates.length;
  // Kompatybilnosc wsteczna - "total" jak dotychczas oznaczalo "policzone w
  // tej analizie", nie "wszyscy kandydaci w jobie".
  summary.total = unresolvedCandidates.length;

  return {
    sheetName: resolvedSheetName,
    schemaFingerprint,
    sampleRow: sampleRowResult.recordNumber != null
      ? { recordNumber: sampleRowResult.recordNumber, confidence: sampleRowResult.confidence, matchedCandidateCount: sampleRowResult.matchedCandidateCount }
      : null,
    candidateSuggestions,
    fieldGroups,
    variantSuggestions: [],
    summary,
  };
}

module.exports = {
  AUTO_APPLY_THRESHOLD,
  REVIEW_THRESHOLD,
  MIN_MARGIN_FOR_AUTO,
  COLLISION_BAND,
  profileWorkbookColumns,
  buildValueIndex,
  buildStrictValueIndex,
  detectSampleRow,
  collectContextTokens,
  collectContextText,
  scoreCandidateColumn,
  scoreCandidate,
  classifyTier,
  classifyManualCandidate,
  detectConstantCandidate,
  groupRepeatedFields,
  analyzeAutoConfiguration,
};
