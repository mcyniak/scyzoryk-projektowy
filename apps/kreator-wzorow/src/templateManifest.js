// Sklada manifest Smart Template (schemat opisany w lib/smartTemplateRules.js)
// z "draftu" konfiguracji - stanu, ktory uzytkownik buduje krok po kroku w UI
// Kreatora (KROK 2: kazdy znaleziony kandydat dostaje decyzje STALE/Z
// EXCELA/WARIANT/WARUNEK/DO PROJEKTANTA). Draft jest prostszy niz finalny
// manifest (grupuje po kandydatach, pozwala "Uzyj istniejacego pola"), a ta
// funkcja tlumaczy go na dokladnie ten format, ktory
// lib/smartTemplateRules.js#validateManifest rozumie i ktory PowerShell
// (build-template.ps1) faktycznie wstawia do dokumentu.
//
// Draft (przechowywany per-job w jobStore.js):
// {
//   templateName, preferredSheet, addressColumn,
//   candidates: { [candidateId]: { status, constantText, fieldId, blockId } },
//   fields:  { [fieldId]:  { label, required, emptyPolicy, unknownPolicy, valueSpec, mergeFieldName } },
//   blocks:  { [blockId]:  { label, condition, variantGroupId, bookmarkName } },
//   variantGroups: { [groupId]: { label, policy } }
// }
//
// "constant" (STALE) NIGDY nie trafia do fields/manifestu - to jest jedyny typ
// bez zadnej reguly runtime (sekcja 8.A specyfikacji: "nie dodawaj
// MERGEFIELD, nie dodawaj reguly runtime"), build-template.ps1 dostaje go
// bezposrednio z draftu (tekst do wstawienia albo "zostaw jak jest").
'use strict';

const crypto = require('crypto');

const CANDIDATE_STATUSES = new Set(['unresolved', 'constant', 'field', 'block', 'manual', 'photoGallery']);

// Nazwa MERGEFIELD, ktorej apps/dokumenty-seryjne juz szuka po nazwie (po
// normalizacji spacji/podkreslen), zeby wstawic galerie zdjec dopasowanych po
// adresie - patrz Replace-PhotoGalleryMergeField w
// apps/dokumenty-seryjne/scripts/mailmerge-to-pdf.ps1. MUSI byc identyczna z
// PhotoGalleryMergeFieldName w tools/Scyzoryk.DocumentEngine/Commands/BuildTemplateCommand.cs.
const PHOTO_GALLERY_MERGE_FIELD_NAME = 'Zdjecia_pomontazowe';

function generateMergeFieldName() {
  return `SCY_F_${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}

function generateBookmarkName() {
  return `SCYB_${crypto.randomBytes(7).toString('hex').toUpperCase()}`;
}

function emptyDraft({ templateName = '', preferredSheet = '', addressColumn = '' } = {}) {
  return {
    templateName,
    preferredSheet,
    addressColumn,
    candidates: {},
    fields: {},
    blocks: {},
    variantGroups: {}
  };
}

// KROK 2 zaczyna sie z lista kandydatow ze skanu (patrz src/candidateConfig.js) -
// kazdy dostaje wpis w draft.candidates ze statusem "unresolved", zeby UI
// mialo od razu komplet do wyswietlenia bez osobnego kroku inicjalizacji.
function seedCandidates(draft, candidateIds) {
  const next = { ...draft, candidates: { ...draft.candidates } };
  for (const id of candidateIds) {
    if (!next.candidates[id]) next.candidates[id] = { status: 'unresolved', constantText: null, fieldId: null, blockId: null };
  }
  return next;
}

function setCandidateConstant(draft, candidateId, constantText) {
  return {
    ...draft,
    candidates: {
      ...draft.candidates,
      [candidateId]: { status: 'constant', constantText: constantText == null ? null : String(constantText), fieldId: null, blockId: null }
    }
  };
}

function setCandidateManual(draft, candidateId, label) {
  return {
    ...draft,
    candidates: {
      ...draft.candidates,
      [candidateId]: { status: 'manual', constantText: null, fieldId: null, blockId: null, label: label || null }
    }
  };
}

// "Zdjęcia" (galeria) - wstawia w tym miejscu DOKŁADNIE ten sam MERGEFIELD,
// którego apps/dokumenty-seryjne już rozpoznaje i wypełnia zdjęciami z folderu
// dopasowanego po adresie (patrz PHOTO_GALLERY_MERGE_FIELD_NAME wyżej). Jak
// "constant" - NIE trafia do fields/manifestu, bo nie ma żadnej wartości ani
// reguły runtime do policzenia: dokumenty-seryjne samo znajduje pole po
// nazwie, niezależnie od manifestu Smart Template.
function setCandidatePhotoGallery(draft, candidateId) {
  return {
    ...draft,
    candidates: {
      ...draft.candidates,
      [candidateId]: { status: 'photoGallery', constantText: null, fieldId: null, blockId: null }
    }
  };
}

// Tworzy NOWE logiczne pole (Z Excela / Wariant) i przypisuje do niego dany
// kandydat. `fieldDef` = { label, required, emptyPolicy, unknownPolicy, valueSpec }.
// Zwraca { draft, fieldId } - wywolujacy (server.js) potrzebuje fieldId np. do
// pokazania w UI listy "uzyj istniejacego pola".
function createFieldForCandidate(draft, candidateId, fieldDef) {
  const fieldId = `fld_${crypto.randomBytes(6).toString('hex')}`;
  const mergeFieldName = generateMergeFieldName();
  const next = {
    ...draft,
    fields: { ...draft.fields, [fieldId]: { ...fieldDef, mergeFieldName } },
    candidates: { ...draft.candidates, [candidateId]: { status: 'field', constantText: null, fieldId, blockId: null } }
  };
  return { draft: next, fieldId };
}

// "Uzyj istniejacego pola" (sekcja 23 specyfikacji) - DRUGI (trzeci, ...)
// kandydat wskazuje na JUZ istniejace fieldId, bez tworzenia nowej definicji.
// To jest realizacja "jedno logiczne pole moze byc uzyte w wielu miejscach".
function assignCandidateToExistingField(draft, candidateId, fieldId) {
  if (!draft.fields[fieldId]) throw new Error(`Nie istnieje pole o id "${fieldId}".`);
  return {
    ...draft,
    candidates: { ...draft.candidates, [candidateId]: { status: 'field', constantText: null, fieldId, blockId: null } }
  };
}

// Tworzy NOWY smart blok (WARUNEK/BLOK) i przypisuje dany kandydat jako jego
// zakres. `blockDef` = { label, condition, variantGroupId }.
function createBlockForCandidate(draft, candidateId, blockDef) {
  const blockId = `blk_${crypto.randomBytes(6).toString('hex')}`;
  const bookmarkName = generateBookmarkName();
  const next = {
    ...draft,
    blocks: { ...draft.blocks, [blockId]: { ...blockDef, bookmarkName } },
    candidates: { ...draft.candidates, [candidateId]: { status: 'block', constantText: null, fieldId: null, blockId } }
  };
  return { draft: next, blockId };
}

// "Polacz w jeden blok" (sekcja 21/23) - kilka SASIEDNICH kandydatow ma
// dzielic JEDEN wspolny zakres/bookmark. Model: wszystkie polaczone
// kandydaty dostaja TEN SAM blockId - build-template.ps1/scan-template.ps1
// operuja na candidate.scopeHints (start/end), wiec laczenie zakresow
// (min(start)..max(end)) jest obowiazkiem build-template.ps1 w momencie
// tworzenia bookmarka, nie tego modulu (ktory tylko trzyma DECYZJE, nie
// geometrie dokumentu).
function mergeCandidatesIntoBlock(draft, candidateIds, blockDef) {
  if (!Array.isArray(candidateIds) || candidateIds.length < 2) {
    throw new Error('Polaczenie w blok wymaga co najmniej dwoch kandydatow.');
  }
  const blockId = `blk_${crypto.randomBytes(6).toString('hex')}`;
  const bookmarkName = generateBookmarkName();
  const nextCandidates = { ...draft.candidates };
  for (const id of candidateIds) {
    nextCandidates[id] = { status: 'block', constantText: null, fieldId: null, blockId };
  }
  return {
    ...draft,
    blocks: { ...draft.blocks, [blockId]: { ...blockDef, bookmarkName } },
    candidates: nextCandidates
  };
}

function createVariantGroup(draft, label, policy) {
  const groupId = `vg_${crypto.randomBytes(6).toString('hex')}`;
  return {
    draft: { ...draft, variantGroups: { ...draft.variantGroups, [groupId]: { label, policy } } },
    groupId
  };
}

// Zwraca liste kandydatow, ktorzy JESZCZE nie maja jawnej decyzji - UI (KROK 2)
// pokazuje ich licznik ("Pozostalo: N") i filtr "Nierozwiazane". Nieznaleziony
// wpis (np. kandydat dodany PO ostatnim seedCandidates) tez liczy sie jako
// nierozwiazany.
function unresolvedCandidateIds(draft, allCandidateIds) {
  return allCandidateIds.filter(id => {
    const c = draft.candidates[id];
    return !c || c.status === 'unresolved';
  });
}

// Cofa POJEDYNCZEGO kandydata do stanu "unresolved" (hardening sekcja 26,
// "Cofnij auto apply") - uzywana WYLACZNIE dla kandydatow o origin==='auto'
// (server.js filtruje, ktorych id wywolac tutaj; ten helper nie wie nic o
// origin, tylko cofa jeden konkretny wpis). Celowo NIE usuwa definicji pola/
// bloku, do ktorego kandydat byl przypisany (fields[fieldId]/blocks[blockId]
// zostaja w drafcie nietkniete) - jesli inny kandydat tej samej grupy nadal
// go uzywa, usuniecie definicji by go zepsulo; jesli byl to jedyny czlonek,
// nieuzywana definicja pola po prostu nie trafi do manifestu przy buildzie
// (buildManifestFromDraft emituje `fields`/`placements` tylko dla kandydatow
// faktycznie majacych status 'field' w draft.candidates).
function unresolveCandidate(draft, candidateId) {
  return {
    ...draft,
    candidates: { ...draft.candidates, [candidateId]: { status: 'unresolved', constantText: null, fieldId: null, blockId: null } }
  };
}

// Skleja finalny manifest (schemat lib/smartTemplateRules.js) z draftu +
// listy kandydatow ze skanu (potrzebna do placements: candidateId -> fieldId,
// oraz do zbudowania manualRegions z zachowaniem oryginalnego oznaczenia).
// NIE woła validateManifest() samo - wywolujacy (server.js /api/jobs/:id/validate
// i /build) robi to jawnie, zeby bledy walidacji byly raportowane oddzielnie
// od samego sklejania struktury.
function buildManifestFromDraft(draft, candidates) {
  const fields = Object.entries(draft.fields).map(([id, def]) => ({
    id,
    label: def.label,
    mergeFieldName: def.mergeFieldName,
    required: Boolean(def.required),
    emptyPolicy: def.emptyPolicy || 'error',
    unknownPolicy: def.unknownPolicy || 'error',
    valueSpec: def.valueSpec
  }));

  const blocks = Object.entries(draft.blocks).map(([id, def]) => ({
    id,
    label: def.label,
    bookmarkName: def.bookmarkName,
    condition: def.condition,
    variantGroupId: def.variantGroupId || undefined
  }));

  const variantGroups = Object.entries(draft.variantGroups).map(([id, def]) => ({
    id,
    label: def.label,
    policy: def.policy
  }));

  const placements = [];
  const manualRegions = [];
  for (const candidate of candidates) {
    const decision = draft.candidates[candidate.id];
    if (!decision) continue;
    if (decision.status === 'field' && decision.fieldId) {
      placements.push({ candidateId: candidate.id, fieldId: decision.fieldId });
    } else if (decision.status === 'manual') {
      manualRegions.push({ candidateId: candidate.id, label: decision.label || null, preserveOriginalMarking: true });
    }
    // "constant" i "block" nie potrzebuja wpisu w placements/manualRegions -
    // constant jest realizowany bezposrednio przez build-template.ps1 z
    // draftu (patrz komentarz na gorze pliku), block przez sam
    // candidate.id -> blockId w draft.candidates (uzywane przez
    // build-template.ps1 przy tworzeniu bookmarka, nie przez runtime).
    // "photoGallery" tez nie potrzebuje wpisu tutaj - jak "constant", nie ma
    // zadnej wartosci/reguly runtime (patrz komentarz przy
    // setCandidatePhotoGallery i PHOTO_GALLERY_MERGE_FIELD_NAME).
  }

  return {
    schemaVersion: 1,
    templateId: crypto.randomUUID(),
    templateName: draft.templateName,
    createdAt: new Date().toISOString(),
    createdBy: 'kreator-wzorow',
    preferredSheet: draft.preferredSheet || undefined,
    addressColumn: draft.addressColumn,
    fields,
    placements,
    blocks,
    variantGroups,
    manualRegions
  };
}

module.exports = {
  CANDIDATE_STATUSES,
  PHOTO_GALLERY_MERGE_FIELD_NAME,
  generateMergeFieldName,
  generateBookmarkName,
  emptyDraft,
  seedCandidates,
  setCandidateConstant,
  setCandidateManual,
  setCandidatePhotoGallery,
  createFieldForCandidate,
  assignCandidateToExistingField,
  createBlockForCandidate,
  mergeCandidatesIntoBlock,
  createVariantGroup,
  unresolvedCandidateIds,
  unresolveCandidate,
  buildManifestFromDraft
};
