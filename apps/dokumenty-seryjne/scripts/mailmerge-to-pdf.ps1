param(
  [Parameter(Mandatory=$true)][string]$TemplatePath,
  [Parameter(Mandatory=$true)][string]$ExcelPath,
  [Parameter(Mandatory=$true)][string]$OutputDir,
  [Parameter(Mandatory=$true)][string]$SheetName,
  [string]$AddressColumn = "Adres",
  [string]$RowsCsv = "",
  [string]$DataJson = "",
  [string]$LogPath = "",
  [string]$DebugJsonPath = "",
  [string]$ReplacementJson = "",
  [string]$FilePrefix = "",
  [switch]$VisibleWord,
  [switch]$DebugMode
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}

function Write-Log([string]$level, [string]$message, $data = $null) {
  $stamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss.fff")
  $line = "[$stamp] [$($level.ToUpperInvariant())] $message"
  if ($null -ne $data) {
    try { $line += " " + (($data | ConvertTo-Json -Depth 30 -Compress)) } catch {}
  }
  if (-not [string]::IsNullOrWhiteSpace($LogPath)) {
    try { Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8 } catch {}
  }
}

function Write-JsonLine($obj) {
  try {
    $json = $obj | ConvertTo-Json -Depth 30 -Compress
    Write-Output $json
    if (-not [string]::IsNullOrWhiteSpace($DebugJsonPath)) {
      try { Add-Content -LiteralPath $DebugJsonPath -Value $json -Encoding UTF8 } catch {}
    }
  } catch {
    Write-Output '{"event":"internal-json-error","message":"Nie udalo sie zapisac JSON."}'
  }
}

function Write-Event([string]$event, [string]$message, $data = $null) {
  Write-Log "info" $message $data
  $obj = [ordered]@{ event = $event; message = $message; time = (Get-Date).ToString("o") }
  if ($null -ne $data) {
    foreach ($p in $data.PSObject.Properties) { $obj[$p.Name] = $p.Value }
  }
  Write-JsonLine ([pscustomobject]$obj)
}

function Safe-FileName([string]$name) {
  if ([string]::IsNullOrWhiteSpace($name)) { $name = "bez_adresu" }
  $invalid = [System.IO.Path]::GetInvalidFileNameChars()
  foreach ($ch in $invalid) { $name = $name.Replace([string]$ch, "_") }
  $name = [Regex]::Replace($name, "\s+", " ").Trim()
  $name = $name.Trim(".", " ")
  if ($name.Length -gt 120) { $name = $name.Substring(0, 120).Trim() }
  if ([string]::IsNullOrWhiteSpace($name)) { $name = "bez_adresu" }
  return $name
}

function Join-PrefixAndAddress([string]$prefix, [string]$address) {
  $p = [string]$prefix
  $a = [string]$address
  if ([string]::IsNullOrWhiteSpace($p)) { return $a }
  $p = [Regex]::Replace($p, "\s+", " ").Trim()
  if ([string]::IsNullOrWhiteSpace($p)) { return $a }
  # Jezeli uzytkownik wpisze separator na koncu, np. "PT_" albo "Strona -", nie dodajemy drugiego separatora.
  if ($p.EndsWith("_")) { return ($p + $a).Trim() }
  if ($p.EndsWith("-") -or $p.EndsWith(".")) { return ($p + " " + $a).Trim() }
  return ($p + " - " + $a).Trim()
}

function Unique-Path([string]$dir, [string]$base, [string]$ext) {
  $candidate = Join-Path $dir ($base + $ext)
  $i = 2
  while (Test-Path -LiteralPath $candidate) {
    $candidate = Join-Path $dir ($base + "_" + $i + $ext)
    $i++
  }
  return $candidate
}

function Release-ComObject($obj) {
  if ($null -ne $obj) {
    try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($obj) } catch {}
  }
}

function Normalize-Name([string]$text) {
  if ($null -eq $text) { return "" }
  $s = [string]$text
  try {
    $s = $s.Normalize([System.Text.NormalizationForm]::FormD)
    $sb = New-Object System.Text.StringBuilder
    foreach ($ch in $s.ToCharArray()) {
      $cat = [System.Globalization.CharUnicodeInfo]::GetUnicodeCategory($ch)
      if ($cat -ne [System.Globalization.UnicodeCategory]::NonSpacingMark) { [void]$sb.Append($ch) }
    }
    $s = $sb.ToString()
  } catch {}
  $s = $s.ToLowerInvariant()
  $s = [Regex]::Replace($s, "[^a-z0-9]+", "_")
  $s = $s.Trim("_")
  return $s
}

function Get-RecordValue($record, [string]$fieldName) {
  if ($null -eq $record -or [string]::IsNullOrWhiteSpace($fieldName)) { return "" }
  $props = @($record.PSObject.Properties)

  foreach ($p in $props) {
    if ($p.Name -eq $fieldName) { return [string]$p.Value }
  }

  $fieldNorm = Normalize-Name $fieldName
  foreach ($p in $props) {
    if ((Normalize-Name $p.Name) -eq $fieldNorm) { return [string]$p.Value }
  }

  $best = $null
  $bestLen = 0
  foreach ($p in $props) {
    $colNorm = Normalize-Name $p.Name
    if ([string]::IsNullOrWhiteSpace($colNorm)) { continue }
    if ($colNorm.StartsWith($fieldNorm) -or $fieldNorm.StartsWith($colNorm)) {
      $score = [Math]::Min($colNorm.Length, $fieldNorm.Length)
      if ($score -gt $bestLen) { $best = $p; $bestLen = $score }
    }
  }
  if ($null -ne $best) { return [string]$best.Value }
  return ""
}

function Get-MergeFieldName($field) {
  try { $code = [string]$field.Code.Text } catch { return "" }
  $m = [Regex]::Match($code, 'MERGEFIELD\s+(?:"([^"]+)"|([^\s\\]+))', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
  if (-not $m.Success) { return "" }
  if ($m.Groups[1].Success) { return $m.Groups[1].Value.Trim() }
  return $m.Groups[2].Value.Trim()
}

function Replace-MergeFieldsInRange($range, $record, [System.Collections.Generic.List[object]]$fieldDebug) {
  if ($null -eq $range) { return }
  $count = 0
  try { $count = [int]$range.Fields.Count } catch { return }
  for ($i = $count; $i -ge 1; $i--) {
    $field = $null
    try { $field = $range.Fields.Item($i) } catch { continue }
    $name = Get-MergeFieldName $field
    if ([string]::IsNullOrWhiteSpace($name)) { continue }
    $value = Get-RecordValue $record $name
    if ($DebugMode) { $fieldDebug.Add([pscustomobject]@{ field = $name; value = $value }) | Out-Null }
    try {
      $field.Result.Text = [string]$value
      $field.Unlink() | Out-Null
    } catch {
      try {
        $field.Select()
        $script:word.Selection.TypeText([string]$value)
      } catch {}
    }
  }
}

function Replace-AllMergeFields($doc, $record) {
  $fieldDebug = New-Object System.Collections.Generic.List[object]
  try {
    $story = $doc.StoryRanges.Item(1)
    while ($null -ne $story) {
      Replace-MergeFieldsInRange $story $record $fieldDebug
      try { $story = $story.NextStoryRange } catch { $story = $null }
    }
  } catch {
    try { Replace-MergeFieldsInRange $doc.Range() $record $fieldDebug } catch {}
  }

  try {
    foreach ($shape in @($doc.Shapes)) {
      try {
        if ($shape.TextFrame.HasText -ne 0) { Replace-MergeFieldsInRange $shape.TextFrame.TextRange $record $fieldDebug }
      } catch {}
    }
  } catch {}
  return $fieldDebug
}


function New-UniqueTokenList() {
  return New-Object System.Collections.Generic.List[string]
}

function Add-Token([System.Collections.Generic.List[string]]$list, [string]$value) {
  if ([string]::IsNullOrWhiteSpace($value)) { return }
  if (-not $list.Contains($value)) { $list.Add($value) | Out-Null }
}

function Get-AutomaticMarkersForColumn([string]$columnName) {
  $tokens = New-UniqueTokenList
  $norm = Normalize-Name $columnName
  $names = New-UniqueTokenList
  Add-Token $names $columnName
  Add-Token $names $norm
  foreach ($name in $names) {
    Add-Token $tokens ("{{" + $name + "}}")
    Add-Token $tokens ("[[" + $name + "]]" )
    Add-Token $tokens ("<<" + $name + ">>")
    Add-Token $tokens ("«" + $name + "»")
  }
  return $tokens
}

function Replace-TextInOneRange($range, [string]$findText, [string]$replaceText, [int]$occurrence, $counter) {
  if ($null -eq $range -or [string]::IsNullOrEmpty($findText)) { return 0 }
  $made = 0
  if ($occurrence -le 0) {
    try {
      $find = $range.Find
      $find.ClearFormatting() | Out-Null
      $find.Replacement.ClearFormatting() | Out-Null
      $find.Text = $findText
      $find.Replacement.Text = $replaceText
      $find.Forward = $true
      $find.Wrap = 1
      $find.Format = $false
      $find.MatchCase = $false
      $find.MatchWholeWord = $false
      $find.MatchWildcards = $false
      $find.MatchSoundsLike = $false
      $find.MatchAllWordForms = $false
      $wdReplaceAll = 2
      [void]$find.Execute($findText, $false, $false, $false, $false, $false, $true, 1, $false, $replaceText, $wdReplaceAll)
      return 1
    } catch {
      return 0
    }
  }

  # Tryb zaawansowany: zamien tylko konkretne wystapienie znalezionego tekstu.
  # Przydaje sie przy szablonach, w ktorych kilka roznych pol ma ten sam tekst typu XXX.
  try {
    $work = $range.Duplicate
    while ($true) {
      $find = $work.Find
      $find.ClearFormatting() | Out-Null
      $find.Text = $findText
      $find.Forward = $true
      $find.Wrap = 0
      $find.Format = $false
      $find.MatchCase = $false
      $find.MatchWholeWord = $false
      $find.MatchWildcards = $false
      $found = $find.Execute()
      if (-not $found) { break }
      $counter.Value = [int]$counter.Value + 1
      if ([int]$counter.Value -eq $occurrence) {
        $work.Text = $replaceText
        $made++
        break
      }
      $nextStart = $work.End
      if ($nextStart -ge $range.End) { break }
      $work.SetRange($nextStart, $range.End) | Out-Null
    }
  } catch {}
  return $made
}

function Replace-TextEverywhere($doc, [string]$findText, [string]$replaceText, [int]$occurrence) {
  $counter = [pscustomobject]@{ Value = 0 }
  $changed = 0
  try {
    $story = $doc.StoryRanges.Item(1)
    while ($null -ne $story) {
      $changed += Replace-TextInOneRange $story $findText $replaceText $occurrence $counter
      try { $story = $story.NextStoryRange } catch { $story = $null }
    }
  } catch {
    try { $changed += Replace-TextInOneRange ($doc.Range()) $findText $replaceText $occurrence $counter } catch {}
  }

  try {
    foreach ($shape in @($doc.Shapes)) {
      try {
        if ($shape.TextFrame.HasText -ne 0) { $changed += Replace-TextInOneRange $shape.TextFrame.TextRange $findText $replaceText $occurrence $counter }
      } catch {}
    }
  } catch {}
  return $changed
}


function Document-MayHaveAutoMarkers($doc) {
  try {
    $story = $doc.StoryRanges.Item(1)
    while ($null -ne $story) {
      $t = [string]$story.Text
      if ($t.Contains("{{") -or $t.Contains("[[") -or $t.Contains("<<") -or $t.Contains("«")) { return $true }
      try { $story = $story.NextStoryRange } catch { $story = $null }
    }
  } catch {
    try {
      $t = [string]($doc.Range().Text)
      if ($t.Contains("{{") -or $t.Contains("[[") -or $t.Contains("<<") -or $t.Contains("«")) { return $true }
    } catch {}
  }
  try {
    foreach ($shape in @($doc.Shapes)) {
      try {
        if ($shape.TextFrame.HasText -ne 0) {
          $t = [string]$shape.TextFrame.TextRange.Text
          if ($t.Contains("{{") -or $t.Contains("[[") -or $t.Contains("<<") -or $t.Contains("«")) { return $true }
        }
      } catch {}
    }
  } catch {}
  return $false
}

function Replace-AllTextMarkers($doc, $record, $rules) {
  $debug = New-Object System.Collections.Generic.List[object]

  # 1) Reczne zamiany z panelu, np. xxxxx -> Adres.
  foreach ($rule in @($rules)) {
    try {
      $find = [string]$rule.find
      $column = [string]$rule.column
      $occurrence = 0
      try { $occurrence = [int]$rule.occurrence } catch { $occurrence = 0 }
      if ([string]::IsNullOrWhiteSpace($find) -or [string]::IsNullOrWhiteSpace($column)) { continue }
      $value = Get-RecordValue $record $column
      $changed = Replace-TextEverywhere $doc $find ([string]$value) $occurrence
      if ($DebugMode) {
        $occLabel = "all"
        if ($occurrence -gt 0) { $occLabel = [string]$occurrence }
        $debug.Add([pscustomobject]@{ type = "manual"; find = $find; column = $column; value = $value; occurrence = $occLabel; changed = $changed }) | Out-Null
      }
    } catch {}
  }

  # 2) Automatyczne znaczniki w Wordzie. Wystarczy wpisac w szablonie np. {{Adres}}, {{Beneficjent}}, [[Adres]] albo <<Adres>>.
  # Dla szybkosci skanujemy je tylko wtedy, gdy dokument faktycznie ma znaki znacznikow.
  if (Document-MayHaveAutoMarkers $doc) {
    foreach ($p in @($record.PSObject.Properties)) {
      if ([string]$p.Name -eq "_record") { continue }
      $value = [string]$p.Value
      foreach ($token in @(Get-AutomaticMarkersForColumn ([string]$p.Name))) {
        $changed = Replace-TextEverywhere $doc ([string]$token) $value 0
        if ($DebugMode -and $changed -gt 0) { $debug.Add([pscustomobject]@{ type = "auto"; find = $token; column = [string]$p.Name; value = $value; changed = $changed }) | Out-Null }
      }
    }
  }

  return $debug
}

# Wiele prawdziwych szablonow NIE uzywa pol MERGEFIELD ani znacznikow {{...}} -
# maja zwykly tekst-placeholder (np. "XYZ") podswietlony na zolto w komorce
# tabeli, z etykieta w POPRZEDNIEJ komorce tego samego wiersza ("Uczestnik
# projektu:" | [XYZ]). PROBLEM: ten sam tekst placeholder ("XYZ") czesto
# powtarza sie w kilku roznych polach jednego dokumentu (np. i w imieniu, i w
# adresie) - wyszukiwanie po tekscie (Replace-AllTextMarkers) nie potrafi ich
# odroznic i podstawiloby ta sama wartosc wszedzie. Ta funkcja dziala inaczej:
# NIE szuka tekstu, tylko idzie po POZYCJI w tabeli (Word Tables/Rows/Cells),
# wiec dwa identyczne teksty w dwoch roznych komorkach sa naturalnie
# rozroznione przez to, w ktorej komorce/wierszu sie znajduja. Etykiety byly
# sprawdzone na prawdziwych szablonach (kolektory/kotly/pompy, kilka gmin) -
# sa zaskakujaco spojne w calej firmie.
# Same wartosci kandydatow celowo bez polskich znakow diakrytycznych (a nie
# a, l nie l itd.) - Normalize-Name i tak je usuwa przed porownaniem z
# prawdziwa nazwa kolumny w Excelu, a plik .ps1 bez BOM czytany przez
# Windows PowerShell 5.1 potrafi zle zinterpretowac wielobajtowe znaki UTF-8
# w literalach (blad parsowania), tak jak juz jest to omijane w reszcie tego
# skryptu (patrz komentarze bez diakrytykow).
$script:LabelFieldCandidates = @{
  'id_projektu'      = @('ID projektu','LP gmina','LP','ID')
  'id'                = @('ID projektu','LP gmina','LP','ID')
  'uczestnik_projektu' = @('Imie i Nazwisko','Inwestor','Beneficjent')
  'adres_inwestycji'  = @('Adres inwestycji','Adres')
  # Normalize-Name (patrz definicja powyzej w tym pliku) usuwa diakrytyki,
  # ktore w Unicode NFD rozkladaja sie na litere+znak (a,e,c,n,s,z,z), ale
  # polskie "l" (U+0142) NIE rozklada sie w ten sposob - zostaje i trafia do
  # tej samej reguly co inne nie-alfanumeryczne znaki (zamienia sie na "_").
  # Wiec "Działka"/"Dzialka" normalizuje sie do "dzia_ka", nie "dzialka" -
  # dotyczy to ZAROWNO kluczy etykiet (ponizej "dzia_ka_ewid_nr" obok
  # bardziej oczywistego "dzialka_ewid_nr"), JAK I kandydatow nazw kolumn
  # (ponizej "Dzia_ka" obok "Dzialka") - Get-RecordValue normalizuje obie
  # strony porownania tym samym mechanizmem.
  # "Numer dzia_ki"/"Dzia_ki" (forma mnoga, jak w prawdziwych tabelach typu
  # "Numer działki") dopisane obok wczesniejszych form "dzialki"/"Dzialka" -
  # bez tego dopasowanie do prawdziwej kolumny "Numer działki" nigdy sie nie
  # udawalo, bo hand-pisany ASCII kandydat "Numer dzialki" normalizuje sie
  # inaczej niz prawdziwe polskie "działki" (patrz komentarz o "l" powyzej).
  'dzialka_ewid_nr'   = @('Numer dzialki','Numer dzia_ki','Dzialka','Dzia_ka','Nr dzialki')
  'nr_dzialki'        = @('Numer dzialki','Numer dzia_ki','Dzialka','Dzia_ka','Nr dzialki')
  'dzia_ka_ewid_nr'   = @('Numer dzialki','Numer dzia_ki','Dzialka','Dzia_ka','Nr dzialki')
  'obreb_ewid_nr'     = @('Numer obrebu','Obreb','Nr obrebu')
  'nr_obrebu'         = @('Numer obrebu','Obreb','Nr obrebu')
  'gmina'             = @('Gmina')
}
$wdNoHighlight = 0

# Komorka bywa CZESCIOWO podswietlona - np. "XYZ, 97-360 Kamiensk" gdzie
# tylko "XYZ" jest zoltym placeholderem, a ", 97-360 Kamiensk" to stały tekst
# obok niego W TEJ SAMEJ komorce. Podmiana calego Range komorki (jak w
# pierwszej wersji tej funkcji) kasowala ten staly fragment. Ta funkcja
# znajduje NAJDLUZSZY spojny blok podswietlonych znakow w komorce i zwraca
# jego granice, zeby podmienic tylko ten fragment.
function Get-HighlightedSubRange($cellRange) {
  $chars = $cellRange.Characters
  $count = 0
  try { $count = [int]$chars.Count } catch { return $null }
  $bestStart = -1; $bestEnd = -1; $curStart = -1
  for ($i = 1; $i -le $count; $i++) {
    $hl = 0
    try { $hl = [int]$chars.Item($i).HighlightColorIndex } catch { $hl = 0 }
    if ($hl -ne $wdNoHighlight) {
      if ($curStart -eq -1) { $curStart = $i }
    } elseif ($curStart -ne -1) {
      if (($i - $curStart) -gt ($bestEnd - $bestStart)) { $bestStart = $curStart; $bestEnd = $i - 1 }
      $curStart = -1
    }
  }
  if ($curStart -ne -1 -and ($count - $curStart + 1) -gt ($bestEnd - $bestStart)) {
    $bestStart = $curStart; $bestEnd = $count
  }
  if ($bestStart -eq -1) { return $null }
  return @{ StartPos = $chars.Item($bestStart).Start; EndPos = $chars.Item($bestEnd).End }
}

function Fill-HighlightedTableCells($doc, $record, [System.Collections.Generic.List[object]]$fieldDebug) {
  $filledCount = 0
  # DWA PRZEBIEGI, celowo. Pierwsza wersja tej funkcji czytala I OD RAZU
  # modyfikowala komorki w JEDNYM przebiegu po $table.Rows - ale modyfikacja
  # tekstu w jednej komorce (inna dlugosc wartosci niz placeholdera) potrafi
  # uniewaznic dalsze wiersze tego samego obiektu Rows w Word COM, przez co
  # tylko PIERWSZY trafiony wiersz w ogole sie wypelnial, a reszta byla po
  # cichu pomijana. Dlatego: 1) najpierw TYLKO ZBIERAMY cele (bez zadnej
  # modyfikacji dokumentu), 2) potem podmieniamy od KONCA dokumentu do
  # poczatku (malejaco wg pozycji), zeby wczesniejsza podmiana nie przesuwala
  # pozycji tych, ktore jeszcze czekaja na podmiane.
  $targets = New-Object System.Collections.Generic.List[object]
  try {
    $tableCount = 0
    try { $tableCount = [int]$doc.Tables.Count } catch {}
    if ($DebugMode) { $fieldDebug.Add([pscustomobject]@{ type = "table-diag"; tableCount = $tableCount }) | Out-Null }
    foreach ($table in @($doc.Tables)) {
      # WAZNE: NIE uzywamy $table.Rows / $row.Cells. Gdy tabela ma
      # GDZIEKOLWIEK pionowo scalone komorki (czeste w tych szablonach - np.
      # wiersz z "ID:"), Word COM odmawia dostepu do WSZYSTKICH wierszy tej
      # tabeli przez Rows.Item(), nie tylko do tego scalonego ("Nie ma
      # dostepu do poszczegolnych wierszy z tej kolekcji, gdyz w tabeli sa
      # komorki powstale ze scalania w pionie") - potwierdzone empirycznie,
      # to nie da sie obejsc samym try/catch per-wiersz. $table.Range.Cells
      # (plaska kolekcja wszystkich komorek w kolejnosci czytania, czyli
      # wiersz po wierszu/lewo-prawo) dziala niezaleznie od scalania i
      # zachowuje ta sama sasiedztwo "etykieta tuz przed wartoscia".
      $cells = $null
      try { $cells = @($table.Range.Cells) } catch { continue }
      for ($i = 0; $i -lt $cells.Count; $i++) {
        $cell = $cells[$i]
        $highlightIdx = 0
        try { $highlightIdx = [int]$cell.Range.HighlightColorIndex } catch { continue }
        if ($highlightIdx -eq $wdNoHighlight) { continue }
        if ($DebugMode) { $fieldDebug.Add([pscustomobject]@{ type = "table-diag-cell"; i = $i; highlightIdx = $highlightIdx; text = ($cell.Range.Text -replace "[\r\a\t\f]", "") }) | Out-Null }
        if ($i -eq 0) { continue }

        $labelCell = $cells[$i - 1]
        $labelHighlight = 0
        try { $labelHighlight = [int]$labelCell.Range.HighlightColorIndex } catch {}
        if ($labelHighlight -ne $wdNoHighlight) { continue }

        $labelText = ""
        try { $labelText = ($labelCell.Range.Text -replace "[\r\a\t\f]", "").Trim().TrimEnd(":").Trim() } catch {}
        if ([string]::IsNullOrWhiteSpace($labelText)) { continue }
        $labelKey = Normalize-Name $labelText
        if ($DebugMode) { $fieldDebug.Add([pscustomobject]@{ type = "table-diag-label"; labelText = $labelText; labelKey = $labelKey; known = $script:LabelFieldCandidates.ContainsKey($labelKey) }) | Out-Null }
        if (-not $script:LabelFieldCandidates.ContainsKey($labelKey)) { continue }

        $value = ""
        foreach ($candidate in $script:LabelFieldCandidates[$labelKey]) {
          $value = Get-RecordValue $record $candidate
          if (-not [string]::IsNullOrWhiteSpace($value)) { break }
        }
        if ([string]::IsNullOrWhiteSpace($value)) { continue }

        try {
          $cellRange = $cell.Range
          $cellRange.End = $cellRange.End - 1
          $sub = Get-HighlightedSubRange $cellRange
          if ($null -eq $sub) { continue }
          $targets.Add([pscustomobject]@{ StartPos = $sub.StartPos; EndPos = $sub.EndPos; Value = [string]$value; Label = $labelText }) | Out-Null
        } catch {}
      }
    }
  } catch {}

  $sortedTargets = $targets | Sort-Object -Property StartPos -Descending
  foreach ($target in $sortedTargets) {
    try {
      $valueRange = $doc.Range($target.StartPos, $target.EndPos)
      # Czyscimy podswietlenie na CALYM oryginalnym bloku najpierw (nie
      # zmienia to dlugosci tekstu, wiec pozycje sa jeszcze wazne).
      $valueRange.HighlightColorIndex = $wdNoHighlight
      # Czasem caly fragment "XYZ, 97-360 Kamiensk" jest podswietlony jednym
      # blokiem, nie tylko sama nazwa placeholdera - a to co jest PO
      # pierwszym przecinku bywa stalym tekstem (kod pocztowy/gmina), dla
      # ktorego nie ma osobnej kolumny w Excelu. Podmieniamy wtedy TYLKO
      # czesc przed pierwszym przecinkiem, reszte zostawiamy (juz odznaczona
      # z podswietlenia powyzej).
      $originalText = $valueRange.Text
      $commaIdx = $originalText.IndexOf(",")
      if ($commaIdx -gt 0) {
        $valueRange.End = $valueRange.Start + $commaIdx
      }
      $valueRange.Text = $target.Value
      $filledCount++
      if ($DebugMode) { $fieldDebug.Add([pscustomobject]@{ type = "table-label"; label = $target.Label; value = $target.Value }) | Out-Null }
    } catch {}
  }
  return $filledCount
}

# Niektore szablony (potwierdzone na Opis_techniczny dla pomp ciepla) nie maja
# pol do wypelnienia w komorkach tabeli, tylko jako zolto podswietlone
# wielokropki WEWNATRZ zdania, np. "Powierzchnia ogrzewana budynku wynosi
# …… m²". Nie ma tu sasiedniej komorki-etykiety jak w Fill-HighlightedTableCells
# - jedynym sygnalem, co wstawic, jest tekst BEZPOSREDNIO PRZED wielokropkiem w
# tym samym zdaniu. To dopasowanie jest CELOWO waskie i recznie zweryfikowane
# (nie ogolny "zgadnij po dowolnym slowie przed kropkami") - w tych samych
# szablonach sa TEZ wielokropki, ktorych NIE wolno automatycznie wypelniac
# (numer egzemplarza "………/2", wybor wariantu tekstu przez projektanta typu
# "w proporcji …… / ……% ogrzewania grzejnikowego", stare zuzycie opalu, ktorego
# nie ma ani w Excelu ani w OZC) - te po prostu nie pasuja do zadnego wpisu
# ponizej i zostaja bez zmian, co jest bezpiecznym, oczekiwanym zachowaniem.
$script:NarrativeBlankKeywords = @(
  # Kolejnosc kandydatow ma znaczenie: kolumna z Excela ("Pow.") jest goly
  # numer bez jednostki, pasujacy do statycznego " m²" juz obecnego w
  # szablonie zaraz po tym wielokropku - wartosc wyciagnieta z dokumentu OZC
  # ("Powierzchnia ogrzewana" = "70 m²") juz ma jednostke w sobie, wiec
  # wstawiona zamiast golego numeru dawalaby "70 m² m²". Excel idzie wiec
  # pierwszy, OZC jest fallbackiem tylko gdy w Excelu nie ma tej kolumny.
  @{ keyword = 'powierzchnia ogrzewana'; candidates = @('Pow.', 'Powierzchnia ogrzewana', 'Powierzchnia') }
  # Realne zdanie w szablonie to "...rok JEGO budowy to ……" - samo "rok
  # budowy" jako szukany podciag NIE trafia (nie sa obok siebie). Samo
  # "budowy" wystarcza, bo okno tekstu przed wielokropkiem jest juz waskie
  # (patrz $lastEnd powyzej), wiec nie zlapie niczego z innego zdania.
  @{ keyword = 'budowy'; candidates = @('Rok budowy') }
)
$wdWithInTable = 12

function Fill-NarrativeBlanks($doc, $record, [System.Collections.Generic.List[object]]$fieldDebug) {
  $filledCount = 0
  $targets = New-Object System.Collections.Generic.List[object]
  try {
    $docEnd = 0
    try { $docEnd = [int]$doc.Content.End } catch { return 0 }
    $searchRange = $doc.Range(0, $docEnd)
    $guard = 0
    # Poprzedni wielokropek moze lezec w tym samym zdaniu, kilkanascie znakow
    # przed kolejnym (patrz przyklad w komentarzu funkcji) - okno "tekstu przed"
    # NIE moze wiec cofac sie dalej niz do konca POPRZEDNIEGO znalezionego
    # podswietlenia, bo inaczej slowo kluczowe pierwszego wielokropka
    # "przecieka" i falszywie dopasowuje sie tez do drugiego.
    $lastEnd = 0
    while ($guard -lt 500) {
      $guard++
      $find = $null
      try { $find = $searchRange.Find } catch { break }
      if ($null -eq $find) { break }
      try { $find.ClearFormatting() } catch {}
      $find.Highlight = $true
      $find.Text = ""
      $find.Forward = $true
      $find.Wrap = 0
      $found = $false
      try { $found = [bool]$find.Execute() } catch { break }
      if (-not $found) { break }

      $foundStart = $searchRange.Start
      $foundEnd = $searchRange.End
      if ($foundEnd -le $foundStart) { break }

      $inTable = $false
      try { $inTable = [bool]$searchRange.Information($wdWithInTable) } catch {}
      if (-not $inTable) {
        $precedingText = ""
        try {
          $windowStart = [Math]::Max($lastEnd, $foundStart - 140)
          $precedingRange = $doc.Range($windowStart, $foundStart)
          $precedingText = ($precedingRange.Text -replace "[\r\a\t\f\v]", " ").Trim()
        } catch {}
        $precedingLower = $precedingText.ToLowerInvariant()

        foreach ($rule in $script:NarrativeBlankKeywords) {
          if (-not $precedingLower.Contains($rule.keyword)) { continue }
          $value = ""
          foreach ($candidate in $rule.candidates) {
            $value = Get-RecordValue $record $candidate
            if (-not [string]::IsNullOrWhiteSpace($value)) { break }
          }
          if ([string]::IsNullOrWhiteSpace($value)) { continue }
          $targets.Add([pscustomobject]@{ StartPos = $foundStart; EndPos = $foundEnd; Value = [string]$value; Keyword = $rule.keyword }) | Out-Null
          if ($DebugMode) { $fieldDebug.Add([pscustomobject]@{ type = "narrative-match"; keyword = $rule.keyword; preceding = $precedingText; value = $value }) | Out-Null }
          break
        }
      }

      $lastEnd = $foundEnd
      $searchRange.Start = $foundEnd
      $searchRange.End = $docEnd
      if ($searchRange.Start -ge $docEnd) { break }
    }
  } catch {}

  $sortedTargets = $targets | Sort-Object -Property StartPos -Descending
  foreach ($target in $sortedTargets) {
    try {
      $valueRange = $doc.Range($target.StartPos, $target.EndPos)
      $valueRange.HighlightColorIndex = $wdNoHighlight
      $valueRange.Text = $target.Value
      $filledCount++
    } catch {}
  }
  return $filledCount
}

function Remove-MailMergeFromDocx([string]$src) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $tmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("scyzoryk_docx_" + [Guid]::NewGuid().ToString("N"))
  $extractDir = Join-Path $tmpRoot "docx"
  New-Item -ItemType Directory -Path $extractDir -Force | Out-Null
  Write-Event "template-clean" "Rozpakowuje kopie szablonu i usuwam polaczenie korespondencji seryjnej." ([pscustomobject]@{ temp = $tmpRoot })
  [System.IO.Compression.ZipFile]::ExtractToDirectory($src, $extractDir)

  $settingsPath = Join-Path $extractDir "word\settings.xml"
  if (Test-Path -LiteralPath $settingsPath) {
    $xml = [System.IO.File]::ReadAllText($settingsPath, [System.Text.Encoding]::UTF8)
    $before = $xml.Length
    $xml = [Regex]::Replace($xml, '<w:mailMerge[\s\S]*?</w:mailMerge>', '')
    [System.IO.File]::WriteAllText($settingsPath, $xml, [System.Text.Encoding]::UTF8)
    Write-Log "info" "Usunieto blok mailMerge z settings.xml." ([pscustomobject]@{ before = $before; after = $xml.Length })
  } else {
    Write-Log "warn" "Nie znaleziono settings.xml w szablonie."
  }

  # Word trzyma osobne relacje do zrodlowego pliku Excela w word/_rels/settings.xml.rels.
  # Jezeli ich nie usuniemy, Word potrafi zatrzymac eksport PDF i czekac w tle na niedostepny plik z dysku sieciowego.
  $settingsRelsPath = Join-Path $extractDir "word\_rels\settings.xml.rels"
  if (Test-Path -LiteralPath $settingsRelsPath) {
    try {
      $relsXml = [System.IO.File]::ReadAllText($settingsRelsPath, [System.Text.Encoding]::UTF8)
      if ($relsXml -match 'mailMergeSource') {
        Remove-Item -LiteralPath $settingsRelsPath -Force
        Write-Log "info" "Usunieto settings.xml.rels z relacjami mailMergeSource do starego Excela."
      }
    } catch {
      Write-Log "warn" "Nie udalo sie oczyscic settings.xml.rels." ([pscustomobject]@{ error = $_.Exception.Message })
    }
  }

  $cleanDocx = Join-Path $tmpRoot "template-clean.docx"
  if (Test-Path -LiteralPath $cleanDocx) { Remove-Item -LiteralPath $cleanDocx -Force }
  [System.IO.Compression.ZipFile]::CreateFromDirectory($extractDir, $cleanDocx)
  return [pscustomobject]@{ Path = $cleanDocx; Root = $tmpRoot }
}

if (-not (Test-Path -LiteralPath $TemplatePath)) { throw "Nie znaleziono szablonu Word: $TemplatePath" }
if (-not (Test-Path -LiteralPath $ExcelPath)) { throw "Nie znaleziono Excela: $ExcelPath" }
if (-not (Test-Path -LiteralPath $OutputDir)) { New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null }
if (-not [string]::IsNullOrWhiteSpace($LogPath)) { New-Item -ItemType File -Path $LogPath -Force | Out-Null }
if (-not [string]::IsNullOrWhiteSpace($DebugJsonPath)) { New-Item -ItemType File -Path $DebugJsonPath -Force | Out-Null }

$selectedRows = @()
if (-not [string]::IsNullOrWhiteSpace($RowsCsv)) {
  $selectedRows = $RowsCsv.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ }
}


$textReplacementRules = @()
if (-not [string]::IsNullOrWhiteSpace($ReplacementJson) -and (Test-Path -LiteralPath $ReplacementJson)) {
  try {
    $replacementPayload = Get-Content -LiteralPath $ReplacementJson -Raw -Encoding UTF8 | ConvertFrom-Json
    $textReplacementRules = @($replacementPayload.rules)
  } catch {
    Write-Log "warn" "Nie udalo sie odczytac zasad zamiany tekstu." ([pscustomobject]@{ error = $_.Exception.Message })
  }
}

$word = $null
$oldSecurity = $null
$doc = $null
$cleanInfo = $null
$created = New-Object System.Collections.Generic.List[object]
$errors = New-Object System.Collections.Generic.List[object]

try {
  Write-Event "start" "Rozpoczynam tworzenie PDF." ([pscustomobject]@{
    template = $TemplatePath
    excel = $ExcelPath
    output = $OutputDir
    sheet = $SheetName
    addressColumn = $AddressColumn
    visibleWord = [bool]$VisibleWord
    debugMode = [bool]$DebugMode
    textReplacementRules = @($textReplacementRules).Count
    filePrefix = $FilePrefix
  })

  Write-Event "word-start" "Uruchamiam Microsoft Word."
  # Audyt v1.1.7: automatyzacja dziesiatek rekordow z rzedu potrafi mocno
  # obciazyc CPU, utrudniajac normalna prace na tym samym komputerze w tym
  # czasie (zgloszone realnie przez uzytkownika). Zapamietujemy PID-y
  # WINWORD.EXE PRZED utworzeniem obiektu COM, zeby po jego starcie
  # jednoznacznie wskazac WLASNIE TEN nowy proces (nie jakis inny, juz
  # otwarty przez uzytkownika recznie Word).
  $priorWinwordPids = @(Get-CimInstance Win32_Process -Filter "Name='WINWORD.EXE'" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessId)
  $word = New-Object -ComObject Word.Application
  $script:word = $word
  $word.Visible = [bool]$VisibleWord
  $word.DisplayAlerts = 0

  # Obnizamy priorytet PROCESU WINWORD.EXE (nie calego skryptu - COM
  # aktywowany serwer Worda NIE dziedziczy priorytetu z PowerShella, DCOM
  # uruchamia go jako zupelnie osobny proces) do BelowNormal, zeby scheduler
  # Windows preferowal aktywne, pierwszoplanowe aplikacje uzytkownika -
  # generowanie PDF-ow potrwa odrobine dluzej, ale przestaje "dusic" reszte
  # komputera. Brak sukcesu (np. proces jeszcze nie zdazyl sie zarejestrowac)
  # nigdy nie przerywa generowania - to tylko optymalizacja, nie wymog.
  try {
    Start-Sleep -Milliseconds 300
    $newWinwordPid = Get-CimInstance Win32_Process -Filter "Name='WINWORD.EXE'" -ErrorAction SilentlyContinue |
      Where-Object { $priorWinwordPids -notcontains $_.ProcessId } |
      Select-Object -First 1 -ExpandProperty ProcessId
    if ($newWinwordPid) {
      $winwordProc = Get-Process -Id $newWinwordPid -ErrorAction SilentlyContinue
      if ($null -ne $winwordProc) {
        $winwordProc.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::BelowNormal
        Write-Log "info" "Obnizono priorytet procesu WINWORD.EXE do BelowNormal." ([pscustomobject]@{ pid = $newWinwordPid })
      }
    }
  } catch {
    Write-Log "warn" "Nie udalo sie obnizyc priorytetu WINWORD.EXE (nie blokuje generowania)." ([pscustomobject]@{ error = $_.Exception.Message })
  }
  try { $oldSecurity = $word.AutomationSecurity; $word.AutomationSecurity = 3 } catch {}
  try { $word.Options.UpdateLinksAtOpen = $false } catch {}
  try { $word.Options.ConfirmConversions = $false } catch {}
  try { $word.Options.SaveNormalPrompt = $false } catch {}
  try { $word.Options.BackgroundSave = $false } catch {}
  try { $word.Options.PrintBackground = $false } catch {}

  if (-not [string]::IsNullOrWhiteSpace($DataJson) -and (Test-Path -LiteralPath $DataJson)) {
    $payload = Get-Content -LiteralPath $DataJson -Raw -Encoding UTF8 | ConvertFrom-Json
    $records = @($payload.records)
    if ($records.Count -lt 1) { throw "Brak rekordow do wygenerowania." }
    Write-Event "start" "Wczytano rekordy do generowania." ([pscustomobject]@{ total = $records.Count })

    # Remove-MailMergeFromDocx wypisuje tez eventy JSON na stdout dla UI.
    # PowerShell dolacza kazdy output funkcji do zwracanej wartosci, wiec bez filtrowania
    # $cleanInfo stawalo sie tablica: [event JSON, obiekt {Path,Root}].
    # Wtedy przy $cleanInfo.Path / $cleanInfo.Root StrictMode rzucal blad: property Path/Root cannot be found.
    $cleanInfoOutput = @(Remove-MailMergeFromDocx $TemplatePath)
    $cleanInfo = $cleanInfoOutput | Where-Object {
      $null -ne $_ -and
      $_ -isnot [string] -and
      $null -ne $_.PSObject.Properties["Path"] -and
      $null -ne $_.PSObject.Properties["Root"]
    } | Select-Object -Last 1
    if ($null -eq $cleanInfo) {
      throw "Nie udalo sie przygotowac oczyszczonej kopii szablonu DOCX."
    }
    $wdExportFormatPDF = 17
    $total = $records.Count
    $index = 0

    foreach ($record in $records) {
      $index++
      $rowNumber = 0
      try { $rowNumber = [int](Get-RecordValue $record "_record") } catch {}
      if ($rowNumber -lt 1) { $rowNumber = $index }
      $mergedDoc = $null

      # Audyt v1.1.7 (zlapane realnie na produkcji, prawdziwy plik logu
      # uzytkownika): RPC_E_CALL_REJECTED (0x80010001, "Wywolanie zostalo
      # odrzucone przez wywolywanego") to DOBRZE ZNANY, PRZEJSCIOWY objaw
      # zajetego kanalu COM do Worda (Word akurat konczy poprzednia
      # operacje, np. malowanie ekranu po SaveAs2) - nie prawdziwy blad
      # danych rekordu. Zlapane realnie: pojedynczy odrzucony call na
      # jednym rekordzie ZRYWAL kanal COM na tyle, ze $word.Documents
      # zwracalo $null przez KOLEJNYCH 10 rekordow ("You cannot call a
      # method on a null-valued expression"), zanim kanal sam sie
      # odzyskal - 10 utraconych PDF-ow z jednej chwilowej "zajetosci"
      # Worda. Retry z krotkim opoznieniem (dajac Wordowi szanse dokonczyc,
      # co akurat robil) naprawia to bez zadnej realnej straty czasu -
      # w prawdziwym logu kanal sam wrocil do zycia w niecala sekunde.
      $maxAttempts = 3
      $attempt = 0
      $recordDone = $false
      while (-not $recordDone -and $attempt -lt $maxAttempts) {
        $attempt++
      try {
        $address = Get-RecordValue $record $AddressColumn
        if ([string]::IsNullOrWhiteSpace($address)) { $address = "rekord_$rowNumber" }
        $baseName = Safe-FileName (Join-PrefixAndAddress $FilePrefix $address)
        $pdfPath = Unique-Path $OutputDir $baseName ".pdf"

        Write-Event "record-start" "Tworze PDF $($index)/$($total): $($address)" ([pscustomobject]@{ current = $index; total = $total; row = $rowNumber; address = $address; target = $pdfPath })
        Write-Log "info" "Otwieram oczyszczony szablon dla rekordu." ([pscustomobject]@{ row = $rowNumber; cleanTemplate = $cleanInfo.Path })
        $mergedDoc = $word.Documents.Open($cleanInfo.Path, $false, $true, $false, "", "", $false, "", "", 0, 65001, [bool]$VisibleWord, $true)
        # Zaraz po Open() kolekcja Tables potrafi byc jeszcze pusta dla
        # dokumentow ze spisem tresci/polami (dokument nie skonczyl jeszcze
        # "ukladania sie") - potwierdzone: ten sam plik zapisany PO
        # Repaginate() mial poprawnie 2 tabele, a odczytany zaraz po Open()
        # (bez Repaginate) pokazywal 0. Wymuszamy przeliczenie ukladu PRZED
        # czytaniem Tables, nie tylko na koncu przed eksportem.
        try { $mergedDoc.Repaginate() } catch {}

        Write-Log "info" "Wypelniam podswietlone komorki tabeli wg etykiety." ([pscustomobject]@{ row = $rowNumber; address = $address })
        $tableFieldDebug = New-Object System.Collections.Generic.List[object]
        $tableFilledCount = Fill-HighlightedTableCells $mergedDoc $record $tableFieldDebug

        Write-Log "info" "Wypelniam podswietlone wielokropki w tresci zdan." ([pscustomobject]@{ row = $rowNumber; address = $address })
        $narrativeFieldDebug = New-Object System.Collections.Generic.List[object]
        $narrativeFilledCount = Fill-NarrativeBlanks $mergedDoc $record $narrativeFieldDebug

        Write-Log "info" "Podmieniam pola MERGEFIELD." ([pscustomobject]@{ row = $rowNumber; address = $address })
        $fieldDebug = Replace-AllMergeFields $mergedDoc $record
        $textDebug = Replace-AllTextMarkers $mergedDoc $record $textReplacementRules
        if ($DebugMode) {
          Write-Log "info" "Mapa podstawionych pol." ([pscustomobject]@{ row = $rowNumber; tableLabelFilled = $tableFilledCount; tableLabels = $tableFieldDebug; narrativeFilled = $narrativeFilledCount; narrativeLabels = $narrativeFieldDebug; fields = $fieldDebug; textMarkers = $textDebug })
          Write-JsonLine ([pscustomobject]@{ event = "field-map"; row = $rowNumber; address = $address; tableLabelFilled = $tableFilledCount; tableLabels = $tableFieldDebug; narrativeFilled = $narrativeFilledCount; narrativeLabels = $narrativeFieldDebug; fields = $fieldDebug; textMarkers = $textDebug })
        }

        # Nie aktualizujemy wszystkich pol Worda, bo spis tresci / PAGEREF potrafia mocno spowalniac albo zatrzymywac eksport.
        try { $mergedDoc.Repaginate() } catch {}

        Write-Event "export-start" "Eksportuje do PDF: $($address). To moze potrwac nawet kilka minut przy pierwszym pliku." ([pscustomobject]@{ current = $index; total = $total; row = $rowNumber; address = $address; pdf = $pdfPath })
        $exportStart = Get-Date

        # Najpierw zapisujemy roboczy DOCX. To pomaga Wordowi ustabilizowac dokument po podmianie pol
        # i daje plik diagnostyczny, jesli eksport PDF zatrzyma sie na Wordzie.
        $debugDocxPath = $null
        if ($DebugMode) {
          try {
            $debugDocxPath = [string]([System.IO.Path]::ChangeExtension([string]$pdfPath, ".debug.docx"))
            Write-Log "info" "Zapisuje roboczy DOCX przed PDF." ([pscustomobject]@{ row = $rowNumber; docx = $debugDocxPath })
            $formatDocx = [int]16
            # Bez [ref], bo na czesci instalacji Office/PowerShell [ref] opakowuje wartosc jako PSObject i Word wywala rzutowanie.
            $mergedDoc.SaveAs2([string]$debugDocxPath, $formatDocx)
          } catch {
            Write-Log "warn" "Nie udalo sie zapisac roboczego DOCX przed PDF." ([pscustomobject]@{ row = $rowNumber; error = $_.Exception.Message })
          }
        }

        # Uzywamy SaveAs2 do PDF jako glownej metody.
        # Poprawka: przekazujemy czysty string i int, bez [ref], bo u Ciebie [ref] powodowal blad:
        # "Nie można rzutować obiektu typu System.Management.Automation.PSObject na typ System.String".
        # Nie robimy juz automatycznego fallbacku do ExportAsFixedFormat, bo w logach wlasnie ten fallback wisial kilka minut.
        $formatPdf = [int]17
        $pdfPathString = [string]$pdfPath
        Write-Log "info" "Zapisuje PDF metoda SaveAs2 bez ref." ([pscustomobject]@{ row = $rowNumber; pdf = $pdfPathString })
        $mergedDoc.SaveAs2($pdfPathString, $formatPdf)
        $exportSeconds = [Math]::Round(((Get-Date) - $exportStart).TotalSeconds, 2)
        Write-Event "export-done" "PDF wyeksportowany: $($address)" ([pscustomobject]@{ current = $index; total = $total; row = $rowNumber; address = $address; file = [System.IO.Path]::GetFileName($pdfPath); seconds = $exportSeconds })
        $mergedDoc.Close($false)
        Release-ComObject $mergedDoc
        $mergedDoc = $null

        $created.Add([pscustomobject]@{
          row = $rowNumber
          address = $address
          file = [System.IO.Path]::GetFileName($pdfPath)
          path = $pdfPath
        }) | Out-Null
        Write-Event "record-done" "Gotowy PDF $($index)/$($total): $($address)" ([pscustomobject]@{ current = $index; total = $total; row = $rowNumber; address = $address; file = [System.IO.Path]::GetFileName($pdfPath) })
        $recordDone = $true
      } catch {
        $msg = $_.Exception.Message
        if ($null -ne $mergedDoc) { try { $mergedDoc.Close($false) } catch {}; Release-ComObject $mergedDoc; $mergedDoc = $null }

        # Kilka udokumentowanych HRESULT-ow oznaczajacych PRZEJSCIOWA
        # zajetosc/niedostepnosc serwera COM Worda (nie prawdziwy blad
        # danych rekordu), plus objawy WTORNE tego samego zerwania kanalu
        # (kolejne wywolania na obiekcie, ktory nagle stal sie null) - patrz
        # komentarz przy $maxAttempts wyzej.
        #   0x80010001 RPC_E_CALL_REJECTED         - wywolanie odrzucone
        #   0x8001010A RPC_E_SERVERCALL_RETRYLATER - serwer: "sprobuj pozniej"
        #   0x8001010B RPC_E_SERVERCALL_REJECTED   - jw., inny wariant
        #   0x800706BA RPC_S_SERVER_UNAVAILABLE    - serwer chwilowo niedostepny
        #   0x80080005 CO_E_SERVER_EXEC_FAILURE    - poprzedni WINWORD.EXE jeszcze nie zdazyl w pelni zakonczyc
        $isTransientComBusy = ($msg -match "0x80010001" -or $msg -match "0x8001010A" -or $msg -match "0x8001010B" -or $msg -match "0x800706BA" -or $msg -match "0x80080005" -or $msg -match "RPC_E_" -or $msg -match "null-valued expression")
        if ($isTransientComBusy -and $attempt -lt $maxAttempts) {
          Write-Log "warn" "Word byl chwilowo zajety (proba $attempt/$maxAttempts) - ponawiam rekord $rowNumber za $(1.5 * $attempt)s." ([pscustomobject]@{ row = $rowNumber; attempt = $attempt; error = $msg })
          Start-Sleep -Seconds (1.5 * $attempt)
          continue
        }

        $errors.Add([pscustomobject]@{ row = $rowNumber; message = $msg }) | Out-Null
        Write-Event "record-error" "Blad przy rekordzie $($rowNumber): $($msg)" ([pscustomobject]@{ current = $index; total = $total; row = $rowNumber; error = $msg })
        $recordDone = $true
      }
      }
    }
  } else {
    # Fallback based on Word built-in mail merge. Normally not used by this tool.
    Write-Event "template-open" "Otwieram oryginalny szablon w trybie korespondencji seryjnej."
    $doc = $word.Documents.Open($TemplatePath, $false, $true, $false, "", "", $false, "", "", 0, 65001, [bool]$VisibleWord, $true)

    $querySheet = $SheetName
    if ($querySheet.EndsWith('$')) { $querySheet = $querySheet.Substring(0, $querySheet.Length - 1) }
    $sql = "SELECT * FROM [$querySheet`$]"
    $connection = "Provider=Microsoft.ACE.OLEDB.12.0;User ID=Admin;Data Source=$ExcelPath;Mode=Read;Extended Properties=`"HDR=YES;IMEX=1;`";"

    Write-Event "datasource" "Podpinam Excela do korespondencji seryjnej." ([pscustomobject]@{ sheet = $querySheet })
    $doc.MailMerge.OpenDataSource($ExcelPath, $false, $true, $false, $false, "", "", $false, "", "", $connection, $sql, "", $false, 0)

    $mm = $doc.MailMerge
    $ds = $mm.DataSource
    $recordCount = [int]$ds.RecordCount
    if ($recordCount -lt 1) { throw "Excel nie zawiera rekordow do korespondencji seryjnej." }
    if ($selectedRows.Count -eq 0) { $selectedRows = 1..$recordCount }

    $wdSendToNewDocument = 0
    $wdExportFormatPDF = 17
    $total = $selectedRows.Count
    $index = 0

    foreach ($rowNumber in $selectedRows) {
      $index++
      if ($rowNumber -lt 1 -or $rowNumber -gt $recordCount) { continue }
      $merged = $null
      try {
        $ds.ActiveRecord = $rowNumber
        $address = ""
        try { $address = [string]$ds.DataFields.Item($AddressColumn).Value } catch {}
        if ([string]::IsNullOrWhiteSpace($address)) { $address = "rekord_$rowNumber" }
        $baseName = Safe-FileName (Join-PrefixAndAddress $FilePrefix $address)
        $pdfPath = Unique-Path $OutputDir $baseName ".pdf"
        Write-Event "record-start" "Tworze PDF $($index)/$($total): $($address)" ([pscustomobject]@{ current = $index; total = $total; row = $rowNumber; address = $address; target = $pdfPath })

        $ds.FirstRecord = $rowNumber
        $ds.LastRecord = $rowNumber
        $mm.Destination = $wdSendToNewDocument
        $mm.SuppressBlankLines = $true
        $mm.Execute($false)

        $merged = $word.ActiveDocument
        Write-Event "export-start" "Eksportuje do PDF: $($address). To moze potrwac nawet kilka minut przy pierwszym pliku." ([pscustomobject]@{ current = $index; total = $total; row = $rowNumber; address = $address; pdf = $pdfPath })
        $formatPdf = [int]17
        $pdfPathString = [string]$pdfPath
        Write-Log "info" "Zapisuje PDF metoda SaveAs2 bez ref." ([pscustomobject]@{ row = $rowNumber; pdf = $pdfPathString })
        $merged.SaveAs2($pdfPathString, $formatPdf)
        Write-Event "export-done" "PDF wyeksportowany: $($address)" ([pscustomobject]@{ current = $index; total = $total; row = $rowNumber; address = $address; file = [System.IO.Path]::GetFileName($pdfPath) })
        $merged.Close($false)
        Release-ComObject $merged
        $merged = $null

        $created.Add([pscustomobject]@{ row = $rowNumber; address = $address; file = [System.IO.Path]::GetFileName($pdfPath); path = $pdfPath }) | Out-Null
        Write-Event "record-done" "Gotowy PDF $($index)/$($total): $($address)" ([pscustomobject]@{ current = $index; total = $total; row = $rowNumber; address = $address; file = [System.IO.Path]::GetFileName($pdfPath) })
      } catch {
        $msg = $_.Exception.Message
        if ($null -ne $merged) { try { $merged.Close($false) } catch {}; Release-ComObject $merged }
        $errors.Add([pscustomobject]@{ row = $rowNumber; message = $msg }) | Out-Null
        Write-Event "record-error" "Blad przy rekordzie $($rowNumber): $($msg)" ([pscustomobject]@{ current = $index; total = $total; row = $rowNumber; error = $msg })
      }
    }
  }

  $ok = ($errors.Count -eq 0)
  $message = if ($ok) { "Zakonczono. Utworzono $($created.Count) PDF." } else { "Zakonczono z bledami. Utworzono $($created.Count) PDF, bledy: $($errors.Count)." }
  Write-Event "finish" $message ([pscustomobject]@{ total = ($created.Count + $errors.Count); createdCount = $created.Count; errorCount = $errors.Count })
  Write-JsonLine ([pscustomobject]@{
    ok = $ok
    message = $message
    created = $created
    errors = $errors
    outputDir = $OutputDir
    total = ($created.Count + $errors.Count)
    logPath = $LogPath
    debugJsonPath = $DebugJsonPath
  })
  if (-not $ok) { exit 2 }
} catch {
  $msg = $_.Exception.Message
  Write-Log "error" "Blad krytyczny: $($msg)" ([pscustomobject]@{ stack = $_.ScriptStackTrace })
  Write-Event "fatal" "Blad krytyczny: $($msg)" ([pscustomobject]@{ error = $msg })
  Write-JsonLine ([pscustomobject]@{
    ok = $false
    fatal = $true
    message = $msg
    created = $created
    errors = $errors
    outputDir = $OutputDir
    logPath = $LogPath
    debugJsonPath = $DebugJsonPath
  })
  exit 1
} finally {
  if ($null -ne $doc) { try { $doc.Close($false) } catch {}; Release-ComObject $doc }
  if ($null -ne $word) { if ($null -ne $oldSecurity) { try { $word.AutomationSecurity = $oldSecurity } catch {} }; try { $word.Quit() } catch {}; Release-ComObject $word }
  if ($null -ne $cleanInfo) {
    $cleanRootToRemove = $null
    try { $cleanRootToRemove = [string]$cleanInfo.Root } catch {}
    if (-not [string]::IsNullOrWhiteSpace($cleanRootToRemove)) {
      try { Remove-Item -LiteralPath $cleanRootToRemove -Recurse -Force -ErrorAction SilentlyContinue } catch {}
    }
  }
  try { [GC]::Collect(); [GC]::WaitForPendingFinalizers() } catch {}
}
