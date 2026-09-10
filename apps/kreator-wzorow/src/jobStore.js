// Stan zadan Kreatora - trzymany w pamieci (Map), ale zapisywany do
// data/jobs.json PO KAZDEJ zmianie, zeby przypadkowy restart apki (crash,
// aktualizacja Scyzoryka) nie gubil po cichu calej konfiguracji wzoru w
// trakcie budowania (sekcja 16 specyfikacji). Ten sam wzorzec co
// apps/dokumenty-seryjne/server.js#persistJobsIndex/restoreJobsIndex,
// wydzielony tu do osobnego modulu (w dokumenty-seryjne zyje inline w
// server.js - Kreator ma go jako osobny plik, bo spec tego jawnie wymaga).
//
// UWAGA dot. danych osobowych: zapisywany stan NIE zawiera pelnej zawartosci
// Excela (samego pliku, ani tabeli rekordow) - tylko sciezki do
// przesłanych/tymczasowych plikow, liste kolumn, paleta oznaczen, kandydaci
// (tekst + pozycja w dokumencie, bez danych z Excela) i draft konfiguracji
// (nazwy kolumn/reguly, bez wartosci rekordow) - zgodnie z sekcja 5
// specyfikacji ("manifest ma przechowywac tylko nazwy kolumn, reguly,
// konfiguracje wzoru").
'use strict';

const fs = require('fs');
const path = require('path');

const INTERRUPTIBLE_STATUSES = new Set([
  'markings_scanning', 'scanning', 'validating', 'preview_queued', 'previewing', 'build_queued', 'building'
]);

function nowIso() {
  return new Date().toISOString();
}

function createJobStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const indexPath = path.join(dataDir, 'jobs.json');
  const jobs = new Map();

  function persist() {
    try {
      const items = Array.from(jobs.values()).map(job => ({ ...job, child: undefined }));
      const tmp = `${indexPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ savedAt: nowIso(), jobs: items }, null, 0), 'utf8');
      fs.renameSync(tmp, indexPath);
    } catch (err) {
      console.error('[kreator-jobs-index]', err && err.message || err);
    }
  }

  function restore() {
    try {
      if (!fs.existsSync(indexPath)) return;
      const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      for (const item of raw.jobs || []) {
        if (!item || !item.id) continue;
        const interrupted = INTERRUPTIBLE_STATUSES.has(item.status);
        jobs.set(item.id, {
          ...item,
          status: interrupted ? 'interrupted' : item.status,
          interruptedReason: interrupted ? 'process-restarted' : item.interruptedReason || null,
          child: null
        });
      }
    } catch (err) {
      console.error('[kreator-jobs-restore]', err && err.message || err);
    }
  }

  function createJob(id, initial) {
    const job = {
      id,
      createdAt: Date.now(),
      touchedAt: Date.now(),
      status: 'uploaded',
      ...initial
    };
    jobs.set(id, job);
    persist();
    return job;
  }

  function getJob(id) {
    const job = jobs.get(id);
    if (!job) return null;
    job.touchedAt = Date.now();
    return job;
  }

  // Plytkie scalenie (Object.assign) - wywolujacy odpowiada za to, zeby
  // zagniezdzone struktury (draft/candidates/manifest) nadpisywac calymi
  // nowymi obiektami, nie mutowac w miejscu (ten sam nawyk co
  // lib/smartTemplateRules.js - unikamy przypadkowych aliasow do starego
  // stanu miedzy wersjami joba).
  function updateJob(id, patch) {
    const job = jobs.get(id);
    if (!job) return null;
    Object.assign(job, patch, { touchedAt: Date.now() });
    persist();
    return job;
  }

  function deleteJob(id) {
    const existed = jobs.delete(id);
    if (existed) persist();
    return existed;
  }

  function listJobs() {
    return Array.from(jobs.values());
  }

  // TTL sprzatanie - wywolujacy (server.js) dostarcza funkcje faktycznie
  // kasujaca pliki na dysku (rozne katalogi per job: uploads/output/tmp),
  // ten modul tylko decyduje KTORE joby sa juz za stare i usuwa je ze stanu.
  function pruneOlderThan(maxAgeMs, onPrune) {
    const now = Date.now();
    for (const [id, job] of jobs) {
      if (now - job.createdAt <= maxAgeMs) continue;
      if (typeof onPrune === 'function') {
        try { onPrune(job); } catch (err) { console.error('[kreator-jobs-prune]', err && err.message || err); }
      }
      jobs.delete(id);
    }
    persist();
  }

  restore();

  return { createJob, getJob, updateJob, deleteJob, listJobs, persist, pruneOlderThan };
}

module.exports = { createJobStore, INTERRUPTIBLE_STATUSES };
