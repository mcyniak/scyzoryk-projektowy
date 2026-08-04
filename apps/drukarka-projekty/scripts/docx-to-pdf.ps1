# Konwertuje liste plikow DOCX do PDF przez Word COM - uzywane WYLACZNIE
# przez tryb "Drukuj jako dokumentacje powykonawcza" (strona tytulowa/opis
# techniczny sa zwykle .docx, ale trzeba je ostemplowac przez pdf-lib jak
# resztę pakietu, co wymaga najpierw PDF-a).
#
# Jedna sesja Worda dla WSZYSTKICH plikow w wywolaniu (nie jedna na plik) -
# start Worda to dominujacy koszt czasowy calej operacji, wiec amortyzujemy
# go na caly pakiet do wydruku, dokladnie tak jak juz robi
# apps/wnioski-powykonawcze/scripts/convert-wm.ps1.
#
# Wywolanie: -InputJson (plik z {"files":[{"inputPath":"...","outputPath":"..."}]})
#            -OutputJson (plik wynikowy {"ok":true,"results":[{"ok":true,"input":...,"output":...}]})

param(
  [Parameter(Mandatory=$true)][string]$InputJson,
  [Parameter(Mandatory=$true)][string]$OutputJson
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}

function Write-Result {
  param($obj)
  $json = $obj | ConvertTo-Json -Depth 10
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($OutputJson, $json, $utf8NoBom)
}

function Get-ErrorMessage {
  param($err)
  try { if ($err -and $err.Exception -and $err.Exception.Message) { return [string]$err.Exception.Message } } catch {}
  return "Blad PowerShell."
}

try {
  $rawConfig = Get-Content -LiteralPath $InputJson -Raw -Encoding UTF8
  if ($null -eq $rawConfig) { throw "Nie udalo sie odczytac konfiguracji wejscia." }
  $config = $rawConfig.TrimStart([char]0xFEFF) | ConvertFrom-Json
  $results = New-Object System.Collections.Generic.List[object]
  $word = $null
  $oldSecurity = $null

  try {
    $word = New-Object -ComObject Word.Application
    if ($null -eq $word) { throw "Nie udalo sie uruchomic Microsoft Word." }
    $word.Visible = $false
    $word.DisplayAlerts = 0
    try { $oldSecurity = $word.AutomationSecurity; $word.AutomationSecurity = 3 } catch {}
    try { $word.Options.UpdateLinksAtOpen = $false } catch {}
    try { $word.Options.ConfirmConversions = $false } catch {}

    foreach ($item in $config.files) {
      $doc = $null
      try {
        $inputPath = [string]$item.inputPath
        $outputPath = [string]$item.outputPath
        if (-not (Test-Path -LiteralPath $inputPath)) { throw "Nie znaleziono pliku DOCX: $inputPath" }

        $doc = $word.Documents.Open($inputPath, $false, $true, $false, "", "", $false, "", "", 0, 65001, $false, $true)
        if ($null -eq $doc) { throw "Word nie otworzyl pliku: $inputPath" }

        $formatPdf = 17 # wdFormatPDF
        $doc.SaveAs2($outputPath, $formatPdf)
        $doc.Close($false)
        $doc = $null
        $results.Add([pscustomobject]@{ ok=$true; input=$inputPath; output=$outputPath }) | Out-Null
      } catch {
        if ($null -ne $doc) { try { $doc.Close($false) } catch {} }
        $results.Add([pscustomobject]@{ ok=$false; input=[string]$item.inputPath; error=(Get-ErrorMessage $_) }) | Out-Null
      }
    }
  } finally {
    if ($null -ne $word) {
      if ($null -ne $oldSecurity) { try { $word.AutomationSecurity = $oldSecurity } catch {} }
      try { $word.Quit() } catch {}
      try { [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($word) } catch {}
    }
    try { [GC]::Collect(); [GC]::WaitForPendingFinalizers() } catch {}
  }

  Write-Result ([pscustomobject]@{ ok=$true; results=$results })
} catch {
  Write-Result ([pscustomobject]@{ ok=$false; error=(Get-ErrorMessage $_) })
  exit 1
}
