# Stack techniczny

- Node.js >=18, CommonJS (nie ESM), Express 4. Brak TypeScript mimo że Serena
  wykrywa "typescript" jako język projektu (błędna klasyfikacja — kod jest .js).
- Brak frontendowego frameworka/buildera — front to statyczny HTML + `<script>`
  ładowany wprost z `public/` per moduł (czasem plik nazwany `inline-1.js`).
- Windows-only funkcje (nie zadziałają na Linuksie/macOS):
  - drukowanie: PowerShell + SumatraPDF.exe (portable, w `scripts/`) z fallbackiem
    do Adobe Acrobat DC (`/t` przez linię komend), fallback do zwykłego "otwórz
    i drukuj" (`-Verb Print`) dla plików nie-PDF.
  - korespondencja seryjna / wnioski powykonawcze: prawdziwa automatyzacja
    Microsoft Word przez COM (`New-Object -ComObject Word.Application`)
    wywoływana z PowerShell. Wymaga zainstalowanego Worda.
  - `apps/formularze-ecodan`: Playwright steruje prawdziwą przeglądarką przeciw
    zewnętrznemu portalowi.
- Kluczowe zależności per-moduł (nie w root): `express-rate-limit`, `multer`,
  `xlsx`/`read-excel-file` (czytanie Excela), `mammoth` (DOCX→tekst),
  `pdf-parse`, `pdf-lib` (łączenie/analiza PDF), `sanitize-filename`, `archiver`
  (ZIP), `playwright` (tylko Ecodan).
- Testowanie logiki poza Windows (np. przeze mnie w sandboxie): most Node→Python
  (`pdfplumber`, `python-docx`) zamiast prawdziwych `pdf-parse`/`mammoth`, żeby
  czytać realną treść PDF/DOCX bez dostępu do npm registry.
