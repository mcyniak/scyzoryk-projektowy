// Zastosowanie zaakceptowanych sugestii auto-konfiguracji (autoConfigurator.js)
// na drafcie Kreatora. Uzywa WYLACZNIE istniejacych helperow z
// templateManifest.js (tm) - nigdy nie duplikuje logiki mutacji draftu, zeby
// auto-konfiguracja i reczny panel uzywaly dokladnie tego samego modelu.
'use strict';

const tm = require('./templateManifest');

// `analysis` = wynik analyzeAutoConfiguration (patrz autoConfigurator.js).
// `candidates` = ta sama lista kandydatow, ktora posluzyla do analizy -
// potrzebna tu WYLACZNIE do policzenia contextKey przy zapisie do pamieci
// (obiekt sugestii w analysis.candidateSuggestions celowo nie niesie calego
// kontekstu kandydata, tylko wynik scoringu - patrz kontrakt API).
function applyAutoConfiguration(draft, analysis, { suggestionIds, applyHighConfidence, mappingMemory, candidates } = {}) {
  const suggestionsById = new Map((analysis.candidateSuggestions || []).map((s) => [s.candidateId, s]));
  const candidatesById = new Map((candidates || []).map((c) => [c.id, c]));

  const targets = applyHighConfidence
    ? (analysis.candidateSuggestions || []).filter((s) => s.tier === 'auto')
    : (Array.isArray(suggestionIds) ? suggestionIds : []).map((id) => suggestionsById.get(id)).filter(Boolean);

  let nextDraft = draft;
  const appliedSuggestionIds = [];
  const skipped = [];
  // Grupa (sekcja 14): pierwszy czlonek TWORZY pole, kolejni czlonkowie tej
  // samej grupy uzywaja JUZ istniejacego fieldId - inaczej powstalyby N
  // osobnych pol dla jednego logicznego pojecia (np. "Adres" powtorzony 3x).
  const fieldIdByGroupKey = new Map();

  for (const suggestion of targets) {
    const candidateId = suggestion.candidateId;
    const currentDecision = nextDraft.candidates[candidateId];
    if (currentDecision && currentDecision.status !== 'unresolved') {
      skipped.push({ suggestionId: candidateId, reason: 'already-resolved' });
      continue;
    }

    if (suggestion.kind === 'manual') {
      nextDraft = tm.setCandidateManual(nextDraft, candidateId, null);
    } else if (suggestion.kind === 'constant') {
      // detectConstantCandidate w autoConfigurator.js CELOWO nigdy nie
      // zwraca tier:'auto' - to zawsze kategoria "review", bo sugestia nie
      // zna docelowego tekstu stalej (tylko to, ze kandydat NA NIA wyglada).
      // Zastosowanie wymagaloby zgadywania tekstu za uzytkownika, czego ten
      // modul swiadomie nie robi - user ustawia stala recznie z panelu.
      skipped.push({ suggestionId: candidateId, reason: 'constant-needs-manual-text' });
      continue;
    } else if (suggestion.kind === 'field') {
      if (!suggestion.bestColumn) {
        skipped.push({ suggestionId: candidateId, reason: 'no-column' });
        continue;
      }
      const groupKey = suggestion.fieldGroupId || `single_${candidateId}`;
      let fieldId = fieldIdByGroupKey.get(groupKey);
      if (fieldId) {
        nextDraft = tm.assignCandidateToExistingField(nextDraft, candidateId, fieldId);
      } else {
        const fieldDef = {
          label: suggestion.bestColumn,
          required: false,
          emptyPolicy: 'warn',
          unknownPolicy: 'warn',
          valueSpec: { type: 'column', column: suggestion.bestColumn },
        };
        const result = tm.createFieldForCandidate(nextDraft, candidateId, fieldDef);
        nextDraft = result.draft;
        fieldId = result.fieldId;
        fieldIdByGroupKey.set(groupKey, fieldId);
      }

      if (mappingMemory) {
        const candidate = candidatesById.get(candidateId);
        if (candidate) {
          const contextKey = mappingMemory.buildContextKey(candidate);
          mappingMemory.recordAccepted(contextKey, null, suggestion.bestColumn);
        }
      }
    } else {
      skipped.push({ suggestionId: candidateId, reason: 'unknown-kind' });
      continue;
    }

    appliedSuggestionIds.push(candidateId);
  }

  return { draft: nextDraft, appliedCount: appliedSuggestionIds.length, appliedSuggestionIds, skipped };
}

module.exports = { applyAutoConfiguration };
