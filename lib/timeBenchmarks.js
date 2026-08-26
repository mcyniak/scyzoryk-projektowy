const BENCHMARKS = Object.freeze({
  'formularze-ecodan': Object.freeze({
    unit: 'report',
    manualMsPerItem: 92_000,
    enabled: true
  }),
  'dokumenty-seryjne': Object.freeze({
    unit: 'generated-file',
    manualMsPerItem: 30_000,
    enabled: true
  }),
  'wnioski-powykonawcze': Object.freeze({
    unit: 'request',
    manualMsPerItem: 78_000,
    enabled: true
  }),
  'karty-katalogowe': Object.freeze({
    unit: 'address',
    manualMsPerItem: 11_100,
    enabled: false,
    note: 'Benchmark zachowany, ale naliczanie wylaczone do czasu naprawy narzedzia.'
  }),
  'drukarka-projekty': Object.freeze({
    unit: 'project-address-two-copies',
    variants: Object.freeze({
      stamps: 727_000,
      noStamps: 572_000
    }),
    enabled: true
  }),
  'nazywarka-skanow': Object.freeze({
    unit: 'file',
    manualMsPerItem: 11_000,
    enabled: true
  }),
  'formularze-varmero': Object.freeze({
    unit: 'submission',
    manualMsPerItem: 71_000,
    enabled: true
  }),
  'tworzenie-folderow': Object.freeze({
    unit: 'unique-address',
    manualMsPerItem: 15_000,
    enabled: true
  })
});

function normalizeItemCount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.min(Math.floor(numeric), 100_000);
}

function estimateManualMs(tool, itemCount, variant = null) {
  const benchmark = BENCHMARKS[String(tool || '')];
  if (!benchmark || benchmark.enabled !== true) return null;

  const count = normalizeItemCount(itemCount);
  if (count === 0) return 0;

  let perItem = benchmark.manualMsPerItem;
  if (benchmark.variants) {
    perItem = benchmark.variants[variant];
  }

  if (!Number.isFinite(perItem) || perItem < 0) return null;
  return Math.round(perItem * count);
}

function estimateSavedMs(tool, itemCount, durationMs, variant = null) {
  const manualMs = estimateManualMs(tool, itemCount, variant);
  if (manualMs == null) return null;

  const actual = Number(durationMs);
  if (!Number.isFinite(actual) || actual < 0) return null;
  return Math.max(0, Math.round(manualMs - actual));
}

module.exports = {
  BENCHMARKS,
  normalizeItemCount,
  estimateManualMs,
  estimateSavedMs
};
