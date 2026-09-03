param(
  [Parameter(Mandatory=$true)][string]$InputJson,
  [Parameter(Mandatory=$true)][string]$OutputJson
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}

function Decode-Utf8Base64 {
  param([Parameter(Mandatory=$true)][string]$Value)
  return [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Value))
}

function Write-Result {
  param($obj)
  $json = $obj | ConvertTo-Json -Depth 20
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($OutputJson, $json, $utf8NoBom)
}

function Get-ErrorMessage {
  param($err)
  $msg = "Blad PowerShell."
  try {
    if ($err -and $err.Exception -and $err.Exception.Message) { $msg = [string]$err.Exception.Message }
  } catch {}
  try {
    if ($err -and $err.InvocationInfo -and $err.InvocationInfo.ScriptLineNumber) {
      $msg = $msg + " Linia: " + [string]$err.InvocationInfo.ScriptLineNumber
    }
  } catch {}
  return $msg
}

function Invoke-ReplaceInRange {
  param(
    $Range,
    [Parameter(Mandatory=$true)][string]$FindText,
    [Parameter(Mandatory=$true)][AllowEmptyString()][string]$ReplaceText,
    [bool]$Wildcards = $false
  )

  if ($null -eq $Range) { return $false }

  $find = $null
  try { $find = $Range.Find } catch { return $false }
  if ($null -eq $find) { return $false }

  try { [void]$find.ClearFormatting() } catch {}
  try {
    $replacement = $find.Replacement
    if ($null -ne $replacement) { [void]$replacement.ClearFormatting() }
  } catch {}

  try {
    $find.Text = $FindText
    try {
      $replacement = $find.Replacement
      if ($null -ne $replacement) { $replacement.Text = $ReplaceText }
    } catch {}
    $find.MatchCase = $false
    $find.MatchWholeWord = $false
    $find.MatchWildcards = $Wildcards
    $find.Forward = $true
    $find.Wrap = 1
    $find.Format = $false
    [void]$find.Execute($FindText, $false, $false, $Wildcards, $false, $false, $true, 1, $false, $ReplaceText, 2)
    return $true
  } catch {
    return $false
  }
}

function Replace-InContent {
  param(
    [Parameter(Mandatory=$true)]$Doc,
    [Parameter(Mandatory=$true)][string]$FindText,
    [Parameter(Mandatory=$true)][AllowEmptyString()][string]$ReplaceText,
    [bool]$Wildcards = $false
  )
  if ($null -eq $Doc) { return $false }
  $range = $null
  try {
    if ($null -ne $Doc.Content) { $range = $Doc.Content.Duplicate }
  } catch { $range = $null }
  return Invoke-ReplaceInRange -Range $range -FindText $FindText -ReplaceText $ReplaceText -Wildcards $Wildcards
}

function Replace-InAllStories {
  param(
    [Parameter(Mandatory=$true)]$Doc,
    [Parameter(Mandatory=$true)][string]$FindText,
    [Parameter(Mandatory=$true)][AllowEmptyString()][string]$ReplaceText,
    [bool]$Wildcards = $false
  )
  if ($null -eq $Doc) { return }

  $didAnything = $false
  $stories = $null
  try { $stories = $Doc.StoryRanges } catch { $stories = $null }

  if ($null -ne $stories) {
    $count = 0
    try { $count = [int]$stories.Count } catch { $count = 0 }
    if ($count -gt 0) {
      for ($i = 1; $i -le $count; $i++) {
        $story = $null
        try { $story = $stories.Item($i) } catch { $story = $null }
        $guard = 0
        while ($null -ne $story -and $guard -lt 80) {
          $range = $null
          try { $range = $story.Duplicate } catch { $range = $story }
          [void](Invoke-ReplaceInRange -Range $range -FindText $FindText -ReplaceText $ReplaceText -Wildcards $Wildcards)
          $didAnything = $true
          $next = $null
          try { $next = $story.NextStoryRange } catch { $next = $null }
          $story = $next
          $guard = $guard + 1
        }
      }
    }
  }

  # Fallback na glowna tresc dokumentu. To lapie zwykle tabele WM,
  # gdy Word/COM nie odda kolekcji StoryRanges tak jak oczekujemy.
  [void](Replace-InContent -Doc $Doc -FindText $FindText -ReplaceText $ReplaceText -Wildcards $Wildcards)

  # Dodatkowo przejdz po ksztaltach/polach tekstowych, bo czesc wzorow Worda
  # trzyma daty poza glowna trescia dokumentu.
  try {
    $sections = $Doc.Sections
    if ($null -ne $sections) {
      for ($s = 1; $s -le [int]$sections.Count; $s++) {
        $section = $sections.Item($s)
        foreach ($hfCollectionName in @('Headers', 'Footers')) {
          $hfCollection = $null
          try {
            if ($hfCollectionName -eq 'Headers') { $hfCollection = $section.Headers }
            elseif ($hfCollectionName -eq 'Footers') { $hfCollection = $section.Footers }
          } catch { $hfCollection = $null }
          if ($null -ne $hfCollection) {
            for ($h = 1; $h -le [int]$hfCollection.Count; $h++) {
              $hf = $hfCollection.Item($h)
              if ($null -ne $hf -and $null -ne $hf.Range) {
                [void](Invoke-ReplaceInRange -Range $hf.Range -FindText $FindText -ReplaceText $ReplaceText -Wildcards $Wildcards)
              }
              $shapes = $null
              try { $shapes = $hf.Shapes } catch { $shapes = $null }
              if ($null -ne $shapes) {
                for ($k = 1; $k -le [int]$shapes.Count; $k++) {
                  $shape = $shapes.Item($k)
                  $textRange = $null
                  try {
                    if ($shape.TextFrame.HasText -ne 0) { $textRange = $shape.TextFrame.TextRange }
                  } catch { $textRange = $null }
                  if ($null -ne $textRange) {
                    [void](Invoke-ReplaceInRange -Range $textRange -FindText $FindText -ReplaceText $ReplaceText -Wildcards $Wildcards)
                  }
                }
              }
            }
          }
        }
      }
    }
  } catch {}

  try {
    $shapes = $Doc.Shapes
    if ($null -ne $shapes) {
      for ($k = 1; $k -le [int]$shapes.Count; $k++) {
        $shape = $shapes.Item($k)
        $textRange = $null
        try {
          if ($shape.TextFrame.HasText -ne 0) { $textRange = $shape.TextFrame.TextRange }
        } catch { $textRange = $null }
        if ($null -ne $textRange) {
          [void](Invoke-ReplaceInRange -Range $textRange -FindText $FindText -ReplaceText $ReplaceText -Wildcards $Wildcards)
        }
      }
    }
  } catch {}
}


function Add-DateTextsFromRange {
  param(
    [Parameter(Mandatory=$true)]$Set,
    $Range
  )
  if ($null -eq $Range) { return }
  $text = $null
  try { $text = [string]$Range.Text } catch { $text = $null }
  if ([string]::IsNullOrWhiteSpace($text)) { return }
  try {
    $matches = [System.Text.RegularExpressions.Regex]::Matches($text, '(?<!\d)([0-3]?\d[\.\-/][01]?\d[\.\-/](?:19|20)\d{2})(?!\d)')
    foreach ($m in $matches) {
      if ($null -ne $m -and -not [string]::IsNullOrWhiteSpace($m.Value)) { [void]$Set.Add([string]$m.Value) }
    }
  } catch {}
}

function Collect-DateTexts {
  param([Parameter(Mandatory=$true)]$Doc)
  $set = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  if ($null -eq $Doc) { return @() }

  try { Add-DateTextsFromRange -Set $set -Range $Doc.Content } catch {}

  # StoryRanges obejmuja glowny tekst, naglowki, stopki, komentarze itp.
  try {
    $stories = $Doc.StoryRanges
    if ($null -ne $stories) {
      for ($i = 1; $i -le [int]$stories.Count; $i++) {
        $story = $null
        try { $story = $stories.Item($i) } catch { $story = $null }
        $guard = 0
        while ($null -ne $story -and $guard -lt 100) {
          Add-DateTextsFromRange -Set $set -Range $story
          $next = $null
          try { $next = $story.NextStoryRange } catch { $next = $null }
          $story = $next
          $guard = $guard + 1
        }
      }
    }
  } catch {}

  # Jawnie przejdz po tabelach, bo WM-y sa praktycznie calymi tabelami.
  try {
    $tables = $Doc.Tables
    if ($null -ne $tables) {
      for ($t = 1; $t -le [int]$tables.Count; $t++) {
        $table = $tables.Item($t)
        if ($null -ne $table) { Add-DateTextsFromRange -Set $set -Range $table.Range }
      }
    }
  } catch {}

  # Pola tekstowe i ksztalty w glownym dokumencie.
  try {
    $shapes = $Doc.Shapes
    if ($null -ne $shapes) {
      for ($k = 1; $k -le [int]$shapes.Count; $k++) {
        $shape = $shapes.Item($k)
        $textRange = $null
        try { if ($shape.TextFrame.HasText -ne 0) { $textRange = $shape.TextFrame.TextRange } } catch { $textRange = $null }
        Add-DateTextsFromRange -Set $set -Range $textRange
      }
    }
  } catch {}

  # Pola tekstowe w naglowkach i stopkach.
  try {
    $sections = $Doc.Sections
    if ($null -ne $sections) {
      for ($s = 1; $s -le [int]$sections.Count; $s++) {
        $section = $sections.Item($s)
        foreach ($hfCollectionName in @('Headers', 'Footers')) {
          $hfCollection = $null
          try {
            if ($hfCollectionName -eq 'Headers') { $hfCollection = $section.Headers }
            elseif ($hfCollectionName -eq 'Footers') { $hfCollection = $section.Footers }
          } catch { $hfCollection = $null }
          if ($null -ne $hfCollection) {
            for ($h = 1; $h -le [int]$hfCollection.Count; $h++) {
              $hf = $hfCollection.Item($h)
              if ($null -ne $hf) { Add-DateTextsFromRange -Set $set -Range $hf.Range }
              $shapes = $null
              try { $shapes = $hf.Shapes } catch { $shapes = $null }
              if ($null -ne $shapes) {
                for ($k = 1; $k -le [int]$shapes.Count; $k++) {
                  $shape = $shapes.Item($k)
                  $textRange = $null
                  try { if ($shape.TextFrame.HasText -ne 0) { $textRange = $shape.TextFrame.TextRange } } catch { $textRange = $null }
                  Add-DateTextsFromRange -Set $set -Range $textRange
                }
              }
            }
          }
        }
      }
    }
  } catch {}

  $out = New-Object System.Collections.Generic.List[string]
  foreach ($d in $set) { [void]$out.Add([string]$d) }
  return $out.ToArray()
}

function Replace-AllDates {
  param(
    [Parameter(Mandatory=$true)]$Doc,
    [Parameter(Mandatory=$true)][string]$DateText
  )
  # Zwraca liste faktycznie znalezionych/podmienionych dat (stara -> nowa),
  # zeby wywolujacy (server.js, potem UI) mogl to pokazac uzytkownikowi PRZED
  # wyslaniem dokumentu dalej. Ta funkcja nadal podmienia KAZDA znaleziona
  # date w calym dokumencie na jedna, wspolna wartosc (audyt v1.0.4, P0-3) -
  # bez realnego szablonu WM nie da sie bezpiecznie zgadnac, ktora POJEDYNCZA
  # data (np. "data dokumentacji powykonawczej") powinna byc jedynym celem,
  # wiec zamiast zgadywac oznaczenie pola, dodajemy jawna widocznosc tego, co
  # zostalo zmienione, zeby czlowiek mogl to zlapac przed wyslaniem dalej.
  $replacements = New-Object System.Collections.Generic.List[object]
  if ($null -eq $Doc) { return $replacements }
  $newDate = [string]$DateText
  if ([string]::IsNullOrWhiteSpace($newDate)) { return $replacements }

  # Najpierw zbierz widoczne daty z dokumentu i zamieniaj je literalnie.
  # To jest pewniejsze niz sam Word wildcard, bo daty w WM-ach siedza w tabelach.
  $dates = Collect-DateTexts -Doc $Doc
  foreach ($oldDate in $dates) {
    if ([string]::IsNullOrWhiteSpace($oldDate)) { continue }
    if ($oldDate -eq $newDate) { continue }
    [void](Replace-InAllStories -Doc $Doc -FindText $oldDate -ReplaceText $newDate -Wildcards $false)
    $replacements.Add([pscustomobject]@{ from = $oldDate; to = $newDate }) | Out-Null
  }

  # Fallback: kilka wzorow wildcard dla dokumentow z nietypowa data.
  foreach ($pattern in @(
    '[0-9][0-9].[0-9][0-9].[0-9][0-9][0-9][0-9]',
    '[0-9]{2}.[0-9]{2}.[0-9]{4}',
    '[0-9]{1,2}.[0-9]{1,2}.[0-9]{4}',
    '[0-9]{2}/[0-9]{2}/[0-9]{4}',
    '[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}'
  )) {
    [void](Replace-InAllStories -Doc $Doc -FindText $pattern -ReplaceText $newDate -Wildcards $true)
  }

  return $replacements
}

function Delete-FromMarkerToEnd {
  param(
    [Parameter(Mandatory=$true)]$Doc,
    [Parameter(Mandatory=$true)][string]$Marker
  )
  # Zwraca obiekt (nie juz sam bool) z licznikiem znakow i podgladem tego, co
  # zostalo usuniete - od znalezionego markera az do konca dokumentu, bez
  # drugiej granicy (audyt v1.0.4, P0-4). Bez realnego szablonu WM nie da sie
  # bezpiecznie zgadnac poprawnego drugiego markera (gdzie sekcja akceptacyjna
  # faktycznie sie konczy) - wiec zamiast zgadywac, dodajemy widocznosc: ile
  # tekstu i jaki fragment zostal usuniety, zeby czlowiek mogl to ocenic przed
  # wyslaniem dokumentu dalej.
  $noop = [pscustomobject]@{ deleted = $false; charCount = 0; preview = '' }
  if ($null -eq $Doc) { return $noop }

  $content = $null
  try { $content = $Doc.Content } catch { $content = $null }
  if ($null -eq $content) { return $noop }

  $range = $null
  try { $range = $content.Duplicate } catch { $range = $content }
  if ($null -eq $range) { return $noop }

  $find = $null
  try { $find = $range.Find } catch { $find = $null }
  if ($null -eq $find) { return $noop }

  try { [void]$find.ClearFormatting() } catch {}
  try {
    $find.Text = $Marker
    $find.MatchCase = $false
    $find.MatchWholeWord = $false
    $find.MatchWildcards = $false
    $find.Forward = $true
    $find.Wrap = 0
    $found = $find.Execute()
    if ($found) {
      $start = $range.Start
      $end = $content.End
      if ($null -ne $start -and $null -ne $end -and $end -gt $start) {
        $deleteRange = $Doc.Range($start, $end)
        $charCount = 0
        $preview = ''
        if ($null -ne $deleteRange) {
          try { $charCount = [int]$deleteRange.Characters.Count } catch { $charCount = 0 }
          try {
            $rawPreview = [string]$deleteRange.Text
            $preview = $rawPreview.Substring(0, [Math]::Min(200, $rawPreview.Length)) -replace '[\r\v\f]', ' '
          } catch { $preview = '' }
          [void]$deleteRange.Delete()
        }
        return [pscustomobject]@{ deleted = $true; charCount = $charCount; preview = $preview.Trim() }
      }
      return [pscustomobject]@{ deleted = $true; charCount = 0; preview = '' }
    }
  } catch {
    return $noop
  }
  return $noop
}

function Convert-ToPowykonawczy {
  param(
    [Parameter(Mandatory=$true)]$Doc,
    [Parameter(Mandatory=$true)][string]$DateText
  )

  if ($null -eq $Doc) { throw "Word nie otworzyl dokumentu DOCX." }

  $TITLE1 = Decode-Utf8Base64 "V25pb3NlayBvIHphdHdpZXJkemVuaWUgTWF0ZXJpYcWCw7N3IC8gVXJ6xIVkemXFhA=="
  $TITLE2 = Decode-Utf8Base64 "V25pb3NlayBvIHphdHdpZXJkemVuaWUgTWF0ZXJpYcWCw7N3L1VyesSFZHplxYQ="
  $TITLE3 = Decode-Utf8Base64 "V25pb3NlayBvIHphdHdpZXJkemVuaWUgTWF0ZXJpYcWCw7N3IGkgVXJ6xIVkemXFhA=="
  $POW = Decode-Utf8Base64 "RG9rdW1lbnRhY2phIFBvd3lrb25hd2N6YQ=="
  $UWAGI_ND = Decode-Utf8Base64 "VXdhZ2k6IE5pZSBkb3R5Y3p5"
  $WBUD = Decode-Utf8Base64 "V2J1ZG93YW5vIHBvbmnFvHN6ZSBtYXRlcmlhxYJ5L3VyesSFZHplbmlh"
  $UWAGI = Decode-Utf8Base64 "VXdhZ2k6"
  $ND = Decode-Utf8Base64 "TmllIGRvdHljenk="
  $WN1 = Decode-Utf8Base64 "d25pb3NrdWrEmSBvIHpnb2TEmSBuYSB6YW3Ds3dpZW5pZSB3L3cgTWF0ZXJpYcWCw7N3"
  $WN2 = Decode-Utf8Base64 "d25pb3NrdWplIG8gemdvZMSZIG5hIHphbcOzd2llbmllIHcvdyBNYXRlcmlhxYLDs3c="
  $WN3 = Decode-Utf8Base64 "d25pb3NrdWrEmSBvIHpnb2TEmSBuYSB6YW3Ds3dpZW5pZSB3L3cgTWF0ZXJpYcWCw7N3ICA="
  $MARK1 = Decode-Utf8Base64 "WkFUV0lFUkRaQU0gLyBaQVRXSUVSRFpBTSB6IFVXQUdBTUkgLyBPRFJaVUNBTSo="
  $MARK2 = Decode-Utf8Base64 "WkFUV0lFUkRaQU0gLyBaQVRXSUVSRFpBTSB6IFVXQUdBTUkgLyBPRFJaVUNBTQ=="
  $MARK3 = Decode-Utf8Base64 "U3R3aWVyZHphbSwgacW8IHcvdw=="

  # Replace-InAllStories (nie Replace-InContent) - $Doc.Content obejmuje TYLKO
  # glowny tekst dokumentu, nie naglowki/stopki (osobne StoryRanges w Word COM).
  # Wczesniej tytul zmienial sie w tresci, ale stopka nadal pokazywala stary
  # "Wniosek o zatwierdzenie Materialow/Urzadzen" - zauwazone realnie przez
  # uzytkownika, bo tresc gotowego PDF-a byla niezgodna z jego stopka.
  # Replace-InAllStories to dokladnie ta sama funkcja, ktorej Replace-AllDates
  # nizej juz uzywa do dat - tam stopka zawsze dzialala poprawnie.
  Replace-InAllStories -Doc $Doc -FindText $TITLE1 -ReplaceText $POW | Out-Null
  Replace-InAllStories -Doc $Doc -FindText $TITLE2 -ReplaceText $POW | Out-Null
  Replace-InAllStories -Doc $Doc -FindText $TITLE3 -ReplaceText $POW | Out-Null

  Replace-InContent -Doc $Doc -FindText $UWAGI_ND -ReplaceText $WBUD | Out-Null
  Replace-InContent -Doc $Doc -FindText $UWAGI -ReplaceText $WBUD | Out-Null
  Replace-InContent -Doc $Doc -FindText $ND -ReplaceText "" | Out-Null
  Replace-InContent -Doc $Doc -FindText $WN1 -ReplaceText "" | Out-Null
  Replace-InContent -Doc $Doc -FindText $WN2 -ReplaceText "" | Out-Null
  Replace-InContent -Doc $Doc -FindText $WN3 -ReplaceText "" | Out-Null

  $deletion = Delete-FromMarkerToEnd -Doc $Doc -Marker $MARK1
  if (-not $deletion.deleted) { $deletion = Delete-FromMarkerToEnd -Doc $Doc -Marker $MARK2 }
  if (-not $deletion.deleted) { $deletion = Delete-FromMarkerToEnd -Doc $Doc -Marker $MARK3 }

  $dateReplacements = Replace-AllDates -Doc $Doc -DateText $DateText

  return [pscustomobject]@{
    deletedSection = $deletion.deleted
    deletedCharCount = $deletion.charCount
    deletedPreview = $deletion.preview
    dateReplacements = @($dateReplacements)
  }
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
    $word.Visible = [bool]$config.visibleWord
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
      # PRZEJSCIOWA zajetosc/niedostepnosc serwera COM Worda - pojedynczy
      # odrzucony call potrafi zerwac kanal na tyle, ze KOLEJNE pliki w tej
      # samej petli tez zawodza, zanim kanal sam sie odzyska. Retry z
      # krotkim opoznieniem naprawia to bez realnej straty czasu.
      $maxAttempts = 3
      $attempt = 0
      $itemDone = $false
      while (-not $itemDone -and $attempt -lt $maxAttempts) {
        $attempt++
      try {
        $inputPath = [string]$item.inputPath
        $pdfPath = [string]$item.pdfPath
        $docxPath = [string]$item.docxPath
        if (-not (Test-Path -LiteralPath $inputPath)) { throw "Nie znaleziono pliku DOCX: $inputPath" }

        $doc = $word.Documents.Open($inputPath, $false, $true, $false, "", "", $false, "", "", 0, 65001, [bool]$config.visibleWord, $true)
        if ($null -eq $doc) { throw "Word nie otworzyl pliku: $inputPath" }

        $changeReport = Convert-ToPowykonawczy -Doc $doc -DateText ([string]$config.dateText)

        # savedDocxPath (nie od razu $null) - dopiero po udanym SaveAs2 wiemy, ze
        # plik DOCX faktycznie powstal, wiec wynik moze go bezpiecznie zglosic
        # wywolujacemu (server.js dolacza go do pobrania obok PDF-a).
        $savedDocxPath = $null
        if ([bool]$config.saveDocx) {
          $formatDocx = 16
          $doc.SaveAs2($docxPath, $formatDocx)
          $savedDocxPath = $docxPath
        }
        $formatPdf = 17
        $doc.SaveAs2($pdfPath, $formatPdf)
        $doc.Close($false)
        $doc = $null
        $results.Add([pscustomobject]@{
          ok=$true; input=$inputPath; pdf=$pdfPath; file=[System.IO.Path]::GetFileName($pdfPath)
          docx=$savedDocxPath
          deletedSection=$changeReport.deletedSection; deletedCharCount=$changeReport.deletedCharCount
          deletedPreview=$changeReport.deletedPreview; dateReplacements=$changeReport.dateReplacements
        }) | Out-Null
        $itemDone = $true
      } catch {
        if ($null -ne $doc) {
          try { $doc.Close($false) } catch {}
          $doc = $null
        }
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
      try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($word) } catch {}
    }
    try { [GC]::Collect(); [GC]::WaitForPendingFinalizers() } catch {}
  }
  Write-Result ([pscustomobject]@{ ok=$true; results=$results })
} catch {
  Write-Result ([pscustomobject]@{ ok=$false; error=(Get-ErrorMessage $_) })
  exit 1
}
