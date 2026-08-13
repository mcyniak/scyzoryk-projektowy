# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Note: comments and console output in this codebase are in Polish. Match that when editing existing files.

## What this is

"Scyzoryk Projektowy" is a local-only (127.0.0.1) Windows toolbox for automating office/document work
(PDF generation from Word/Excel, PDF stamping, print queuing, Ecodan report generation, etc). It is a
Node.js **process supervisor + panel**, not a monolith: `server.js` at the repo root spawns one child
`node server.js` process per tool in `apps/*`, each on its own port, and proxies nothing — the panel just
links to each child's own port.

## Commands

Run from the repo root (PowerShell). There is no build step and no automated test suite (JS = CommonJS or
ESM per-app, no bundler, no jest/mocha).

- `npm start` / `node server.js` — start the panel (port 3000) and all child apps. On startup it
  auto-detects missing `node_modules` in each `apps/*` and runs the installer for you (skip with
  `SCYZORYK_SKIP_AUTO_INSTALL=1`).
- `npm run install-all` / `node scripts/install-all.js` — install dependencies for every app under
  `apps/*` (uses `npm ci` when a clean lockfile exists, else `npm install`; always forces the public npm
  registry, since some machines have a broken internal registry configured). Also installs the Playwright
  Chromium browser for `formularze-ecodan`.
- `npm run check` / `node scripts/check-project.js` — the closest thing to a lint/test step: walks the
  whole repo (skipping `node_modules`, `uploads`, `output`, `tmp`, `data`, `logs`, `bin`, `obj`) and runs `node --check`
  on every `.js` file and a PowerShell parser check on every `.ps1` file. Run this after editing any JS or
  PS1 file.
- `npm run security-smoke` / `node scripts/security-smoke-test.js` — smoke-tests a **running** instance:
  hits each child app's health endpoint and verifies that a mutating POST without the
  `X-Scyzoryk-Request` header is rejected with 403. Requires `node server.js` already running.
- `STARTUJ-SCYZORYK.cmd` — the normal "just run it" entry point for end users: kills stray `node.exe`,
  installs deps, runs the check, starts the server.
- `NAPRAW-ZALEZNOSCI.cmd` — nuclear dependency reset: deletes `node_modules` and `package-lock.json` in
  every app and reinstalls from scratch. Only reach for this when dependency state is actually broken.
- Per-app: each `apps/<name>` is an independent npm package with its own `package.json`/`start` script
  (`node apps/<name>/server.js`) and its own `node_modules`. `formularze-ecodan` additionally has
  `node src/doctor.js` (diagnostics: checks deps, Chromium install, write access to `output`/`uploads`).
  `drukarka-projekty` has `npm test` (`node test-sorting-regression.js`) — a regression suite (plain
  Node `assert`, no framework) pinning the exact output of `src/folderMatch.js`'s document
  classification/ordering against a frozen real-world fixture (`test/fixtures/kolektory-zarnow-41/`,
  filenames only, no client document content). This is the single most business-critical piece of logic
  in the repo (deterministic print/merge order for a project's documents) — run this after touching
  `folderMatch.js` and update the pinned expectations deliberately, not accidentally, if behavior changes.
- Single-file syntax check while iterating: `node --check <file>.js` (this is literally what
  `check-project.js` automates across the whole tree).

## Architecture

### Root supervisor (`server.js`)

- Defines the `apps` registry: slug, display name, directory, port, and a `healthPath` used for liveness
  checks. Ports are configurable via env vars (`DRUKARKA_PORT`, `PIECZATKI_PORT`, `FORMULARZE_PORT`,
  `SERYJNE_PORT`, `WNIOSKI_PORT`, `KARTY_PORT`, `DRUKARKA_PROJEKTY_PORT`, `OCR_AUDYTOW_PORT`), default
  `PORT=3000` for the panel itself.
- Spawns each app as a child process (`spawn(process.execPath, ['server.js'], { cwd: app.dir, ... })`),
  captures stdout/stderr into prefixed log lines, and auto-restarts crashed children with backoff
  (capped at 30s), tracking restart/failure counts per app.
- Serves the static panel (`public/index.html`) and admin page (`public/admin.html`), plus JSON endpoints
  `/api/apps` (aggregated health/status of every child) and `/api/admin/logs` (tail of
  `logs/children.jsonl`). It does **not** proxy requests to child apps — the browser talks to each child
  app's own port directly.
- All child apps are added to the root's `dependencyChecks` list so the auto-installer knows which deps
  each one needs; when adding a new app under `apps/`, register it in both the `apps` array and
  `dependencyChecks` array (and mirror it in `scripts/install-all.js`).

### Child apps (`apps/<name>/`)

Each is a standalone Express app with its own `server.js`, `public/`, and (for the more complex ones)
`src/` for logic split out of the route handlers. Current apps:

- `drukarka` — print queue manager (uploads → prints via SumatraPDF/Ghostscript in order).
- `drukarka-projekty` — same idea but driven by an investment/project Excel sheet (`src/excelInvestment.js`,
  `src/folderMatch.js`, `src/printEngine.js`).
- `pieczatki-pdf` — stamps PDFs with a positioned watermark/stamp image (uses `pdf-lib` + `pdfjs-dist` for
  preview).
- `formularze-ecodan` — the most complex app: drives a real Chromium browser via **Playwright** to fill an
  external web form from Excel data, in batches. Logic lives in `src/` (`jobs.js` orchestrates job/batch
  state, `src/automation/{session,steps,product}.js` drive the browser, `excel.js`/`rules.js` parse and
  validate input, `telemetry.js`/`debug.js` for diagnostics). ESM (`"type": "module"` in its
  `package.json`), unlike the other apps which are CommonJS.
- `dokumenty-seryjne` — Word+Excel mail-merge: produces one PDF per address/row via Word COM automation
  in `scripts/mailmerge-to-pdf.ps1`. **Has two parallel, largely-duplicate UI code paths — only one is
  reachable.** `public/index.html` + `public/inline-1.js` (calling `/api/upload`, `/api/generate/:jobId`,
  `/api/placeholders/:jobId` in `server.js`) is served at `/` and is the one users actually reach.
  `public/folder.html` + `public/folder.js` (calling `/api/folder-upload`, `/api/folder-generate/:jobId`
  in `src/folderRoutes.js`) is **not linked from anywhere** — dead code. When debugging this app, check
  `inline-1.js` first; don't assume `folder.js` reflects current behavior.
  - Real templates fill placeholders via **table-cell position**, not text search: `mailmerge-to-pdf.ps1`'s
    `Fill-HighlightedTableCells` reads the yellow-highlighted table cell's value and looks at the
    **previous cell in the same row** as the field label (e.g. `"Uczestnik projektu:"` → next cell is
    the name). This label vocabulary is consistent across investments/document types (verified against
    real data from 4 investments × 3 doc types) — see `$script:LabelFieldCandidates` in the script for
    the label→Excel-column mapping. This runs automatically for every generated document; no user
    configuration needed. Do NOT use `Table.Rows`/`.Cells` for this kind of table walk — if the table
    has any vertically-merged cell anywhere, Word COM throws for *every* row, not just the merged one;
    use `Table.Range.Cells` (flat, reading-order) instead. Also: apply detected fills in a separate pass
    sorted by position descending, never mutate cell text while still iterating the table.
  - Polish "ł" doesn't decompose under Unicode NFD the way ą/ę/ć/ń/ś/ź/ż do, so the shared `Normalize-Name`
    PS helper turns "Działka" into `dzia_ka`, not `dzialka` — any new ASCII label/column candidate
    containing "ł" needs both spellings considered.
- `wnioski-powykonawcze` — converts DOCX "wniosek materiałowy" files into "dokumentacja powykonawcza" PDFs.
- `karty-katalogowe` — matches a UID column in an Excel sheet to product spec-sheet files and copies them
  into per-client folders.
- `ocr-audytow` — OCR for scanned audit PDFs (incl. Polish handwriting): outputs a PDF with an invisible,
  selectable/searchable text layer, splitting multi-address bundled files into one PDF per address after
  a user-reviewed confirmation screen (never auto-splits silently). Uses **Google Cloud Document AI**
  (a Form Parser processor, `src/documentAiEngine.js`) for text recognition — requires 4 env vars:
  `OCR_DOCAI_KEY_FILE` (path to a GCP service-account JSON key — never commit this file, reference it
  only via the env var), `OCR_DOCAI_PROJECT_ID`, `OCR_DOCAI_LOCATION` (e.g. `eu`), `OCR_DOCAI_PROCESSOR_ID`.
  This replaced an earlier Google Cloud Vision version (2026-07-22; `src/visionEngine.js` was kept as a
  rollback reference for a while but was fully unused by 2026-07-24 — deleted, retrievable from git
  history if ever needed) after real-file testing showed Document AI recognizes
  checkboxes as their own structured entity type (auto-paired with their label) instead of Vision's raw
  Unicode glyph requiring manual geometric matching — eliminates a whole class of field-matching bugs, at
  ~20x the cost ($30 vs $1.50/1000 pages). Document AI returns word/formField/table/visualElement
  coordinates already in its own internally-corrected ("logical") frame, not the raw physical-image frame
  Vision used. **No automatic page-rotation detection/correction** — this was deliberately removed
  2026-07-24 (was ~40% of total pipeline time on a real 20-page file, ~54s of ~134s, from physically
  re-rotating each page image via Jimp) after the owner judged it not worth the cost: a physically
  upside-down/sideways scan is trivial for a person to fix before upload, so the tool no longer tries to
  guess/correct it — pages must be uploaded already right-side-up, or field previews/manual marks on that
  page will be wrong. Since Document AI has no built-in "searchable PDF" output mode, the invisible
  text layer is assembled by hand via `pdf-lib` + `@pdf-lib/fontkit` (`src/ocrPipeline.js`'s `buildOcrPdf`
  — needs a Unicode-capable font for Polish diacritics, read live from `C:\Windows\Fonts\arial.ttf`, same
  pattern as `pieczatki-pdf`, not vendored in the repo). A single page's Document AI call has a 90s timeout
  (`OCR_PAGE_TIMEOUT_MS` in `ocrPipeline.js`) — without it, one network-stuck page among a batch processed
  concurrently would hang the entire file's analysis forever, since the client library has no timeout of
  its own. This is also the only child app in the repo that makes outbound network calls — every other
  app is deliberately offline/`127.0.0.1`-only end-to-end.

Each app's `data/`, `logs/`, `uploads/`, `output/`, `tmp/` directories are runtime state (uploads, job
data, generated output), not source — they're excluded from `scripts/check-project.js` and should not be
treated as reference material.

### Security posture (applies uniformly, replicate when adding an app)

Every app's `server.js` independently sets up the same pattern near the top of the file — when adding a
new app, copy this rather than inventing a new one:

- A fixed `SECURITY_HEADERS` object (CSP, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, locked-down `Permissions-Policy`) applied to every response.
- A same-origin-only mutation guard: any non-`GET`/`HEAD`/`OPTIONS` request must carry
  `X-Scyzoryk-Request: 1` or gets a 403. Front-end JS (`public/*.js`) must set this header on every
  fetch that isn't a plain GET. `scripts/security-smoke-test.js` asserts this behavior.
- `express-rate-limit` on API routes.
- `multer` disk storage with sanitized filenames (strip accents/diacritics, whitelist
  `[a-zA-Z0-9._-]`, random-prefixed) and MIME/extension allowlists per upload field.
- Everything binds to `127.0.0.1` only (`SCYZORYK_HOST` env var) — this is explicitly a local-only tool,
  not meant to be exposed on the network.

### Shared code

- `lib/hardening.js` — shared root-level utilities required by every child app via a relative path
  (`../../lib/hardening`): `setupProcessDiagnostics` (crash/uncaughtException logging to
  `logs/<app>.jsonl` + Node diagnostic reports), `applyHttpTimeouts`, `runPowerShell` (spawns PowerShell
  with UTF-8 output forced, since Windows PowerShell 5.1's pipe encoding mangles Polish characters),
  `scheduleCleanup`/`cleanupOldFiles` (periodic sweep of upload/output/tmp dirs), `createSerialQueue`,
  JSON-line log helpers. Treat this file as the one place to fix cross-cutting infra behavior.
- `shared-styles/base.css` — intended single source of truth for panel CSS, but per its own README is
  **not yet wired up** to any app; each app currently still has its own inline/`styles.css`. Don't assume
  editing `shared-styles/base.css` affects any running app yet — check `shared-styles/README.md` before
  touching shared styling.
- Printing apps (`drukarka`, `drukarka-projekty`) share printing logic via `lib/printing.js` +
  `lib/printing/print-file.ps1` (+ vendored `SumatraPDF.exe` and `lib/printing/ghostscript/`) —
  consolidated 2026-07-15 from two bit-identical per-app copies that had already started drifting
  (virtual-printer filter regex, which process names got closed after a batch). Each app passes its own
  `logDir` (`apps/<name>/data`) into `printFileWindows()` so `print-log.txt` stays per-app despite the
  shared script. After sending the file, `print-file.ps1` polls the printer's own job queue
  (`Get-PrintJob`) for up to 20s to confirm a new job actually appeared before reporting success — no
  fire-and-forget confirmation.
  - Engine order: SumatraPDF (`-print-to`) first, **Ghostscript** (`mswinpr2` device, GDI printing) as the
    only fallback — replaced Adobe Acrobat 2026-08-13 (Acrobat couldn't legally ship inside the
    installer; a machine without it installed simply couldn't print). Some WSD/network printers
    (confirmed: Brother, Lexmark) have Sumatra's `-exit-when-done` hang indefinitely without ever
    exiting, even after it has already handed the job to the spooler — `print-file.ps1` no longer
    force-kills on a bare timeout (that truncated an in-flight WSD transfer once, losing a page — audit
    2026-08-12); it tracks the job's own `PagesPrinted` in the queue (`Wait-ForPrintJobProgress`, shared
    by both engines) and only kills+falls back once a job has genuinely stalled with no progress, never
    while it's still advancing. Ghostscript needs `-dNoCancel` to suppress `mswinpr2`'s own built-in
    progress/cancel dialog (documented in its `Devices.rst`, not a Scyzoryk-side window hack like the
    old Acrobat hide-loop was) — runs with `SAFER` left at its (gs 9.50+) default and only
    `--permit-devices=mswinpr2` granted, deliberately never `-dNOSAFER`, since this interprets
    user-uploaded PDF content.

### Native launcher (`launcher/Scyzoryk.Launcher`, installed as `Scyzoryk.exe`)

- C#/.NET 8, self-contained single-file, no console (`OutputType=WinExe`) — the **only** normal way to
  start the installed app: desktop/Start Menu shortcuts, post-install "run now", autostart (Scheduled
  Task), and the updater's post-update restart all invoke `{app}\Scyzoryk.exe` directly. It replaced a
  chain of `Uruchom-Scyzoryk.cmd` → `is-panel-alive.ps1`/`stop-scyzoryk.ps1` → `cscript run-hidden.vbs` →
  `STARTUJ-SCYZORYK-CICHO.cmd` → `node server.js` → `wait-and-open-panel.ps1`, which was flagged as
  looking like a malware dropper to AV heuristics. Does **not** replace the panel UI (still the browser)
  and does **not** remove the installer's own unsigned-EXE SmartScreen warning (separate, unaddressed
  topic — no code signing implemented).
- 5 CLI modes only: no args (ensure server running, open browser once), `--autostart` (ensure running,
  never open browser, used by the Scheduled Task and by `--apply-update` post-update), `--stop` (kill
  only this install's own `node-runtime\node.exe`, used by `[UninstallRun]` and `--apply-update`),
  `--health` (single `/api/health` check, never starts anything), `--apply-update <installerPath>
  <expectedVersion>` (stop → run installer silently → restart → verify the new version actually
  answers `/api/health` → write `Updates\last-result.json` — `UpdateApplier.cs`, ported 2026-08-05 from
  the deleted `scripts/run-update.ps1`; see below for why). Single-instance coordination is a named
  `Local\...` Mutex derived from a hash of the install path (`InstallPaths.cs`) — guards only the
  "start the server" step, never held while opening the browser or during `--apply-update`.
- The updater (`lib/updateService.js`) spawns a **copy of the already-installed `Scyzoryk.exe`** with
  `--apply-update`, never PowerShell — this replaced a `powershell.exe -ExecutionPolicy Bypass
  -WindowStyle Hidden -File run-update.ps1` chain after it was caught for real (2026-08-05, owner's
  corporate laptop) being silently killed by the company's EDR: 0 bytes of stdout/stderr ever captured,
  the process never showed up in `Get-Process`, and *nothing* logged locally (Defender operational log,
  Protection History, AppLocker — all empty) — a textbook "hidden interpreter spawns another hidden
  interpreter which runs an unsigned installer" dropper heuristic. Manually double-clicking the same
  installer in the foreground never triggered it — confirming the shape of the process tree was the
  trigger, not the installer file itself. `Scyzoryk.exe --apply-update` removes the interpreter hop
  entirely (no window to begin with, since it's `OutputType=WinExe`); no guarantee it dodges every EDR,
  but it matches how Chrome/VS Code/Slack self-update. `InstallPaths.UpdateRoot`/`DataRoot` mirror
  `server.js`'s `resolveUpdateRoot()`/`lib/appPaths.js`'s `getDataRoot()` exactly, including the same
  `SCYZORYK_UPDATE_ROOT`/`SCYZORYK_DATA_ROOT` override env vars (also used to isolate
  `UpdateApplierTests.cs` from the real `%LOCALAPPDATA%`).
- User-visible address is `http://scyzoryk.localhost:3000` (`InstallPaths.PanelUrl`, always this fixed
  label regardless of `SCYZORYK_HOST`) — `.localhost` is a reserved TLD (RFC 6761): every modern browser
  and Windows itself resolve any `*.localhost` name straight to loopback, with no hosts-file entry, no
  DNS, and no admin rights. This replaced an earlier `scyzoryk.projektowy` hosts-file entry
  (2026-08-05) — that approach needed `scripts/install-autostart.ps1` to self-elevate via UAC once, just
  to write `%WINDIR%\System32\drivers\etc\hosts`; `.localhost` needs none of that, so the elevation code
  was deleted outright, not just disabled. The launcher's own internal health probe (`InstallPaths.HealthUrl`)
  deliberately stays on `Host` (`127.0.0.1` by default) instead of the `.localhost` label — a plain IP is
  more reliable for a same-process loopback check than depending on name resolution. Do not reintroduce
  hosts-file editing or a custom TLD here without a real reason — `.localhost` was chosen specifically to
  avoid both HTTPS/certificate complexity (tried and reverted the same day — self-signed certs trusted via
  `CurrentUser\Root`, even through `certutil.exe -addstore -f`, still popped a native Windows "security
  warning" dialog on this dev machine, breaking the "zero manual steps" goal) and hosts-file/UAC complexity.
- Built by `scripts/build-launcher.ps1` (checks .NET SDK 8, runs the launcher's own xUnit tests, `dotnet
  publish`), called from `scripts/build-installer.ps1` before staging — treat "build the launcher" and
  "stage it into the installer" as separate steps if you touch this, so a future Authenticode-signing
  step can slot in between without restructuring either script. `dotnet`/`.NET SDK 8` was not available
  in the sandbox this was originally built in — CI (`actions/setup-dotnet@v4` in all 3 installer
  workflows) is the first real `dotnet build`/`dotnet test`/`dotnet publish` of this project; verify there
  before trusting it compiles.

## Practical notes

- Requires a portable Node.js install and a local Microsoft Word install (Windows-only tool; PowerShell
  scripts and `.cmd` launchers are first-class, not incidental).
- `.npmrc` forces `registry=https://registry.npmjs.org/` — some target machines have a broken/internal
  registry configured globally, so don't remove this.
- Don't leave manual `*.bak-przed-*` backup files or stray runtime artifacts (`server.pid`,
  `server_*.log`) checked into app directories — there's no git here, so these accumulate as dead
  weight instead of being reversible via history. Delete them when found; nothing in the codebase reads
  them (`check-project.js` only picks up files ending in exactly `.js`/`.ps1`).
