// Lokalna pamiec mapowan kandydat->kolumna dla auto-konfiguracji Kreatora
// (sekcja 4/29/45 promptu auto-konfiguracji, hardening: PROMPT_CLAUDE_
// HARDENING_AUTO_KONFIGURACJI_KREATORA.md sekcje 2-4/29/30/37). Trzyma
// WYLACZNIE reguly i metadane - kontekst (etykiety/naglowki ze SZABLONU,
// nigdy wartosc rekordu), nazwe pojecia, nazwe kolumny, fingerprint schematu
// arkusza, liczniki akceptacji/odrzucen, czas ostatniego uzycia. NIGDY:
// imie/nazwisko, adres, wartosci rekordow, pelny arkusz Excela.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizeValue, tokenize } = require('./textNormalize');

const SCHEMA_VERSION = 1;
const FILE_NAME = 'auto-config-memory.json';

function nowIso() {
  return new Date().toISOString();
}

function emptyState() {
  return { schemaVersion: SCHEMA_VERSION, mappings: [] };
}

// Kontekst = tresc SZABLONU wokol kandydata (etykiety w akapicie/tabeli),
// nigdy wartosc, ktora tam trafi po scaleniu z Excelem - kandydaci sa
// skanowani z pustego/przykladowego wzoru, PRZED wypelnieniem danymi, wiec
// to zawsze statyczny tekst wzoru, nie dane osobowe w TEORII. W PRAKTYCE
// jednak zdarzaja sie wzory, w ktorych "kontekst" (etykieta sasiedniej
// komorki/naglowek) sam w sobie wyglada jak dana wrazliwa (np. ktos zostawil
// w komorce obok prawdziwy przyklad zamiast etykiety) - stad isSafeMemoryContext
// nizej jako DRUGA, niezalezna linia obrony, nie tylko "skad wziety".
//
// WAZNE (naprawiony bug, hardening sekcja 3): TA FUNKCJA NIGDY nie ma
// fallbackowac do tekstu samego kandydata (candidate.text) - to byłaby
// realna wartosc z dokumentu/rekordu (np. "Kowalski Jan", adres), nie
// etykieta szablonu. Brak bezpiecznego kontekstu strukturalnego = pusty
// string, NIE tekst kandydata - a isSafeMemoryContext() i tak odrzuci pusty
// klucz, wiec taki kandydat po prostu nigdy nie trafia do pamieci.
function buildContextKey(candidate) {
  const parts = [candidate.paragraphPrefix, candidate.paragraphSuffix, candidate.leftCellText, candidate.rightCellText];
  const tokens = [];
  for (const part of parts) {
    if (!part) continue;
    tokens.push(...tokenize(normalizeValue(part)));
  }
  return [...new Set(tokens)].sort().join(' ').trim();
}

// Fingerprint schematu arkusza (WYLACZNIE naglowki kolumn, zero wartosci
// rekordow) - sekcja 4 promptu hardeningowego. Uzywany do priorytetyzowania
// pamieci z TEGO SAMEGO ksztaltu arkusza nad "obcym" schematem (inny projekt/
// inna tabela moglaby miec kolumne o tej samej nazwie, ale innym znaczeniu).
function buildSchemaFingerprint(columns) {
  const normalized = (columns || []).map((c) => normalizeValue(c)).filter(Boolean).sort();
  if (!normalized.length) return '';
  return crypto.createHash('sha256').update(normalized.join('|'), 'utf8').digest('hex');
}

// Druga linia obrony przed PII w pamieci (hardening sekcja 3) - konserwatywnie
// ODRZUCA zapis, jesli contextKey WYGLADA jak mogl wyciec z prawdziwej
// wartosci rekordu, niezaleznie skad faktycznie pochodzi:
//   - pusty klucz (brak bezpiecznego kontekstu strukturalnego),
//   - zbyt duzo cyfr wzgledem dlugosci (numer telefonu/dzialki/PESEL-like),
//   - zbyt dlugi (>6 tokenow) - prawdziwe etykiety szablonu sa krotkie
//     ("adres instalacji:"), dlugi ciag tokenow to raczej wyciekle calo
//     zdanie/opis, nie etykieta,
//   - klucz identyczny ze znormalizowana wartoscia SAMEGO kandydata - to
//     dokladnie stary, usuniety fallback (sekcja 3) odtworzony innym
//     sposobem, jesli kontekst i wartosc przypadkiem sie pokrywaja.
function isSafeMemoryContext(contextKey, candidateNormalizedText) {
  if (!contextKey) return false;
  if (candidateNormalizedText && contextKey === candidateNormalizedText) return false;
  const tokens = contextKey.split(' ').filter(Boolean);
  if (tokens.length === 0 || tokens.length > 6) return false;
  const digitCount = (contextKey.match(/\d/g) || []).length;
  if (digitCount > 0 && digitCount / contextKey.length > 0.3) return false;
  return true;
}

function createMappingMemory(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const filePath = path.join(dataDir, FILE_NAME);
  let state = load();

  function load() {
    if (!fs.existsSync(filePath)) return emptyState();
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!raw || raw.schemaVersion !== SCHEMA_VERSION || !Array.isArray(raw.mappings)) {
        return resetCorrupted(new Error('nieoczekiwany ksztalt pliku pamieci'));
      }
      return raw;
    } catch (err) {
      return resetCorrupted(err);
    }
  }

  // Uszkodzony/niekompatybilny plik NIGDY nie blokuje startu apki - kopia
  // zapasowa obok oryginalu (do diagnostyki), stan wraca do pustego.
  function resetCorrupted(err) {
    try {
      if (fs.existsSync(filePath)) {
        const backupPath = `${filePath}.corrupted-${Date.now()}.bak`;
        fs.copyFileSync(filePath, backupPath);
        console.error('[kreator-mapping-memory] uszkodzony plik pamieci, kopia zapasowa:', backupPath, (err && err.message) || err);
      }
    } catch (_) { /* najlepszy wysilek sprzatania - nigdy nie rzuca dalej */ }
    return emptyState();
  }

  // Zapis jest synchroniczny (fs.*Sync) i Node jest jednowatkowy - miedzy
  // odczytem `state` a zapisem nie ma zadnego `await`, wiec dwa "rownolegle"
  // requesty HTTP (ktore i tak sa obslugiwane sekwencyjnie na tym samym
  // event-loopie miedzy swoimi wlasnymi await-ami) nigdy nie przeplotą sie
  // W TRAKCIE jednej funkcji recordAccepted/recordRejected - nie ma tu
  // realnego wyscigu do zabezpieczenia kolejka/mutexem (sekcja 29 promptu
  // hardeningowego: "nie komplikuj cross-process, jesli child app jest
  // jeden" - w tym jednym procesie synchroniczny zapis JUZ jest atomowy
  // wzgledem innych requestow tego samego procesu; atomowosc WOBEC innych
  // PROCESOW/crasha w trakcie zapisu zapewnia tmp+rename ponizej).
  function persist() {
    try {
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 0), 'utf8');
      fs.renameSync(tmp, filePath);
    } catch (err) {
      console.error('[kreator-mapping-memory]', (err && err.message) || err);
    }
  }

  function findEntry(contextKey, columnName) {
    return state.mappings.find((m) => m.contextKey === contextKey && m.columnAliases.includes(columnName));
  }

  // Signed prior (naprawiony bug, hardening sekcja 2): stary kod liczyl
  // WYLACZNIE na podstawie `accepted`, wiec (accepted=0, rejected=1) dawalo
  // DODATNI bonus - odrzucone raz mapowanie bylo faworyzowane tak samo jak
  // nigdy nie ocenione. Teraz: signedScore = accepted - rejected, skalowany
  // do +-15 (Laplace-wygladzony, zeby jeden przypadek nie dawal skrajnych
  // wartosci), z jawnym rozroznieniem accepted/rejected w wyniku, zeby
  // wywolujacy (autoConfigurator.js) mogl dodac WLASCIWY reason code
  // (MEMORY_ACCEPTED_PRIOR vs MEMORY_REJECTED_PRIOR) zamiast jednego,
  // zawsze-pozytywnego MEMORY_PRIOR.
  //   5/0 -> +15, 3/1 -> +6, 1/3 -> -6, 0/5 -> -15, 0/0 -> brak wpisu (null)
  function signedPriorWeight(accepted, rejected) {
    const total = accepted + rejected;
    if (total === 0) return 0;
    return Math.round((15 * (accepted - rejected)) / (total + 2));
  }

// Zwraca priorytety dla WSZYSTKICH kolumn majacych historie dla danego
  // kontekstu (nie tylko "najlepszej" jednej) - naprawiony bug: poprzednia
  // wersja zwracala JEDEN "najbardziej przekonujacy" wpis wg |weight|, co
  // przy remisie (np. kolumna A: 0/1 -> weight -5, kolumna B: 1/0 -> weight
  // +5, |weight| rowne) arbitralnie gubilo informacje o DRUGIEJ kolumnie w
  // zaleznosci od kolejnosci wstawienia - scoreCandidateColumn ocenia KAZDA
  // kolumne osobno, wiec potrzebuje osobnego priorytetu dla kazdej z nich,
  // nie jednego globalnego "zwyciezcy". Preferuje TEN SAM schemaFingerprint
  // (hardening sekcja 4) - wpisy z obcego schematu licza sie z polowiczna
  // waga. Pomija wpisy o weight===0 (brak wystarczajacej historii).
  function getPriors(contextKey, schemaFingerprint) {
    if (!contextKey) return [];
    const forContext = state.mappings.filter((m) => m.contextKey === contextKey);
    if (!forContext.length) return [];

    return forContext
      .map((m) => {
        const weight = signedPriorWeight(m.accepted, m.rejected);
        const sameSchema = Boolean(schemaFingerprint) && m.schemaFingerprint === schemaFingerprint;
        const scaledWeight = sameSchema || !schemaFingerprint ? weight : Math.round(weight / 2);
        return {
          columnName: m.columnAliases[0],
          accepted: m.accepted,
          rejected: m.rejected,
          logicalConcept: m.logicalConcept || null,
          weight: scaledWeight,
          sameSchema,
        };
      })
      .filter((p) => p.weight !== 0);
  }

  // Kompatybilnosc wsteczna/wygoda - "najbardziej przekonujacy" POJEDYNCZY
  // wpis (najwiekszy |weight|, remis rozstrzygany na korzysc DODATNIEGO -
  // "warto sprobowac X" jest bardziej uzyteczna informacja niz samo "nie X"
  // bez wskazania alternatywy). Do realnego scoringu per-kolumna uzywaj
  // getPriors() powyzej, nie tej funkcji.
  function getPrior(contextKey, schemaFingerprint) {
    const priors = getPriors(contextKey, schemaFingerprint);
    if (!priors.length) return null;
    return priors.reduce((best, p) => {
      if (!best) return p;
      if (Math.abs(p.weight) > Math.abs(best.weight)) return p;
      if (Math.abs(p.weight) === Math.abs(best.weight) && p.weight > best.weight) return p;
      return best;
    }, null);
  }

  function recordAccepted(contextKey, logicalConcept, columnName, schemaFingerprint, candidateNormalizedText) {
    if (!columnName) return false;
    if (!isSafeMemoryContext(contextKey, candidateNormalizedText)) return false;
    let entry = findEntry(contextKey, columnName);
    if (!entry) {
      entry = { contextKey, schemaFingerprint: schemaFingerprint || '', logicalConcept: logicalConcept || null, columnAliases: [columnName], accepted: 0, rejected: 0, lastUsedAt: null };
      state.mappings.push(entry);
    }
    entry.accepted += 1;
    entry.lastUsedAt = nowIso();
    persist();
    return true;
  }

  function recordRejected(contextKey, logicalConcept, columnName, schemaFingerprint, candidateNormalizedText) {
    if (!isSafeMemoryContext(contextKey, candidateNormalizedText)) return false;
    let entry = columnName ? findEntry(contextKey, columnName) : state.mappings.find((m) => m.contextKey === contextKey);
    if (!entry) {
      entry = { contextKey, schemaFingerprint: schemaFingerprint || '', logicalConcept: logicalConcept || null, columnAliases: columnName ? [columnName] : [], accepted: 0, rejected: 0, lastUsedAt: null };
      state.mappings.push(entry);
    }
    entry.rejected += 1;
    entry.lastUsedAt = nowIso();
    persist();
    return true;
  }

  return { getPrior, getPriors, recordAccepted, recordRejected, buildContextKey, buildSchemaFingerprint, isSafeMemoryContext };
}

// Reczna korekta uczy pamiec (hardening sekcja 12/34): jesli auto-konfigurator
// zasugerowal kolumne A, a user finalnie recznie zapisal cos innego (kolumna
// B, albo manual/constant zamiast pola), to A dostaje +1 rejected, a nowy
// finalny wybor (jesli to tez kolumna, B) dostaje +1 accepted - dzieki temu
// nastepna analiza tego samego/podobnego kontekstu w tym projekcie bardziej
// preferuje B. Dedupe (sekcja 13, "nie nabijaj accepted/rejected wielokrotnie
// przy ponownym zapisie TEGO SAMEGO w jednym jobie") jest odpowiedzialnoscia
// WYWOLUJACEGO (server.js sledzi juz-zapisane zdarzenia per-job) - ta funkcja
// zawsze faktycznie zapisuje, gdy jest wywolana.
//
// `previousSuggestion` = { kind, bestColumn } albo null (brak sugestii - nic
// do odrzucenia). `finalDecision` = { kind, column } (column tylko dla
// kind==='field'). Nie zapisuje nic, jesli finalna decyzja jest IDENTYCZNA z
// sugestia (nie ma tu zadnej "korekty") - albo jesli kontekst jest niebezpieczny
// (patrz isSafeMemoryContext, sprawdzane wewnatrz recordAccepted/recordRejected).
function recordManualCorrectionFeedback(mappingMemory, candidate, previousSuggestion, finalDecision, schemaFingerprint) {
  const result = { rejectedPrevious: false, acceptedFinal: false };
  if (!mappingMemory || !previousSuggestion || !finalDecision) return result;

  const previousColumn = previousSuggestion.kind === 'field' ? (previousSuggestion.bestColumn || null) : null;
  const finalColumn = finalDecision.kind === 'field' ? (finalDecision.column || null) : null;
  const changed = previousSuggestion.kind !== finalDecision.kind || previousColumn !== finalColumn;
  if (!changed) return result;

  const contextKey = mappingMemory.buildContextKey(candidate);
  const candNorm = normalizeValue(candidate.text);

  if (previousColumn) {
    result.rejectedPrevious = mappingMemory.recordRejected(contextKey, null, previousColumn, schemaFingerprint, candNorm);
  }
  if (finalColumn) {
    result.acceptedFinal = mappingMemory.recordAccepted(contextKey, null, finalColumn, schemaFingerprint, candNorm);
  }
  return result;
}

module.exports = {
  createMappingMemory, buildContextKey, buildSchemaFingerprint, isSafeMemoryContext,
  recordManualCorrectionFeedback, SCHEMA_VERSION, FILE_NAME,
};
