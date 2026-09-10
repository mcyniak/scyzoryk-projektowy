param(
  [Parameter(Mandatory=$true)][string]$TemplatePath,
  [Parameter(Mandatory=$true)][string]$DraftJson,
  [Parameter(Mandatory=$true)][string]$CandidatesJson,
  [Parameter(Mandatory=$true)][string]$ManifestJson,
  [Parameter(Mandatory=$true)][string]$OutputPath,
  [string]$SelectedMarkingsJson = ""
)

# KROK 4 specyfikacji Kreatora wzorow seryjnych - zamienia oznaczone
# kandydaty w dokumencie na ich finalna postac (MERGEFIELD / smart bookmark /
# staly tekst / bez zmian dla "Do projektanta") i dokleja manifest jako
# Custom XML Part (namespace urn:scyzoryk:smart-template:v1, patrz
# apps/dokumenty-seryjne/src/smartTemplate.js#readSmartTemplateManifest,
# ktory go pozniej czyta).

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}
. (Join-Path $PSScriptRoot "..\..\..\lib\wordSmartTemplate.ps1")

function Write-Result($obj) {
  Write-Output ($obj | ConvertTo-Json -Depth 20 -Compress)
}
function Release-ComObject($obj) {
  if ($null -ne $obj) { try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($obj) } catch {} }
}

try {
  if (-not (Test-Path -LiteralPath $TemplatePath)) { throw "Nie znaleziono szablonu: $TemplatePath" }
  $draft = Get-Content -LiteralPath $DraftJson -Raw -Encoding UTF8 | ConvertFrom-Json
  $storedCandidates = @(Get-Content -LiteralPath $CandidatesJson -Raw -Encoding UTF8 | ConvertFrom-Json)
  $manifestObj = Get-Content -LiteralPath $ManifestJson -Raw -Encoding UTF8 | ConvertFrom-Json
  $selectedMarkings = @()
  if (-not [string]::IsNullOrWhiteSpace($SelectedMarkingsJson)) { $selectedMarkings = @($SelectedMarkingsJson | ConvertFrom-Json) }
  if ($selectedMarkings.Count -eq 0) { throw "Brak listy oznaczen uzytych przy skanowaniu - wczytaj/skanuj wzor ponownie." }

  # Indeks kandydatow ZAPISANYCH przy skanie, po tym samym kluczu, jaki
  # generuje Find-ScyzorykMarkedCandidates (storyKey|paletteKey|ordinal) -
  # deterministyczny, bo kolejnosc Find-loopa jest stabilna dla niezmienionego
  # pliku (sekcja 22: "nie zgaduj pozycji po samym tekscie, szczegolnie dla
  # wielokrotnych XXX" - to jest wlasnie ten mechanizm: NIE dopasowujemy po
  # samym tekscie, tylko po pozycji w kolejnosci skanowania + fingerprint).
  $storedByKey = @{}
  foreach ($c in $storedCandidates) {
    $key = "$($c.storyKey)|$($c.mark.paletteKey)|$($c.ordinal)"
    $storedByKey[$key] = $c
  }

  $word = $null
  $oldSecurity = $null
  $doc = $null
  try {
    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    $word.DisplayAlerts = 0
    try { $oldSecurity = $word.AutomationSecurity; $word.AutomationSecurity = 3 } catch {}
    try { $word.Options.UpdateLinksAtOpen = $false } catch {}
    try { $word.Options.ConfirmConversions = $false } catch {}

    $doc = $word.Documents.Open($TemplatePath, $false, $false, $false, "", "", $false, "", "", 0, 65001, $false, $true)
    if ($null -eq $doc) { throw "Word nie otworzyl szablonu." }
    try { $doc.Repaginate() } catch {}

    # PONOWNY skan TEGO SAMEGO algorytmu co scan-template.ps1 - to jest
    # weryfikacja "wzor sie nie zmienil od czasu skanowania" (sekcja 22),
    # solidniejsza niz zaufanie surowym liczbom Start/End zapisanym przy
    # skanie (COM Range offsety NIE sa gwarantowane identyczne miedzy
    # oddzielnymi sesjami otwarcia dokumentu - powtorzenie IDENTYCZNEGO
    # zapytania Find w TEJ SESJI jest jedynym pewnym zrodlem prawdy "gdzie to
    # teraz naprawde jest").
    $freshCandidates = Find-ScyzorykMarkedCandidates -doc $doc -selectedMarkings ([string[]]$selectedMarkings)
    $freshByKey = @{}
    foreach ($c in $freshCandidates) {
      $key = "$($c.storyKey)|$($c.mark.paletteKey)|$($c.ordinal)"
      $freshByKey[$key] = $c
    }
    if ($freshCandidates.Count -ne $storedCandidates.Count) {
      throw "Wzor zmienil sie od czasu skanowania (inna liczba oznaczonych fragmentow: bylo $($storedCandidates.Count), jest $($freshCandidates.Count)). Wczytaj/skanuj ponownie."
    }
    foreach ($key in $storedByKey.Keys) {
      if (-not $freshByKey.ContainsKey($key)) { throw "Wzor zmienil sie od czasu skanowania (zniknal fragment $key). Wczytaj/skanuj ponownie." }
      if ($freshByKey[$key].fingerprint -ne $storedByKey[$key].fingerprint) {
        throw "Wzor zmienil sie od czasu skanowania (tresc fragmentu $key jest inna niz przy skanie). Wczytaj/skanuj ponownie."
      }
    }

    # Zbuduj liste jednostek mutacji: field/constant = jeden kandydat, block =
    # WSZYSCY kandydaci z tym samym blockId polaczeni w JEDEN zakres
    # (min Start .. max End, po FRESH pozycjach), manual = bez jednostki
    # (nic nie ruszamy - sekcja 8.E: "nie probuj niczego podmieniac").
    $units = New-Object System.Collections.Generic.List[object]
    $blockGroups = @{}
    foreach ($stored in $storedCandidates) {
      $key = "$($stored.storyKey)|$($stored.mark.paletteKey)|$($stored.ordinal)"
      $fresh = $freshByKey[$key]
      $decisionProp = $draft.candidates.PSObject.Properties[$stored.id]
      if ($null -eq $decisionProp) { continue }
      $decision = $decisionProp.Value
      if ($decision.status -eq 'manual' -or $decision.status -eq 'unresolved') { continue }
      if ($decision.status -eq 'block') {
        $blockId = [string]$decision.blockId
        if (-not $blockGroups.ContainsKey($blockId)) { $blockGroups[$blockId] = New-Object System.Collections.Generic.List[object] }
        $blockGroups[$blockId].Add($fresh) | Out-Null
        continue
      }
      $units.Add([pscustomobject]@{ type = $decision.status; start = [int]$fresh.start; end = [int]$fresh.end; storyKey = $fresh.storyKey; candidateId = $stored.id; decision = $decision }) | Out-Null
    }
    foreach ($blockId in $blockGroups.Keys) {
      $members = $blockGroups[$blockId]
      $minStart = ($members | Measure-Object -Property start -Minimum).Minimum
      $maxEnd = ($members | Measure-Object -Property end -Maximum).Maximum
      $blockDefProp = $manifestObj.blocks | Where-Object { $_.id -eq $blockId } | Select-Object -First 1
      if ($null -eq $blockDefProp) { continue }
      $units.Add([pscustomobject]@{ type = 'block'; start = [int]$minStart; end = [int]$maxEnd; storyKey = $members[0].storyKey; blockId = $blockId; bookmarkName = $blockDefProp.bookmarkName }) | Out-Null
    }

    # Od NAJWYZSZEGO Range.Start do NAJNIZSZEGO (sekcja 26) - mutacja pozniej
    # w dokumencie nigdy nie przesuwa pozycji tego, co jeszcze czeka wczesniej
    # w dokumencie.
    $sortedUnits = $units | Sort-Object -Property start -Descending
    $warnings = New-Object System.Collections.Generic.List[object]
    $wdFieldEmpty = 59 # wdFieldMergeField w rzeczywistosci = 59 (WdFieldType.wdFieldMergeField)

    foreach ($unit in $sortedUnits) {
      try {
        $range = $doc.Range($unit.start, $unit.end)
        $cleanupRange = $range

        if ($unit.type -eq 'field') {
          $fieldDefProp = $manifestObj.fields | Where-Object { $_.id -eq $unit.decision.fieldId } | Select-Object -First 1
          if ($null -eq $fieldDefProp) { throw "Brak definicji pola '$($unit.decision.fieldId)' w manifescie." }
          # Fields.Add ZASTEPUJE tresc $range polem i zwraca nowo utworzony
          # obiekt Field - jego .Result to Range faktycznie wstawionego pola,
          # dokladnie to trzeba oczyscic z oznaczenia (nie oryginalny $range,
          # ktorego dlugosc/pozycja koncowa zmienila sie po wstawieniu pola).
          $newField = $doc.Fields.Add($range, $wdFieldEmpty, [string]$fieldDefProp.mergeFieldName, $false)
          $cleanupRange = $newField.Result
        } elseif ($unit.type -eq 'constant') {
          if ($null -ne $unit.decision.constantText) {
            $range.Text = [string]$unit.decision.constantText
            $cleanupRange = $doc.Range($unit.start, $unit.start + [string]$unit.decision.constantText.Length)
          }
        } elseif ($unit.type -eq 'block') {
          [void]$doc.Bookmarks.Add([string]$unit.bookmarkName, $range)
        }

        # Usun oznaczenie robocze z tego zakresu - czyszczenie zarowno
        # Highlight jak i Shading jest bezpieczne nawet gdy kandydat mial
        # tylko jeden z nich (czyszczenie wlasciwosci, ktora nigdy nie byla
        # ustawiona, jest no-opem).
        try { $cleanupRange.HighlightColorIndex = 0 } catch {}
        try { $cleanupRange.Shading.BackgroundPatternColor = -16777216 } catch {}
      } catch {
        $warnings.Add([pscustomobject]@{ level = 'error'; message = "Kandydat $($unit.candidateId): $($_.Exception.Message)" }) | Out-Null
      }
    }

    try { $doc.Repaginate() } catch {}

    # Manifest jako Custom XML Part - Word sam poprawnie dba o
    # [Content_Types].xml i relacje OPC (patrz komentarz w smartTemplate.js).
    # ']]>' w JSON (teoretyczny, skrajny przypadek - uzytkownik wpisal
    # doslownie ten ciag w stalym tekscie/etykiecie) rozbilibysmy CDATA, wiec
    # rozdzielamy go na dwie sekcje CDATA - standardowa, bezpieczna technika.
    $manifestJsonText = Get-Content -LiteralPath $ManifestJson -Raw -Encoding UTF8
    $safeJson = $manifestJsonText -replace '\]\]>', ']]]]><![CDATA[>'
    $customXml = "<?xml version=`"1.0`" encoding=`"UTF-8`" standalone=`"yes`"?><scyzoryk:smartTemplate xmlns:scyzoryk=`"urn:scyzoryk:smart-template:v1`" version=`"1`"><![CDATA[$safeJson]]></scyzoryk:smartTemplate>"
    [void]$doc.CustomXMLParts.Add($customXml)

    if (Test-Path -LiteralPath $OutputPath) { Remove-Item -LiteralPath $OutputPath -Force }
    $doc.SaveAs2([string]$OutputPath, [int]16)

    Write-Result ([pscustomobject]@{ ok = $true; warnings = @($warnings) })
  } finally {
    if ($null -ne $doc) { try { $doc.Close($false) } catch {}; Release-ComObject $doc }
    if ($null -ne $word) {
      if ($null -ne $oldSecurity) { try { $word.AutomationSecurity = $oldSecurity } catch {} }
      try { $word.Quit() } catch {}
      Release-ComObject $word
    }
  }
} catch {
  Write-Result ([pscustomobject]@{ ok = $false; message = "$($_.Exception.Message)" })
  exit 0
}
