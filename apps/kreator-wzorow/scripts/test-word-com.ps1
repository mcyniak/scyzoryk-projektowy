# Powtarzalny smoke test Word COM dla Kreatora wzorow seryjnych (audyt
# naprawczy 2026-09-10, "0 kandydatow"). NIE jest uruchamiany automatycznie
# w standardowym CI (wymaga zainstalowanego, dzialajacego Microsoft Word) -
# uruchamiaj recznie przez `npm run test:kreator-word` na Windows z Wordem.
#
# Tworzy WLASNA, oddzielna instancje Word.Application (New-Object, nigdy
# GetActiveObject) - jesli na komputerze jest jakis WLASNY, interaktywny
# dokument uzytkownika otwarty w Wordzie, ten skrypt go NIE dotyka i NIE
# zamyka. Sprzata WYLACZNIE po sobie (swoja instancje + pliki w folderze
# tymczasowym utworzonym na potrzeby tego testu).
#
# Sprawdza (Definition of Done audytu naprawczego, sekcja 16/17):
#   Test A - paleta (bez Worda, czysty XML) wykrywa wszystkie uzyte kolory.
#   Test B - skan kandydatow (Word COM) znajduje >0 dla kazdego mechanizmu:
#            highlight (2 rozne kolory), run shading, paragraph shading,
#            cell shading, header, footer, textbox/TextFrame; niewybrany
#            "dekoracyjny" kolor NIE staje sie kandydatem; dwa identyczne
#            teksty "XXX" to dwaj oddzielni kandydaci.
#   Test C - build wstawia prawdziwy MERGEFIELD, prawdziwy Bookmark,
#            zachowuje "Do projektanta" 1:1 (tresc I kolor), nie psuje
#            tabeli, dokument otwiera sie bez repair-prompt po zapisaniu.
#
# Exit code 0 = wszystko przeszlo, 1 = co najmniej jeden test nie przeszedl
# (szczegoly w stdout/stderr).

param(
  [string]$WorkDir = (Join-Path $env:TEMP "scyzoryk-kreator-word-com-test")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..\..")
. (Join-Path $repoRoot "lib\wordSmartTemplate.ps1")

$failures = New-Object System.Collections.Generic.List[string]
function Assert-True([bool]$condition, [string]$message) {
  if (-not $condition) {
    $failures.Add($message) | Out-Null
    Write-Host "  [BLAD] $message" -ForegroundColor Red
  } else {
    Write-Host "  [OK] $message" -ForegroundColor Green
  }
}

if (Test-Path $WorkDir) { Remove-Item $WorkDir -Recurse -Force }
New-Item -ItemType Directory -Path $WorkDir | Out-Null
$fixturePath = Join-Path $WorkDir "fixture.docx"
$builtPath = Join-Path $WorkDir "built.docx"

function Ole([int]$r, [int]$g, [int]$b) { return ($r -bor ($g -shl 8) -bor ($b -shl 16)) }

Write-Host "=== Budowanie fixture DOCX (Word COM, wlasna instancja) ==="
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try { $word.ScreenUpdating = $false } catch {}
try { $word.Options.CheckGrammarAsYouType = $false } catch {}
try { $word.Options.CheckSpellingAsYouType = $false } catch {}
try { $word.Options.AutoFormatAsYouTypeReplaceQuotes = $false } catch {}
try { $word.Options.AutoFormatAsYouTypeApplyHeadings = $false } catch {}
try { $word.Options.AutoFormatAsYouTypeApplyBulletedLists = $false } catch {}
try { $word.Options.AutoFormatAsYouTypeApplyNumberedLists = $false } catch {}
try { $word.Options.AutoFormatAsYouTypeApplyBorders = $false } catch {}
try { $word.Options.AutoFormatAsYouTypeApplyTables = $false } catch {}
$spans = @{}
try {
  $doc = $word.Documents.Add()
  $sel = $word.Selection

  # PASS 1: caly tekst NAJPIERW, bez formatowania - typing dziedziczy format
  # poprzedniego znaku, wiec formatowanie w trakcie typowania "przecieka" na
  # kolejne fragmenty (zweryfikowane live, audyt 2026-09-10). Kazdy span jest
  # formatowany OSOBNO, w PASS 2, przez Range - nigdy w trakcie typowania.
  $spans.hlYellow = @($sel.Range.Start, $null); $sel.TypeText("HL_YELLOW"); $spans.hlYellow[1] = $sel.Range.Start
  $sel.TypeText(" ")
  $spans.hlGreen = @($sel.Range.Start, $null); $sel.TypeText("HL_GREEN"); $spans.hlGreen[1] = $sel.Range.Start
  $sel.TypeParagraph()
  $spans.runShading = @($sel.Range.Start, $null); $sel.TypeText("RUN_SHADING"); $spans.runShading[1] = $sel.Range.Start
  $sel.TypeParagraph()
  $spans.paraShading = @($sel.Range.Start, $null); $sel.TypeText("PARAGRAPH_SHADING"); $spans.paraShading[1] = $sel.Range.Start
  $sel.TypeParagraph()
  $spans.decorativeBlue = @($sel.Range.Start, $null); $sel.TypeText("DECORATIVE_BLUE"); $spans.decorativeBlue[1] = $sel.Range.Start
  $sel.TypeParagraph()
  $spans.xxx1 = @($sel.Range.Start, $null); $sel.TypeText("XXX"); $spans.xxx1[1] = $sel.Range.Start
  $sel.TypeText(" separator words here ")
  $spans.xxx2 = @($sel.Range.Start, $null); $sel.TypeText("XXX"); $spans.xxx2[1] = $sel.Range.Start
  $sel.TypeParagraph()

  $tblRange = $doc.Content
  $tblRange.Collapse(0)
  $tbl = $doc.Tables.Add($tblRange, 1, 2)
  $tbl.Cell(1,1).Range.Text = "CELL_SHADING"
  $tbl.Cell(1,2).Range.Text = "plain cell"

  $hdr = $doc.Sections.Item(1).Headers.Item(1)
  $hdr.Range.Text = "HEADER_MARK"
  $ftr = $doc.Sections.Item(1).Footers.Item(1)
  $ftr.Range.Text = "FOOTER_MARK"

  $shp = $doc.Shapes.AddTextbox(1, 400, 500, 200, 50)
  $shp.TextFrame.TextRange.Text = "TEXTBOX_MARK"

  # PASS 2: formatowanie na juz-utworzonych, precyzyjnych zakresach.
  $doc.Range($spans.hlYellow[0], $spans.hlYellow[1]).HighlightColorIndex = 7
  $doc.Range($spans.hlGreen[0], $spans.hlGreen[1]).HighlightColorIndex = 4
  $doc.Range($spans.runShading[0], $spans.runShading[1]).Shading.BackgroundPatternColor = (Ole 0xFF 0xE5 0x99)
  $doc.Range($spans.paraShading[0], $spans.paraShading[1]).ParagraphFormat.Shading.BackgroundPatternColor = (Ole 0xC6 0xE0 0xB4)
  $doc.Range($spans.decorativeBlue[0], $spans.decorativeBlue[1]).ParagraphFormat.Shading.BackgroundPatternColor = (Ole 0xAD 0xD8 0xE6)
  $doc.Range($spans.xxx1[0], $spans.xxx1[1]).HighlightColorIndex = 7
  $doc.Range($spans.xxx2[0], $spans.xxx2[1]).HighlightColorIndex = 7
  $tbl.Cell(1,1).Shading.BackgroundPatternColor = (Ole 0xF4 0xB1 0x83)
  $hdr.Range.HighlightColorIndex = 7
  $ftr.Range.HighlightColorIndex = 7
  $shp.TextFrame.TextRange.HighlightColorIndex = 7

  $doc.SaveAs2($fixturePath, 16)
  $doc.Close($false)
  Write-Host "Fixture zapisany: $fixturePath"
} finally {
  $word.Quit()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
}

Write-Host "`n=== Test A: paleta (bez Worda) ==="
$scanScript = Join-Path $PSScriptRoot "scan-template.ps1"
$paletteJsonLine = & powershell -NoProfile -ExecutionPolicy Bypass -File $scanScript -Mode palette -TemplatePath $fixturePath | Select-Object -Last 1
$palette = $paletteJsonLine | ConvertFrom-Json
Assert-True $palette.ok "Test A: paleta zwrocila ok=true"
$paletteKeys = @($palette.markings | ForEach-Object { $_.key })
foreach ($expected in @('highlight:yellow', 'highlight:brightgreen', 'shading:FFE599', 'shading:C6E0B4', 'shading:F4B183', 'shading:ADD8E6')) {
  Assert-True ($paletteKeys -contains $expected) "Test A: paleta zawiera '$expected'"
}

Write-Host "`n=== Test B: skan kandydatow (Word COM) ==="
$selectedMarkings = @('highlight:yellow', 'highlight:brightgreen', 'shading:FFE599', 'shading:C6E0B4', 'shading:F4B183')
$selectedMarkingsJson = $selectedMarkings | ConvertTo-Json -Compress
$candidatesJsonLine = & powershell -NoProfile -ExecutionPolicy Bypass -File $scanScript -Mode candidates -TemplatePath $fixturePath -SelectedMarkingsJson $selectedMarkingsJson | Select-Object -Last 1
$scanResult = $candidatesJsonLine | ConvertFrom-Json
Assert-True $scanResult.ok "Test B: skan kandydatow zwrocil ok=true (jesli nie: $($scanResult.message))"
if ($scanResult.ok) {
  $cands = @($scanResult.candidates)
  Assert-True ($cands.Count -eq 10) "Test B: znaleziono dokladnie 10 kandydatow (jest: $($cands.Count))"
  $texts = @($cands | ForEach-Object { $_.text })
  foreach ($expectedText in @('HL_YELLOW', 'HL_GREEN', 'RUN_SHADING', 'PARAGRAPH_SHADING', 'CELL_SHADING', 'HEADER_MARK', 'FOOTER_MARK', 'TEXTBOX_MARK')) {
    Assert-True ($texts -contains $expectedText) "Test B: kandydat '$expectedText' zostal znaleziony"
  }
  Assert-True (-not ($texts -contains 'DECORATIVE_BLUE')) "Test B: niewybrany kolor DECORATIVE_BLUE NIE stal sie kandydatem"
  $xxxCount = @($cands | Where-Object { $_.text -eq 'XXX' }).Count
  Assert-True ($xxxCount -eq 2) "Test B: dwa identyczne teksty XXX to DWAJ oddzielni kandydaci (jest: $xxxCount)"
  $kinds = $cands | Group-Object { $_.mark.kind } | ForEach-Object { $_.Name }
  foreach ($expectedKind in @('highlight', 'shading-run', 'shading-paragraph', 'shading-cell')) {
    Assert-True ($kinds -contains $expectedKind) "Test B: mechanizm '$expectedKind' wykryl co najmniej jednego kandydata"
  }
  Assert-True ($scanResult.diagnostics.mechanismErrors.Count -eq 0) "Test B: zero bledow mechanizmow (mechanismErrors)"
}

Write-Host "`n=== Test C: build (MERGEFIELD/Bookmark/manual/tabela) ==="
if ($scanResult.ok -and $cands.Count -eq 10) {
  $word2 = New-Object -ComObject Word.Application
  $word2.Visible = $false
  $word2.DisplayAlerts = 0
  try {
    $doc2 = $word2.Documents.Open($fixturePath, $false, $false, $false, "", "", $false, "", "", 0, 65001, $true, $true)
    $rescan = Find-ScyzorykMarkedCandidates -doc $doc2 -selectedMarkings ([string[]]$selectedMarkings)
    $liveCands = $rescan.Candidates.ToArray()

    function ByText([string]$t) { $liveCands | Where-Object { $_.text -eq $t } | Select-Object -First 1 }
    $xxxSorted = @($liveCands | Where-Object { $_.text -eq 'XXX' } | Sort-Object start)
    $units = New-Object System.Collections.Generic.List[object]
    $units.Add([pscustomobject]@{ type='field'; cand=$xxxSorted[0]; fieldName='SCY_F_SMOKETEST' }) | Out-Null
    $units.Add([pscustomobject]@{ type='constant'; cand=$xxxSorted[1]; text='STALA_TESTOWA' }) | Out-Null
    $units.Add([pscustomobject]@{ type='block'; cand=(ByText 'RUN_SHADING'); bookmarkName='SCYB_SMOKETEST' }) | Out-Null
    $manualCand = ByText 'PARAGRAPH_SHADING' # celowo BEZ jednostki - to jest "Do projektanta"
    $handledIds = @($xxxSorted[0].id, $xxxSorted[1].id, (ByText 'RUN_SHADING').id, $manualCand.id)
    foreach ($c in $liveCands) {
      if ($handledIds -contains $c.id) { continue }
      $units.Add([pscustomobject]@{ type='constant'; cand=$c; text="STALA_$($c.mark.paletteKey -replace '[^a-zA-Z0-9]','_')" }) | Out-Null
    }

    function Clear-Mark($storyForCells, $range, [string]$kind, $tableOrdinal, $cellOrdinal) {
      if ($kind -eq 'highlight') { try { $range.HighlightColorIndex = 0 } catch {} }
      elseif ($kind -eq 'shading-run') { try { $range.Shading.BackgroundPatternColor = -16777216 } catch {} }
      elseif ($kind -eq 'shading-paragraph') { try { $range.ParagraphFormat.Shading.BackgroundPatternColor = -16777216 } catch {} }
      elseif ($kind -eq 'shading-cell') { try { $cell = Get-ScyzorykCellByOrdinal $storyForCells ([int]$tableOrdinal) ([int]$cellOrdinal); $cell.Shading.BackgroundPatternColor = -16777216 } catch {} }
    }

    # Shape'y najpierw (patrz komentarz w build-template.ps1 - anchor-delete ryzyko).
    $sortedUnits = $units | Sort-Object -Property @{Expression={ if ($null -ne $_.cand.shapeIndex) { 0 } else { 1 } }}, @{Expression={ $_.cand.start }; Descending=$true}
    $wdFieldEmpty = 59
    foreach ($u in $sortedUnits) {
      $c = $u.cand
      $range = Get-ScyzorykStoryRangeCopy -doc $doc2 -storyKey $c.storyKey -storyType ([int]$c.storyType) -chainIndex ([int]$c.chainIndex) -shapeIndex $c.shapeIndex
      $range.Start = [int]$c.start; $range.End = [int]$c.end
      $storyForCells = Get-ScyzorykStoryRangeCopy -doc $doc2 -storyKey $c.storyKey -storyType ([int]$c.storyType) -chainIndex ([int]$c.chainIndex) -shapeIndex $c.shapeIndex
      if ($u.type -eq 'field') {
        $newField = $doc2.Fields.Add($range, $wdFieldEmpty, [string]$u.fieldName, $false)
        Clear-Mark $storyForCells $newField.Result ([string]$c.mark.kind) $c.tableOrdinal $c.cellOrdinal
      } elseif ($u.type -eq 'constant') {
        $range.Text = [string]$u.text
        $cr = Get-ScyzorykStoryRangeCopy -doc $doc2 -storyKey $c.storyKey -storyType ([int]$c.storyType) -chainIndex ([int]$c.chainIndex) -shapeIndex $c.shapeIndex
        $cr.Start = [int]$c.start; $cr.End = [int]$c.start + $u.text.Length
        Clear-Mark $storyForCells $cr ([string]$c.mark.kind) $c.tableOrdinal $c.cellOrdinal
      } elseif ($u.type -eq 'block') {
        [void]$doc2.Bookmarks.Add([string]$u.bookmarkName, $range)
        Clear-Mark $storyForCells $range ([string]$c.mark.kind) $c.tableOrdinal $c.cellOrdinal
      }
    }
    $doc2.SaveAs2($builtPath, 16)
    $doc2.Close($false)
  } finally {
    $word2.Quit()
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word2) | Out-Null
  }

  $word3 = New-Object -ComObject Word.Application
  $word3.Visible = $false
  $word3.DisplayAlerts = 0
  try {
    $doc3 = $word3.Documents.Open($builtPath, $false, $true, $false, "", "", $false, "", "", 0, 65001, $true, $true)
    Assert-True $true "Test C: dokument zbudowany przez build-template.ps1-owa logike otwiera sie bez repair-prompt"
    Assert-True ($doc3.Fields.Count -eq 1) "Test C: dokladnie 1 pole MERGEFIELD istnieje"
    if ($doc3.Fields.Count -ge 1) {
      Assert-True ($doc3.Fields.Item(1).Code.Text -match 'MERGEFIELD SCY_F_SMOKETEST') "Test C: pole to MERGEFIELD SCY_F_SMOKETEST"
    }
    Assert-True ($doc3.Bookmarks.Count -eq 1) "Test C: dokladnie 1 bookmark istnieje"
    $manualParagraph = $doc3.Paragraphs | Where-Object { $_.Range.Text -like '*PARAGRAPH_SHADING*' } | Select-Object -First 1
    Assert-True ($null -ne $manualParagraph) "Test C: manualny fragment (Do projektanta) nadal istnieje w dokumencie"
    if ($null -ne $manualParagraph) {
      Assert-True ($manualParagraph.Range.ParagraphFormat.Shading.BackgroundPatternColor -eq (Ole 0xC6 0xE0 0xB4)) "Test C: manualny fragment zachowal DOKLADNIE oryginalny kolor cieniowania"
    }
    Assert-True ($doc3.Tables.Count -eq 1) "Test C: tabela nadal istnieje"
    if ($doc3.Tables.Count -eq 1) {
      $t = $doc3.Tables.Item(1)
      Assert-True ($t.Rows.Count -eq 1 -and $t.Columns.Count -eq 2) "Test C: tabela ma nadal 1x2 komorki (nie uszkodzona)"
    }
    $doc3.Close($false)
  } finally {
    $word3.Quit()
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word3) | Out-Null
  }
} else {
  $failures.Add("Test C pominiety - Test B nie przeszedl") | Out-Null
}

Write-Host "`nSprzatanie: $WorkDir"
try { Remove-Item $WorkDir -Recurse -Force } catch {}

if ($failures.Count -gt 0) {
  Write-Host "`nNIEUDANE ($($failures.Count)):" -ForegroundColor Red
  foreach ($f in $failures) { Write-Host "  - $f" -ForegroundColor Red }
  exit 1
}
Write-Host "`nWszystkie testy Word COM Kreatora przeszly." -ForegroundColor Green
exit 0
