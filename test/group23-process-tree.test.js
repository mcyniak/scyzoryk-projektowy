const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCimProcessRows, sumProcessTreeBytes } = require('../lib/processTree');

// Audyt zuzycia RAM 2026-08-21: panel liczyl tylko RAM wlasnego procesu -
// /api/apps teraz laczy `Get-CimInstance Win32_Process` (PID/PPID/WorkingSet
// wszystkich procesow) z lista PID-ow dzieci Scyzoryka, zeby zsumowac KAZDA
// apke WRAZ Z JEJ POTOMKAMI (np. Chromium spod Playwrighta w
// formularze-ecodan/formularze-varmero jest wnukiem/prawnukiem procesu
// apki, nie bezposrednim dzieckiem panelu). Ta logika jest czysta (bez I/O),
// wydzielona do lib/processTree.js wlasnie zeby dalo sie ja przetestowac bez
// prawdziwego PowerShell/WMI.

test('parseCimProcessRows: buduje mape PID -> {ppid, workingSetBytes} z surowego JSON-a Get-CimInstance', () => {
  const raw = JSON.stringify([
    { ProcessId: 100, ParentProcessId: 1, WorkingSetSize: 70000000 },
    { ProcessId: 200, ParentProcessId: 100, WorkingSetSize: 90000000 }
  ]);
  const byPid = parseCimProcessRows(raw);
  assert.equal(byPid.size, 2);
  assert.deepEqual(byPid.get(100), { ppid: 1, workingSetBytes: 70000000 });
  assert.deepEqual(byPid.get(200), { ppid: 100, workingSetBytes: 90000000 });
});

test('parseCimProcessRows: PowerShell ConvertTo-Json zwraca goly obiekt (nie tablice) dla dokladnie jednego procesu - nadal dziala', () => {
  const raw = JSON.stringify({ ProcessId: 42, ParentProcessId: 1, WorkingSetSize: 12345 });
  const byPid = parseCimProcessRows(raw);
  assert.equal(byPid.size, 1);
  assert.deepEqual(byPid.get(42), { ppid: 1, workingSetBytes: 12345 });
});

test('parseCimProcessRows: pusty/uszkodzony JSON daje pusta mape, nigdy nie rzuca', () => {
  assert.equal(parseCimProcessRows('').size, 0);
  assert.equal(parseCimProcessRows(undefined).size, 0);
  assert.equal(parseCimProcessRows('to nie jest JSON').size, 0);
});

test('sumProcessTreeBytes: sumuje apke WRAZ Z CALYM jej poddrzewem (np. wnuki - Chromium pod Playwrightem)', () => {
  // Drzewo: panel(1) -> ecodanNode(50, 60MB) -> chromiumBrowser(51, 40MB) -> chromiumRenderer(52, 90MB)
  //         panel(1) -> niepowiazanyProces(99, 500MB) - NIE powinien wejsc do sumy dla ecodana
  const byPid = new Map([
    [1, { ppid: 0, workingSetBytes: 65000000 }],
    [50, { ppid: 1, workingSetBytes: 60000000 }],
    [51, { ppid: 50, workingSetBytes: 40000000 }],
    [52, { ppid: 51, workingSetBytes: 90000000 }],
    [99, { ppid: 1, workingSetBytes: 500000000 }]
  ]);
  assert.equal(sumProcessTreeBytes(byPid, 50), 60000000 + 40000000 + 90000000, 'suma apki ecodan musi objac wnuka (Chromium renderer), ale nie inny, niepowiazany proces');
});

test('sumProcessTreeBytes: zwraca null gdy PID w ogole nie istnieje w drzewie (apka juz nie zyje / WMI go nie zlapalo)', () => {
  const byPid = new Map([[1, { ppid: 0, workingSetBytes: 1000 }]]);
  assert.equal(sumProcessTreeBytes(byPid, 12345), null);
});

test('sumProcessTreeBytes: nie wpada w nieskonczona petle, gdy dane maja cykl (nigdy sie nie powinno zdarzyc, ale bezpiecznik)', () => {
  const byPid = new Map([
    [1, { ppid: 2, workingSetBytes: 10 }],
    [2, { ppid: 1, workingSetBytes: 20 }]
  ]);
  assert.equal(sumProcessTreeBytes(byPid, 1), 30);
});
