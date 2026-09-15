// Zastosowanie zaakceptowanych sugestii auto-konfiguracji (autoConfigurator.js)
// na drafcie Kreatora. Uzywa WYLACZNIE istniejacych helperow z
// templateManifest.js (tm) - nigdy nie duplikuje logiki mutacji draftu, zeby
// auto-konfiguracja i reczny panel uzywaly dokladnie tego samego modelu.
'use strict';

const tm = require('./templateManifest');
const { normalizeValue } = require('./textNormalize');

// `analysis` = wynik analyzeAutoConfiguration (patrz autoConfigurator.js).
// `candidates` = ta sama lista kandydatow, ktora posluzyla do analizy -
// potrzebna tu WYLACZNIE do policzenia contextKey przy zapisie do pamieci.
// `existingGroupFieldIds` = { [fieldGroupId]: fieldId } z JUZ zastosowanych
// wczesniej (w POPRZEDNIM apply-requeście tego samego joba) grup (hardening
// sekcja 14 - "trwale grouping miedzy osobnymi apply requestami": bez tego
// kazdy osobny POST /auto-configure/apply zaczynal grupowanie od zera i
// tworzyl NOWE pole nawet dla czlonka grupy juz majacej pole z poprzedniego
// requesta). Zwracana `groupFieldIds` ma byc zapisana przez wywolujacego
// (server.js) z powrotem do stanu joba i przekazana przy KOLEJNYM apply.
function applyAutoConfiguration(draft, analysis, {
  suggestionIds, applyHighConfidence, mappingMemory, candidates,
  existingGroupFieldIds, schemaFingerprint,
} = {}) {
  const suggestionsById = new Map((analysis.candidateSuggestions || []).map((s) => [s.candidateId, s]));
  const candidatesById = new Map((candidates || []).map((c) => [c.id, c]));

  const targets = applyHighConfidence
    ? (analysis.candidateSuggestions || []).filter((s) => s.tier === 'auto')
    : (Array.isArray(suggestionIds) ? suggestionIds : []).map((id) => suggestionsById.get(id)).filter(Boolean);

  let nextDraft = draft;
  const appliedSuggestionIds = [];
  const appliedOrigins = {}; // candidateId -> 'auto' | 'reviewAccepted'
  const skipped = [];
  const fieldIdByGroupKey = new Map(Object.entries(existingGroupFieldIds || {}));

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
      if (fieldId && nextDraft.fields[fieldId]) {
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
          mappingMemory.recordAccepted(contextKey, null, suggestion.bestColumn, schemaFingerprint, normalizeValue(candidate.text));
        }
      }
    } else {
      skipped.push({ suggestionId: candidateId, reason: 'unknown-kind' });
      continue;
    }

    appliedOrigins[candidateId] = suggestion.tier === 'auto' ? 'auto' : 'reviewAccepted';
    appliedSuggestionIds.push(candidateId);
  }

  return {
    draft: nextDraft,
    appliedCount: appliedSuggestionIds.length,
    appliedSuggestionIds,
    appliedOrigins,
    skipped,
    groupFieldIds: Object.fromEntries(fieldIdByGroupKey.entries()),
  };
}

module.exports = { applyAutoConfiguration };
