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
    # Audyt v1.1.7: PID-y PRZED utworzeniem obiektu COM, zeby po starcie
    # jednoznacznie wskazac WLASNIE NOWY proces (nie jakis inny, juz otwarty
    # recznie przez uzytkownika Word) - patrz obnizenie priorytetu nizej.
    $priorWinwordPids = @(Get-CimInstance Win32_Process -Filter "Name='WINWORD.EXE'" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessId)
    $word = New-Object -ComObject Word.Application
    if ($null -eq $word) { throw "Nie udalo sie uruchomic Microsoft Word." }
    $word.Visible = $false
    $word.DisplayAlerts = 0

    # Obnizamy priorytet PROCESU WINWORD.EXE (nie calego skryptu - COM
    # aktywowany serwer Worda NIE dziedziczy priorytetu z PowerShella) do
    # BelowNormal, zeby konwersja wielu plikow z rzedu nie "dusila" reszty
    # komputera uzytkownika (zgloszone realnie). Brak sukcesu nigdy nie
    # przerywa konwersji - to tylko optymalizacja, nie wymog.
    try {
      Start-Sleep -Milliseconds 300
      $newWinwordPid = Get-CimInstance Win32_Process -Filter "Name='WINWORD.EXE'" -ErrorAction SilentlyContinue |
        Where-Object { $priorWinwordPids -notcontains $_.ProcessId } |
        Select-Object -First 1 -ExpandProperty ProcessId
      if ($newWinwordPid) {
        $winwordProc = Get-Process -Id $newWinwordPid -ErrorAction SilentlyContinue
        if ($null -ne $winwordProc) { $winwordProc.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::BelowNormal }
      }
    } catch {}
    try { $oldSecurity = $word.AutomationSecurity; $word.AutomationSecurity = 3 } catch {}
    try { $word.Options.UpdateLinksAtOpen = $false } catch {}
    try { $word.Options.ConfirmConversions = $false } catch {}

    foreach ($item in $config.files) {
      $doc = $null
      # Audyt v1.1.7 (zlapane realnie na produkcji w analogicznym skrypcie
      # mailmerge-to-pdf.ps1): kilka udokumentowanych HRESULT-ow oznacza
      # PRZEJSCIOWA zajetosc/niedostepnosc serwera COM Worda (Word akurat
      # konczy poprzednia operacje) - pojedynczy odrzucony call potrafi
      # zerwac kanal na tyle, ze KOLEJNE pliki w tej samej petli tez
      # zawodza, zanim kanal sam sie odzyska. Retry z krotkim opoznieniem
      # naprawia to bez realnej straty czasu.
      $maxAttempts = 3
      $attempt = 0
      $itemDone = $false
      while (-not $itemDone -and $attempt -lt $maxAttempts) {
        $attempt++
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
        $itemDone = $true
      } catch {
        if ($null -ne $doc) { try { $doc.Close($false) } catch {}; $doc = $null }
        $errMsg = Get-ErrorMessage $_
        $isTransientComBusy = ($errMsg -match "0x80010001" -or $errMsg -match "0x8001010A" -or $errMsg -match "0x8001010B" -or $errMsg -match "0x800706BA" -or $errMsg -match "0x80080005" -or $errMsg -match "RPC_E_" -or $errMsg -match "null-valued expression")
        if ($isTransientComBusy -and $attempt -lt $maxAttempts) {
          Start-Sleep -Seconds (1.5 * $attempt)
          continue
        }
        $results.Add([pscustomobject]@{ ok=$false; input=[string]$item.inputPath; error=$errMsg }) | Out-Null
        $itemDone = $true
      }
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
