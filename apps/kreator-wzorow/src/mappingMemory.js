// Lokalna pamiec mapowan kandydat->kolumna dla auto-konfiguracji Kreatora
// (sekcja 4/29/45 promptu auto-konfiguracji). Trzyma WYLACZNIE reguly i
// metadane - kontekst (etykiety/naglowki ze SZABLONU, nigdy wartosc
// rekordu), nazwe pojecia, nazwe kolumny, liczniki akceptacji/odrzucen,
// czas ostatniego uzycia. NIGDY: imie/nazwisko, adres, wartosci rekordow,
// pelny arkusz Excela.
'use strict';

const fs = require('fs');
const path = require('path');
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
// to zawsze statyczny tekst wzoru, nie dane osobowe. Gdy zaden kontekst
// strukturalny nie jest dostepny (kompatybilnosc wsteczna ze starszymi
// jobami), spada na znormalizowany tekst samego kandydata jako fallback.
function buildContextKey(candidate) {
  const parts = [candidate.paragraphPrefix, candidate.paragraphSuffix, candidate.leftCellText, candidate.rightCellText];
  const tokens = [];
  for (const part of parts) {
    if (!part) continue;
    tokens.push(...tokenize(normalizeValue(part)));
  }
  const key = [...new Set(tokens)].sort().join(' ').trim();
  return key || normalizeValue(candidate.text);
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

  // Zwraca najczesciej akceptowane mapowanie dla danego kontekstu, albo
  // null gdy nie ma jeszcze zadnej historii (feedback wylacznie z realnych
  // akceptacji, nigdy z samych sugestii).
  function getPrior(contextKey) {
    if (!contextKey) return null;
    const forContext = state.mappings.filter((m) => m.contextKey === contextKey);
    if (!forContext.length) return null;
    const best = forContext.reduce((a, b) => (b.accepted > a.accepted ? b : a));
    if (best.accepted === 0 && best.rejected === 0) return null;
    return { columnName: best.columnAliases[0], accepted: best.accepted, rejected: best.rejected, logicalConcept: best.logicalConcept || null };
  }

  function recordAccepted(contextKey, logicalConcept, columnName) {
    if (!contextKey || !columnName) return;
    let entry = findEntry(contextKey, columnName);
    if (!entry) {
      entry = { contextKey, logicalConcept: logicalConcept || null, columnAliases: [columnName], accepted: 0, rejected: 0, lastUsedAt: null };
      state.mappings.push(entry);
    }
    entry.accepted += 1;
    entry.lastUsedAt = nowIso();
    persist();
  }

  function recordRejected(contextKey, logicalConcept, columnName) {
    if (!contextKey) return;
    let entry = columnName ? findEntry(contextKey, columnName) : state.mappings.find((m) => m.contextKey === contextKey);
    if (!entry) {
      entry = { contextKey, logicalConcept: logicalConcept || null, columnAliases: columnName ? [columnName] : [], accepted: 0, rejected: 0, lastUsedAt: null };
      state.mappings.push(entry);
    }
    entry.rejected += 1;
    entry.lastUsedAt = nowIso();
    persist();
  }

  return { getPrior, recordAccepted, recordRejected, buildContextKey };
}

module.exports = { createMappingMemory, buildContextKey, SCHEMA_VERSION, FILE_NAME };
