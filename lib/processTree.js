// Audyt zuzycia RAM 2026-08-21: logika budowania drzewa procesow (z surowego
// wyjscia `Get-CimInstance Win32_Process | ConvertTo-Json`) i sumowania
// pamieci calego poddrzewa (apka + jej potomkowie, np. Chromium spod
// Playwrighta w formularze-ecodan/formularze-varmero) jest wydzielona tu,
// jako czysta logika bez I/O, zeby dalo sie ja przetestowac bez realnego
// wywolania PowerShell/WMI (patrz server.js#refreshProcessTree, ktore
// faktycznie odpytuje system i tylko woloa te funkcje).

function parseCimProcessRows(rawStdout) {
  const byPid = new Map();
  let parsed;
  try {
    parsed = JSON.parse(String(rawStdout || '[]').trim() || '[]');
  } catch (_) {
    return byPid;
  }
  if (!Array.isArray(parsed)) parsed = [parsed];
  for (const p of parsed) {
    const pid = Number(p?.ProcessId);
    if (!Number.isFinite(pid)) continue;
    byPid.set(pid, { ppid: Number(p.ParentProcessId) || 0, workingSetBytes: Number(p.WorkingSetSize) || 0 });
  }
  return byPid;
}

// Sumuje WorkingSetSize dla `rootPid` ORAZ wszystkich jego potomkow (dowolnej
// glebokosci) - zwraca null gdy `rootPid` w ogole nie istnieje w `byPid`
// (proces juz nie zyje / zapytanie WMI go nie zlapalo).
function sumProcessTreeBytes(byPid, rootPid) {
  if (!byPid.has(rootPid)) return null;
  let total = 0;
  const stack = [rootPid];
  const seen = new Set();
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const info = byPid.get(pid);
    if (info) total += info.workingSetBytes;
    for (const [candidatePid, candidateInfo] of byPid.entries()) {
      if (candidateInfo.ppid === pid && !seen.has(candidatePid)) stack.push(candidatePid);
    }
  }
  return total;
}

module.exports = { parseCimProcessRows, sumProcessTreeBytes };
