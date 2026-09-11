param(
  [Parameter(Mandatory=$true)][ValidateSet('palette', 'candidates')][string]$Mode,
  [Parameter(Mandatory=$true)][string]$TemplatePath,
  [string]$SelectedMarkingsJson = ""
)

# Dwuetapowe skanowanie (sekcja 3/19-21 specyfikacji Kreatora wzorow
# seryjnych) - kolor sam w sobie NIE ma znaczenia biznesowego, wiec zanim
# cokolwiek uznamy za "pole robocze", pokazujemy uzytkownikowi PALETE
# wszystkich oznaczen realnie uzytych w dokumencie i CZEKAMY na jego wybor:
#
#   -Mode palette    -> inwentaryzacja WSZYSTKICH kolorow/rodzajow oznaczen
#                       (highlight + shading), z przykladami tekstu. Celowo
#                       BEZ Worda/COM - to jest statyczny odczyt XML (ten sam,
#                       udowodniony wzorzec co
#                       apps/dokumenty-seryjne/scripts/scan-placeholders.ps1),
#                       szybszy i bezpieczniejszy niz wlaczanie calego Worda
#                       tylko po to, zeby zliczyc kolory.
#   -Mode candidates -> konkretne fragmenty TYLKO dla kolorow/rodzajow, ktore
#                       uzytkownik jawnie zaznaczyl jako robocze. To WYMAGA
#                       Worda (COM) - patrz Find-ScyzorykMarkedCandidates w
#                       lib/wordSmartTemplate.ps1, wspoldzielona z
#                       build-template.ps1 (ten sam algorytm w obu miejscach,
#                       zeby skan i pozniejszy build zawsze widzialy DOKLADNIE
#                       te same kandydatury w tej samej kolejnosci).

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}
. (Join-Path $PSScriptRoot "..\..\..\lib\wordSmartTemplate.ps1")

function Write-Result($obj) {
  $json = $obj | ConvertTo-Json -Depth 20 -Compress
  Write-Output $json
}

function Get-XmlPartsText([string]$docxPath) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $result = @{}
  $zip = $null
  try {
    $zip = [System.IO.Compression.ZipFile]::OpenRead($docxPath)
    $parts = $zip.Entries | Where-Object { $_.FullName -match '^word/(document|header\d*|footer\d*)\.xml$' }
    foreach ($entry in $parts) {
      $reader = New-Object System.IO.StreamReader($entry.Open())
      $result[$entry.FullName] = $reader.ReadToEnd()
      $reader.Close()
    }
  } finally {
    if ($null -ne $zip) { $zip.Dispose() }
  }
  return $result
}

function Get-NearbyText([string]$xml, [int]$index, [int]$window = 400) {
  # Najblizszy <w:t>...</w:t> W OBIE STRONY od znacznika formatowania - dla
  # highlight/shading znacznik CZESTO poprzedza tekst w tej samej rPr, ale
  # bywa i inaczej (np. w:shd w pPr przed calym akapitem), wiec sprawdzamy
  # okno przed i po.
  $start = [Math]::Max(0, $index - $window)
  $len = [Math]::Min($window * 2, $xml.Length - $start)
  $slice = $xml.Substring($start, $len)
  $matches = [regex]::Matches($slice, '<w:t\b[^>]*>([^<]*)</w:t>')
  if ($matches.Count -eq 0) { return '' }
  # Preferuj dopasowanie PO indeksie znacznika (index - start) - to zwykle
  # tekst, ktorego znacznik faktycznie dotyczy.
  $relIndex = $index - $start
  $after = $matches | Where-Object { $_.Index -ge $relIndex } | Select-Object -First 1
  $chosen = if ($null -ne $after) { $after } else { $matches[$matches.Count - 1] }
  return [System.Net.WebUtility]::HtmlDecode($chosen.Groups[1].Value).Trim()
}

function Get-MarkingPaletteFromXml([string]$docxPath) {
  $parts = Get-XmlPartsText $docxPath
  # key -> { kind, rawValue, displayColor, count, examples: [] }
  $palette = @{}

  foreach ($xml in $parts.Values) {
    foreach ($m in [regex]::Matches($xml, '<w:highlight\b[^>]*w:val="([^"]+)"[^>]*/>')) {
      $ooxmlName = $m.Groups[1].Value
      if ($ooxmlName -ieq 'none') { continue }
      $key = ConvertTo-ScyzorykHighlightKey $ooxmlName
      if ($null -eq $key) { continue }
      $paletteKey = "highlight:$key"
      if (-not $palette.ContainsKey($paletteKey)) {
        $palette[$paletteKey] = [pscustomobject]@{
          key = $paletteKey; kind = 'highlight'; rawValue = $key
          displayColor = $script:ScyzorykHighlightMap[$key].hex
          count = 0; examples = New-Object System.Collections.Generic.List[object]
        }
      }
      $entry = $palette[$paletteKey]
      $entry.count++
      if ($entry.examples.Count -lt 3) {
        $text = Get-NearbyText $xml $m.Index
        if ($text) { $entry.examples.Add([pscustomobject]@{ text = $text }) | Out-Null }
      }
    }

    foreach ($m in [regex]::Matches($xml, '<w:shd\b[^>]*w:fill="([0-9A-Fa-f]{6})"[^>]*/>')) {
      $hex = $m.Groups[1].Value.ToUpperInvariant()
      if ($hex -eq 'FFFFFF' -or $hex -eq 'AUTO') { continue } # biale/brak wypelnienia - nie jest to widoczne oznaczenie
      $paletteKey = "shading:$hex"
      if (-not $palette.ContainsKey($paletteKey)) {
        $palette[$paletteKey] = [pscustomobject]@{
          key = $paletteKey; kind = 'shading'; rawValue = $hex
          displayColor = "#$hex"
          count = 0; examples = New-Object System.Collections.Generic.List[object]
        }
      }
      $entry = $palette[$paletteKey]
      $entry.count++
      if ($entry.examples.Count -lt 3) {
        $text = Get-NearbyText $xml $m.Index
        if ($text) { $entry.examples.Add([pscustomobject]@{ text = $text }) | Out-Null }
      }
    }
  }

  return @($palette.Values | Sort-Object -Property @{ Expression = 'kind' }, @{ Expression = 'count'; Descending = $true })
}

try {
  if (-not (Test-Path -LiteralPath $TemplatePath)) { throw "Nie znaleziono szablonu: $TemplatePath" }

  if ($Mode -eq 'palette') {
    $markings = Get-MarkingPaletteFromXml $TemplatePath
    Write-Result ([pscustomobject]@{ ok = $true; markings = $markings })
    exit 0
  }

  # Mode = candidates
  $selectedMarkings = @()
  if (-not [string]::IsNullOrWhiteSpace($SelectedMarkingsJson)) {
    $parsed = $SelectedMarkingsJson | ConvertFrom-Json
    $selectedMarkings = @($parsed)
  }
  if ($selectedMarkings.Count -eq 0) { throw "Nie wybrano zadnych oznaczen do skanowania." }

  $word = $null
  $oldSecurity = $null
  $doc = $null
  try {
    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    $word.DisplayAlerts = 0
    try { $oldSecurity = $word.AutomationSecurity; $word.AutomationSecurity = 3 } catch {}
    try { $word.Options.UpdateLinksAtOpen = $false } catch {}

    # Parametr Visible (12ty, przedostatni) TO NIE JEST to samo co
    # $word.Visible ustawione wyzej - to WLASNE, DOKUMENTOWE ustawienie
    # Documents.Open, i MUSI byc $true (zweryfikowane live, audyt 2026-09-10:
    # otwarcie z Visible=$false na poziomie dokumentu powoduje, ze Shape.TextFrame
    # nigdy sie w pelni nie inicjalizuje - "The property 'HasText' cannot be
    # found on this object" - mimo ze cala aplikacja Word pozostaje niewidoczna
    # dzieki $word.Visible=$false ustawionemu na Application, nie na Document).
    $doc = $word.Documents.Open($TemplatePath, $false, $true, $false, "", "", $false, "", "", 0, 65001, $true, $true)
    if ($null -eq $doc) { throw "Word nie otworzyl szablonu." }
    try { $doc.Repaginate() } catch {}

    $scan = Find-ScyzorykMarkedCandidates -doc $doc -selectedMarkings ([string[]]$selectedMarkings)
    # Blad pojedynczego mechanizmu (np. wyjatek COM przy skanowaniu highlightu)
    # NIE moze zostac po cichu zamieniony w "0 kandydatow" (audyt 2026-09-10,
    # sekcja 7 promptu naprawczego) - jesli WSZYSTKIE mechanizmy zawiodly (brak
    # kandydatow ORAZ sa bledy), zglaszamy to jako twardy blad zamiast pustego
    # sukcesu. Pojedynczy blad przy niepustym wyniku trafia do diagnostics,
    # zeby UI moglo go pokazac, ale nie blokuje reszty znalezionych kandydatow.
    if ($scan.Candidates.Count -eq 0 -and $scan.Diagnostics.mechanismErrors.Count -gt 0) {
      $firstErr = $scan.Diagnostics.mechanismErrors[0]
      throw "Nie udalo sie przeskanowac oznaczen typu '$($firstErr.mechanism)' (story: $($firstErr.storyKey)). Word COM: $($firstErr.message)"
    }
    # .ToArray() zamiast @(List[object]) - na niektorych maszynach operator
    # tablicowy @() rzuca "Niezgodne typy argumentow" (System.ArgumentException)
    # przy probie skopiowania System.Collections.Generic.List[object] do
    # tablicy (zaobserwowane zywo po resecie systemu - audyt 2026-09-10);
    # .ToArray() jest wprost wspieranym mechanizmem List<T> i nie ma tego problemu.
    Write-Result ([pscustomobject]@{ ok = $true; candidates = $scan.Candidates.ToArray(); diagnostics = $scan.Diagnostics })
  } finally {
    if ($null -ne $doc) { try { $doc.Close($false) } catch {} }
    if ($null -ne $word) {
      if ($null -ne $oldSecurity) { try { $word.AutomationSecurity = $oldSecurity } catch {} }
      try { $word.Quit() } catch {}
    }
  }
} catch {
  Write-Result ([pscustomobject]@{ ok = $false; message = "$($_.Exception.Message)" })
  exit 0
}
