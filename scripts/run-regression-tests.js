const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const tests = [
  ['--test',
    'test/group1-hardening.test.js',
    'test/group1-supervisor.test.js',
    'test/group2-printing.test.js',
    'test/group3-ocr.test.js',
    'test/group4-ecodan.test.js',
    'test/group5-dokumenty-seryjne.test.js',
    'test/group6-workflows.test.js',
    'test/group7-data-paths.test.js'
  ],
  ['apps/drukarka-projekty/test-sorting-regression.js']
];

for (const args of tests) {
  const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log('Wszystkie testy regresji przeszly.');
