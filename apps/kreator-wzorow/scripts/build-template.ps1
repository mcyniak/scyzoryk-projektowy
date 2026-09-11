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

    # Visible (12ty parametr) MUSI byc $true - patrz komentarz w scan-template.ps1
    # (audyt 2026-09-10): to jest wlasciwosc DOKUMENTU (nie Application, ktora
    # zostaje niewidoczna dzieki $word.Visible=$false powyzej), i jej $false
    # uniemozliwia pelna inicjalizacje Shape.TextFrame (TEXTBOX_MARK nigdy nie
    # zostalby wykryty, "The property 'HasText' cannot be found on this object").
    $doc = $word.Documents.Open($TemplatePath, $false, $false, $false, "", "", $false, "", "", 0, 65001, $true, $true)
    if ($null -eq $doc) { throw "Word nie otworzyl szablonu." }
    try { $doc.Repaginate() } catch {}

    # PONOWNY skan TEGO SAMEGO algorytmu co scan-template.ps1 - to jest
    # weryfikacja "wzor sie nie zmienil od czasu skanowania" (sekcja 22),
    # solidniejsza niz zaufanie surowym liczbom Start/End zapisanym przy
    # skanie (COM Range offsety NIE sa gwarantowane identyczne miedzy
    # oddzielnymi sesjami otwarcia dokumentu - powtorzenie IDENTYCZNEGO
    # zapytania Find w TEJ SESJI jest jedynym pewnym zrodlem prawdy "gdzie to
    # teraz naprawde jest").
    $scan = Find-ScyzorykMarkedCandidates -doc $doc -selectedMarkings ([string[]]$selectedMarkings)
    # .ToArray() zamiast @(List[object]) - patrz komentarz w scan-template.ps1
    # (audyt 2026-09-10): @() na System.Collections.Generic.List[object] rzuca
    # "Niezgodne typy argumentow" na niektorych maszynach.
    $freshCandidates = $scan.Candidates.ToArray()
    if ($freshCandidates.Count -eq 0 -and $scan.Diagnostics.mechanismErrors.Count -gt 0) {
      $firstErr = $scan.Diagnostics.mechanismErrors[0]
      throw "Nie udalo sie ponownie przeskanowac oznaczen typu '$($firstErr.mechanism)' (story: $($firstErr.storyKey)) przed buildem. Word COM: $($firstErr.message)"
    }
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
    # (min..max PO KONTENERZE, nie po tresci - sekcja 5.C/8.E audytu: usuniecie
    # bloku przy warunku niespelnionym ma zabrac CALY akapit/komorke wraz z
    # koncowym znacznikiem, a nie zostawic osierocona pusta linie), manual =
    # bez jednostki (nic nie ruszamy).
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
      $units.Add([pscustomobject]@{ type = $decision.status; start = [int]$fresh.start; end = [int]$fresh.end; storyKey = $fresh.storyKey; storyType = [int]$fresh.storyType; chainIndex = [int]$fresh.chainIndex; shapeIndex = $fresh.shapeIndex; markKind = [string]$fresh.mark.kind; tableOrdinal = $fresh.tableOrdinal; cellOrdinal = $fresh.cellOrdinal; candidateId = $stored.id; decision = $decision }) | Out-Null
    }
    foreach ($blockId in $blockGroups.Keys) {
      $members = $blockGroups[$blockId]
      # Wszyscy czlonkowie tego samego bloku MUSZA byc w JEDNEJ, spojnej
      # czesci dokumentu - min/max Start/End miedzy roznymi story (np.
      # naglowek i stopka maja WLASNA, niezalezna numeracje od zera) byloby
      # bezsensowne i mogloby uszkodzic zupelnie inny fragment dokumentu.
      $distinctStories = $members | Select-Object -ExpandProperty storyKey -Unique
      if ($distinctStories.Count -gt 1) {
        throw "Blok '$blockId' laczy fragmenty z roznych czesci dokumentu ($($distinctStories -join ', ')) - to nie jest obslugiwane, kazdy blok musi byc w jednej spojnej czesci dokumentu (np. tylko w glownym tekscie albo tylko w jednym naglowku)."
      }
      $minStart = ($members | Measure-Object -Property containerStart -Minimum).Minimum
      $maxEnd = ($members | Measure-Object -Property containerEnd -Maximum).Maximum
      $blockDefProp = $manifestObj.blocks | Where-Object { $_.id -eq $blockId } | Select-Object -First 1
      if ($null -eq $blockDefProp) { continue }
      $units.Add([pscustomobject]@{ type = 'block'; start = [int]$minStart; end = [int]$maxEnd; storyKey = $members[0].storyKey; storyType = [int]$members[0].storyType; chainIndex = [int]$members[0].chainIndex; shapeIndex = $members[0].shapeIndex; blockId = $blockId; bookmarkName = $blockDefProp.bookmarkName; members = $members }) | Out-Null
    }

    # Od NAJWYZSZEGO Range.Start do NAJNIZSZEGO (sekcja 26) - mutacja pozniej
    # w dokumencie nigdy nie przesuwa pozycji tego, co jeszcze czeka wczesniej
    # w tej SAMEJ story (rozne story maja niezalezna numeracje, wiec ich
    # wzajemna kolejnosc w tym sortowaniu nie ma znaczenia dla poprawnosci).
    # WYJATEK (zweryfikowane live, audyt 2026-09-10): jednostki w TextFrame
    # (shapeIndex <> null) sa przetwarzane JAKO PIERWSZE, przed jakakolwiek
    # mutacja glownego tekstu/naglowka/stopki - Word potrafi USUNAC caly
    # ksztalt (shape), jesli akapit, do ktorego jest on zakotwiczony w
    # dokumencie, zostanie w miedzyczasie podmieniony (np. staly tekst w
    # innym oznaczonym fragmencie tego samego akapitu). Przetwarzajac
    # ksztalty najpierw, zanim cokolwiek innego w dokumencie sie zmieni,
    # minimalizujemy ryzyko trafienia na ten przypadek.
    $sortedUnits = $units | Sort-Object -Property @{ Expression = { if ($null -ne $_.shapeIndex) { 0 } else { 1 } } }, @{ Expression = 'start'; Descending = $true }
    $warnings = New-Object System.Collections.Generic.List[object]
    $wdFieldEmpty = 59 # wdFieldMergeField w rzeczywistosci = 59 (WdFieldType.wdFieldMergeField)

    # Czysci oznaczenie robocze z DANEGO mechanizmu (mark.kind) na danej
    # jednostce mutacji. Highlight/run-shading czyscimy na $CleanupRange
    # (dziala poprawnie nawet dla czesciowego zakresu po mutacji tresci).
    # Paragraph shading TEZ czyscimy na $CleanupRange - zweryfikowane live
    # (audyt 2026-09-10): ParagraphFormat.Shading poprawnie propaguje sie z
    # DOWOLNEGO czesciowego zakresu na caly akapit. Cell shading NIE MOZE byc
    # czyszczony przez czesciowy zakres (zweryfikowane live: to CICHY NO-OP) -
    # wymaga bezposrednio obiektu Cell (Get-ScyzorykCellByOrdinal), niezaleznie
    # od $CleanupRange.
    function Clear-ScyzorykWorkingMark($StoryRangeForCells, $CleanupRange, [string]$MarkKind, $TableOrdinal, $CellOrdinal) {
      if ($MarkKind -eq 'highlight') {
        try { $CleanupRange.HighlightColorIndex = 0 } catch {}
      } elseif ($MarkKind -eq 'shading-run') {
        try { $CleanupRange.Shading.BackgroundPatternColor = -16777216 } catch {}
      } elseif ($MarkKind -eq 'shading-paragraph') {
        try { $CleanupRange.ParagraphFormat.Shading.BackgroundPatternColor = -16777216 } catch {}
      } elseif ($MarkKind -eq 'shading-cell') {
        try {
          $cell = Get-ScyzorykCellByOrdinal $StoryRangeForCells ([int]$TableOrdinal) ([int]$CellOrdinal)
          $cell.Shading.BackgroundPatternColor = -16777216
        } catch {}
      } else {
        # Nieznany/legacy mark.kind - wyczysc oba mozliwe mechanizmy jak
        # poprzednio, zeby nic nie zostalo widocznie oznaczone.
        try { $CleanupRange.HighlightColorIndex = 0 } catch {}
        try { $CleanupRange.Shading.BackgroundPatternColor = -16777216 } catch {}
      }
    }

    foreach ($unit in $sortedUnits) {
      try {
        $range = Get-ScyzorykStoryRangeCopy -doc $doc -storyKey $unit.storyKey -storyType $unit.storyType -chainIndex $unit.chainIndex -shapeIndex $unit.shapeIndex
        $range.Start = $unit.start
        $range.End = $unit.end
        $cleanupRange = $range
        # Kopia story PRZED jakakolwiek mutacja tresci w tej jednostce -
        # potrzebna do Get-ScyzorykCellByOrdinal (iteruje Tables od poczatku
        # story), zeby dzialala niezaleznie od tego, co $range robi dalej.
        $storyForCells = Get-ScyzorykStoryRangeCopy -doc $doc -storyKey $unit.storyKey -storyType $unit.storyType -chainIndex $unit.chainIndex -shapeIndex $unit.shapeIndex

        if ($unit.type -eq 'field') {
          $fieldDefProp = $manifestObj.fields | Where-Object { $_.id -eq $unit.decision.fieldId } | Select-Object -First 1
          if ($null -eq $fieldDefProp) { throw "Brak definicji pola '$($unit.decision.fieldId)' w manifescie." }
          # Fields.Add ZASTEPUJE tresc $range polem i zwraca nowo utworzony
          # obiekt Field - jego .Result to Range faktycznie wstawionego pola,
          # dokladnie to trzeba oczyscic z oznaczenia (nie oryginalny $range,
          # ktorego dlugosc/pozycja koncowa zmienila sie po wstawieniu pola).
          $newField = $doc.Fields.Add($range, $wdFieldEmpty, [string]$fieldDefProp.mergeFieldName, $false)
          $cleanupRange = $newField.Result
          Clear-ScyzorykWorkingMark $storyForCells $cleanupRange $unit.markKind $unit.tableOrdinal $unit.cellOrdinal
        } elseif ($unit.type -eq 'constant') {
          if ($null -ne $unit.decision.constantText) {
            $range.Text = [string]$unit.decision.constantText
            $constRange = Get-ScyzorykStoryRangeCopy -doc $doc -storyKey $unit.storyKey -storyType $unit.storyType -chainIndex $unit.chainIndex -shapeIndex $unit.shapeIndex
            $constRange.Start = $unit.start
            $constRange.End = $unit.start + [string]$unit.decision.constantText.Length
            $cleanupRange = $constRange
          }
          Clear-ScyzorykWorkingMark $storyForCells $cleanupRange $unit.markKind $unit.tableOrdinal $unit.cellOrdinal
        } elseif ($unit.type -eq 'block') {
          [void]$doc.Bookmarks.Add([string]$unit.bookmarkName, $range)
          # Kazdy czlonek bloku moze pochodzic z INNEGO mechanizmu oznaczenia
          # (np. jedna komorka + jeden akapit polaczone w jeden blok), wiec
          # czyscimy KAZDEGO z osobna, jego WLASNA metoda - zadna mutacja
          # tresci nie zaszla jeszcze w tej jednostce (Bookmarks.Add nie
          # zmienia dlugosci tekstu), wiec ich zapisane fresh start/end sa
          # nadal aktualne.
          foreach ($member in $unit.members) {
            $memberRange = Get-ScyzorykStoryRangeCopy -doc $doc -storyKey $member.storyKey -storyType ([int]$member.storyType) -chainIndex ([int]$member.chainIndex) -shapeIndex $member.shapeIndex
            $memberRange.Start = [int]$member.start
            $memberRange.End = [int]$member.end
            Clear-ScyzorykWorkingMark $storyForCells $memberRange ([string]$member.mark.kind) $member.tableOrdinal $member.cellOrdinal
          }
        }
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

    Write-Result ([pscustomobject]@{ ok = $true; warnings = $warnings.ToArray() })
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
