const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const templateScan = require("./templateScan");
const folderGen = require("./folderGeneration");

// Rejestruje endpointy dla trybu "folder wzorow -> foldery per adres".
// Zyje w osobnym pliku, zeby nie ryzykowac zmian w juz dzialajacym
// server.js - dostaje z niego wszystko czego potrzebuje jako "deps".
function registerFolderRoutes(app, deps) {
  const {
    multer, storage, MAX_FILE_MB, heavyJobLimiter, jobs, OUTPUT_DIR, ROOT, PS_SCRIPT, SCAN_SCRIPT,
    wordQueue, decodeOriginalName, validateOfficeFile, loadExcelWorkbook, parseWorkbook,
    getWorkbookSheet, getJob, persistJobsIndex, setProgress, nowIso, writeJsonFileNoBom, stripBom
  } = deps;

  const folderUpload = multer({
    storage,
    limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 300 },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(decodeOriginalName(file.originalname || "")).toLowerCase();
      if (file.fieldname === "folderTemplates" && (ext === ".docx" || ext === ".pdf")) return cb(null, true);
      if (file.fieldname === "excel" && ext === ".xlsx") return cb(null, true);
      return cb(new Error("Nieobslugiwany typ pliku w folderze wzorow (dozwolone: .docx, .pdf, .xlsx)."));
    }
  });

  app.post("/api/folder-upload", heavyJobLimiter, folderUpload.fields([{ name: "folderTemplates", maxCount: 300 }, { name: "excel", maxCount: 1 }]), async (req, res) => {
    try {
      const templateFiles = req.files?.folderTemplates || [];
      const excel = req.files?.excel?.[0];
      if (!templateFiles.length || !excel) return res.status(400).json({ ok: false, message: "Dodaj folder z wzorami (DOCX/PDF) i plik Excel." });
      validateOfficeFile(excel, [".xlsx"]);

      let relPaths = [];
      try { relPaths = JSON.parse(req.body.templatePaths || "[]"); } catch (_) { relPaths = []; }

      const items = templateFiles.map((f, i) => {
        const rel = relPaths[i] || decodeOriginalName(f.originalname);
        const parts = String(rel).split(/[\\/]/).filter(Boolean);
        const name = parts[parts.length - 1] || decodeOriginalName(f.originalname);
        const subfolder = parts.length > 2 ? parts[parts.length - 2] : null;
        return { path: f.path, originalName: decodeOriginalName(name), ext: path.extname(name).toLowerCase(), subfolder };
      }).filter(it => it.ext === ".docx" || it.ext === ".pdf");

      const templateGroups = templateScan.classifyTemplates(items);

      const sheetNames = (await loadExcelWorkbook(excel.path)).worksheets.map(sheet => sheet.name);
      const workbook = await parseWorkbook(excel.path, sheetNames[0]);
      const jobId = crypto.randomUUID();
      const outDir = path.join(OUTPUT_DIR, jobId);
      await fsp.mkdir(outDir, { recursive: true });

      const job = {
        id: jobId, createdAt: Date.now(), touchedAt: Date.now(), startedAt: null, endedAt: null,
        templateGroups, excel: { path: excel.path, originalName: decodeOriginalName(excel.originalname) },
        template: null,
        workbook, outputDir: outDir,
        logPath: path.join(outDir, "log.txt"), debugJsonPath: path.join(outDir, "debug-events.jsonl"),
        status: "uploaded",
        progress: { phase: "uploaded", current: 0, total: workbook.totalRows, percent: 0, message: "Pliki wczytane.", updatedAt: nowIso() },
        logs: [], result: null, child: null
      };
      jobs.set(jobId, job);
      persistJobsIndex();

      const guessedColumns = folderGen.guessColumns(workbook.columns || []);
      res.json({
        ok: true, jobId, workbook,
        templateGroups: templateGroups.map(g => ({ name: g.name, recognized: g.recognized, hasVariants: g.hasVariants, variantsCount: g.entries.length })),
        guessedColumns
      });
    } catch (err) {
      res.status(400).json({ ok: false, message: err.message || "Nie udalo sie wczytac folderu wzorow." });
    }
  });

  app.get("/api/folder-sheet/:jobId/:sheetName", (req, res) => {
    const job = getJob(req.params.jobId);
    if (!job) return res.status(404).json({ ok: false, message: "Nie znaleziono zadania." });
    const sheetName = req.params.sheetName;
    const sheet = getWorkbookSheet(job.workbook, sheetName);
    if (!sheet || sheet.sheetName !== sheetName) return res.status(404).json({ ok: false, message: "Nie znaleziono arkusza." });
    res.json({ ok: true, workbook: { ...sheet, sheetNames: job.workbook.sheetNames }, guessedColumns: folderGen.guessColumns(sheet.columns || []) });
  });

  // Skanuje wgrane szablony .docx w poszukiwaniu tekstu podswietlonego na
  // zolto (prawdziwe szablony uzywaja tego jako wizualnego oznaczenia miejsc
  // do wypelnienia, zamiast pol MERGEFIELD albo znacznikow {{...}}) i zwraca
  // krotkie kandydatury do zmapowania na kolumne Excela. Dlugie fragmenty
  // (akapity do recznej edycji przez projektanta, tabela materialowa) sa
  // odfiltrowane po stronie skryptu PowerShell.
  app.get("/api/folder-placeholders/:jobId", async (req, res) => {
    const job = getJob(req.params.jobId);
    if (!job) return res.status(404).json({ ok: false, message: "Nie znaleziono zadania." });
    try {
      const docxPaths = [...new Set((job.templateGroups || []).flatMap(g => g.entries).filter(e => e.ext === ".docx").map(e => e.path))];
      if (!docxPaths.length) return res.json({ ok: true, placeholders: [] });

      const listPath = path.join(job.outputDir, "placeholder-scan-input.json");
      writeJsonFileNoBom(listPath, docxPaths);

      const exe = process.env.POWERSHELL_EXE || "powershell.exe";
      const psArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCAN_SCRIPT, "-TemplatesJson", listPath];
      const result = await new Promise(resolveScan => {
        const child = spawn(exe, psArgs, { cwd: ROOT, windowsHide: true });
        let out = "", err = "";
        child.stdout.on("data", d => { out += d.toString("utf8"); });
        child.stderr.on("data", d => { err += d.toString("utf8"); });
        child.on("error", e => resolveScan({ ok: false, message: e.message }));
        child.on("close", () => {
          try { fs.unlinkSync(listPath); } catch (_) {}
          try { resolveScan(JSON.parse(stripBom(out).trim())); }
          catch (_) { resolveScan({ ok: false, message: err || "Brak wyniku skanowania szablonow." }); }
        });
      });

      if (!result.ok) return res.status(500).json({ ok: false, message: result.message || "Nie udalo sie przeskanowac szablonow." });
      res.json({ ok: true, placeholders: result.placeholders || [] });
    } catch (err) {
      res.status(500).json({ ok: false, message: err.message || "Blad skanowania szablonow." });
    }
  });

  async function runOneTemplate(job, templatePath, outputDir, sheetName, addressColumn, filePrefix, recordNumber, visibleWord, replacementJsonPath) {
    const dataJsonPath = path.join(job.outputDir, `merge-data-${recordNumber}-${Date.now()}.json`);
    const debugJsonPath = job.debugJsonPath;
    const row = (getWorkbookSheet(job.workbook, sheetName).rows || []).find(r => Number(r._record) === recordNumber);
    writeJsonFileNoBom(dataJsonPath, { sheetName, addressColumn, records: row ? [row] : [] });

    const args = [
      "-TemplatePath", templatePath,
      "-ExcelPath", job.excel.path,
      "-OutputDir", outputDir,
      "-SheetName", sheetName,
      "-AddressColumn", addressColumn,
      "-DataJson", dataJsonPath,
      "-LogPath", job.logPath,
      "-DebugJsonPath", debugJsonPath,
      "-ReplacementJson", replacementJsonPath,
      "-FilePrefix", filePrefix,
      "-RowsCsv", String(recordNumber)
    ];
    const exe = process.env.POWERSHELL_EXE || "powershell.exe";
    const psArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PS_SCRIPT, ...args];

    return new Promise(resolveOne => {
      const child = spawn(exe, psArgs, { cwd: ROOT, windowsHide: !visibleWord, env: { ...process.env } });
      let buffer = "", final = null, stderr = "";
      child.stdout.on("data", d => {
        buffer += d.toString("utf8");
        const parts = buffer.split(/\r?\n/); buffer = parts.pop() || "";
        for (const raw of parts) {
          const line = stripBom(raw).trim();
          if (line.startsWith("{") && line.endsWith("}")) {
            try { const parsed = JSON.parse(line); if (parsed && Object.prototype.hasOwnProperty.call(parsed, "ok")) final = parsed; } catch (_) {}
          }
        }
      });
      child.stderr.on("data", d => { stderr += d.toString("utf8"); });
      child.on("error", err => resolveOne({ ok: false, message: err.message }));
      child.on("close", () => {
        try { fs.unlinkSync(dataJsonPath); } catch (_) {}
        resolveOne(final || { ok: false, message: stderr || "Brak wyniku z PowerShell." });
      });
    });
  }

  async function runFolderPlan(job, plan, options) {
    const created = [];
    const errors = [];
    const visibleWord = options.visibleWord === true;
    const addressColumn = String(options.adresColumn || "").trim() || "_record";
    let doneCount = 0;

    // Reguly zamiany sa wspolne dla calego zadania (nie per-szablon), wiec
    // plik z niimi piszemy raz, przed petla, zamiast za kazdym wywolaniem
    // PowerShell osobno.
    const replacementJsonPath = path.join(job.outputDir, "replacement-rules.json");
    const rules = Array.isArray(options.rules)
      ? options.rules
          .map(r => ({ find: String(r?.find || "").trim(), column: String(r?.column || "").trim() }))
          .filter(r => r.find && r.column)
      : [];
    writeJsonFileNoBom(replacementJsonPath, { rules });

    job.status = "running";
    job.startedAt = Date.now();

    for (const item of plan) {
      const clientDir = path.join(job.outputDir, item.folderName);
      await fsp.mkdir(clientDir, { recursive: true });

      for (const w of item.warnings) errors.push({ file: item.folderName, message: w });

      for (const task of item.copyTasks) {
        try {
          const destName = path.basename(task.entry.originalName);
          fs.copyFileSync(task.entry.path, path.join(clientDir, destName));
          created.push({ folder: item.folderName, file: destName });
        } catch (err) {
          errors.push({ file: item.folderName + "/" + task.entry.originalName, message: err.message });
        }
      }

      for (const task of item.generateTasks) {
        setProgress(job, { phase: "records", current: doneCount, total: plan.length, percent: Math.round((doneCount / plan.length) * 100), message: `Generuję: ${item.folderName} / ${task.groupName}` });
        try {
          const result = await runOneTemplate(job, task.entry.path, clientDir, job.workbook.sheetName, addressColumn, task.groupName, item.row._record, visibleWord, replacementJsonPath);
          if (result.ok && result.created && result.created.length) {
            created.push({ folder: item.folderName, file: result.created[0].file });
          } else {
            errors.push({ file: item.folderName + "/" + task.groupName, message: result.message || "Nie udalo sie wygenerowac." });
          }
        } catch (err) {
          errors.push({ file: item.folderName + "/" + task.groupName, message: err.message });
        }
      }
      doneCount++;
    }

    job.result = { ok: created.length > 0, created, errors, message: `Utworzono ${created.length} plik(ów) w ${plan.length} folder(ach) klientow. Błędów: ${errors.length}.` };
    job.status = created.length > 0 ? "done" : "error";
    job.endedAt = Date.now();
    setProgress(job, { phase: job.status, percent: 100, message: job.result.message });
    persistJobsIndex();
    return job.result;
  }

  app.post("/api/folder-generate/:jobId", heavyJobLimiter, async (req, res) => {
    const job = getJob(req.params.jobId);
    if (!job) return res.status(404).json({ ok: false, message: "Nie znaleziono zadania." });
    if (process.platform !== "win32") return res.status(400).json({ ok: false, message: "Generowanie dziala tylko na Windows z zainstalowanym Wordem." });
    if (job.status === "running" || job.status === "queued") return res.status(409).json({ ok: false, message: "Zadanie juz trwa.", queue: wordQueue.getState() });

    try {
      const body = req.body || {};
      const sheetName = String(body.sheetName || job.workbook.sheetName || "").trim() || job.workbook.sheetName;
      const selectedSheet = getWorkbookSheet(job.workbook, sheetName);
      const selectedRowRecords = Array.isArray(body.selectedRows) ? body.selectedRows.map(Number).filter(n => Number.isInteger(n) && n > 0) : [];
      const selectedGroups = Array.isArray(body.selectedGroups) ? body.selectedGroups.filter(Boolean) : [];
      if (!selectedGroups.length) return res.status(400).json({ ok: false, message: "Zaznacz przynajmniej jeden typ dokumentu." });

      const columns = { numer: String(body.numerColumn || "").trim(), adres: String(body.adresColumn || "").trim(), gmina: String(body.gminaColumn || "").trim() };
      const variantColumn = String(body.variantColumn || "").trim();
      const rules = Array.isArray(body.rules) ? body.rules : [];

      const allRows = selectedSheet.rows || [];
      const rows = selectedRowRecords.length ? allRows.filter(r => selectedRowRecords.includes(Number(r._record))) : allRows;
      if (!rows.length) return res.status(400).json({ ok: false, message: "Nie wybrano żadnych rekordów." });

      const plan = folderGen.buildGenerationPlan(rows, job.templateGroups, selectedGroups, columns, variantColumn);

      job.status = "queued";
      persistJobsIndex();
      setProgress(job, { phase: "queued", current: 0, total: plan.length, percent: 0, message: "Zadanie czeka w kolejce Word.", queue: wordQueue.getState() });

      wordQueue.run(() => runFolderPlan(job, plan, { visibleWord: body.visibleWord === true, adresColumn: columns.adres, rules })).catch(err => {
        job.status = "error";
        job.result = { ok: false, message: err.message || "Nie udalo sie uruchomic generowania.", created: [], errors: [] };
        persistJobsIndex();
        setProgress(job, { phase: "error", percent: 100, message: job.result.message });
      });

      res.status(202).json({ ok: true, jobId: job.id, status: job.status, planSize: plan.length, queue: wordQueue.getState() });
    } catch (err) {
      res.status(500).json({ ok: false, message: err.message || "Blad." });
    }
  });

  app.get("/api/folder-job/:jobId", (req, res) => {
    const job = getJob(req.params.jobId);
    if (!job) return res.status(404).json({ ok: false, message: "Nie znaleziono zadania." });
    res.json({
      ok: true, jobId: job.id, status: job.status, progress: job.progress, result: job.result,
      templateGroups: (job.templateGroups || []).map(g => ({ name: g.name, recognized: g.recognized, hasVariants: g.hasVariants, variantsCount: g.entries.length }))
    });
  });

  // ZIP zawierajacy TYLKO foldery klientow (pomija robocze pliki jak log.txt,
  // merge-data*.json itp., ktore leza bezposrednio w outputDir).
  app.get("/api/folder-download/:jobId/zip", (req, res) => {
    try {
      const job = getJob(req.params.jobId);
      if (!job || !fs.existsSync(job.outputDir)) return res.status(404).send("Nie znaleziono wynikow.");
      if (typeof deps.archiver !== "function") return res.status(500).send("Modul ZIP niedostepny.");
      const clientDirs = fs.readdirSync(job.outputDir, { withFileTypes: true }).filter(e => e.isDirectory());
      if (!clientDirs.length) return res.status(404).send("Brak gotowych folderow do pobrania.");
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", deps.contentDispositionHeader ? deps.contentDispositionHeader("attachment", `dokumenty-${job.id}.zip`) : `attachment; filename="dokumenty-${job.id}.zip"`);
      const archive = deps.archiver("zip", { zlib: { level: 9 } });
      archive.on("error", err => { if (!res.headersSent) res.status(500).send("Nie udalo sie przygotowac ZIP."); else res.destroy(err); });
      archive.pipe(res);
      for (const dir of clientDirs) archive.directory(path.join(job.outputDir, dir.name), dir.name);
      archive.finalize();
    } catch (err) {
      if (!res.headersSent) res.status(500).send("Nie udalo sie przygotowac ZIP.");
    }
  });
}

module.exports = { registerFolderRoutes };
