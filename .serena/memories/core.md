# Scyzoryk Projektowy — mapa projektu

Pakiet lokalnych narzędzi Node.js/Express dla biura projektowego (branża sanitarna:
kolektory słoneczne, pompy ciepła, kotły). Działa na jednym komputerze Windows,
uruchamiane przez `node server.js` w katalogu głównym.

## Architektura: supervisor + moduły

Root `server.js` to **supervisor** — spawnuje i pilnuje (health-check + auto-restart)
7 niezależnych aplikacji Express w `apps/*`, każda na osobnym porcie 3001-3006 + 3010.
Panel główny (root) nasłuchuje na porcie 3000 i tylko linkuje do modułów — nie ma
własnej logiki biznesowej.

Pełna lista modułów, portów i ich przeznaczenia: `mem:apps/overview`.

## Invarianty projektowe

- `lib/hardening.js` (root) to WSPÓLNY kod używany przez WSZYSTKIE moduły
  (`require("../../lib/hardening")` z poziomu `apps/<nazwa>/server.js`) —
  bezpieczeństwo (nagłówki, rate-limit), `runPowerShell()`, `scheduleCleanup()`,
  JSON bez BOM. Zmiana tu wpływa na cały system. Nie duplikować per-moduł.
- Każdy moduł ma własny `package.json`/`node_modules` (nie monorepo z workspaces).
  Instalacja: `node scripts/install-all.js` (sprawdza obecność folderów
  `node_modules/<dep>` per moduł — NIE próbuje `require.resolve`, patrz
  `mem:conventions` po co).
- Drukowanie na Windows i integracja z PowerShell/Word COM: `mem:windows_automation`
  — zawiera krytyczne, nieoczywiste pułapki (node --check nie waliduje .ps1,
  kodowanie UTF-8 w potokach PowerShell 5.1).
- Wzorzec izolacji sesji użytkownika (wiele osób naraz, bez logowania) opisany
  w `mem:conventions`.
