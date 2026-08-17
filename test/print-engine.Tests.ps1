# Testy Pester dla lib/printing/PrintEngine.psm1 (audyt 2026-08-14).
#
# Celuja DOKLADNIE w dwa mechanizmy, ktore padly na zywo w nocy 2026-08-13/14
# i nigdy nie byly pokryte prawdziwym testem behawioralnym (tylko wzorcami
# tekstowymi w test/group2-printing.test.js):
#   1. -ArgumentList z tablicy gubilo spacje w nazwach drukarek/sciezkach
#      (Sumatra/Ghostscript) - test odtwarza REALNY mechanizm Start-Process
#      (laczenie tablicy spacja w jeden command-line string) i dekoduje go
#      z powrotem przez prawdziwe Windows API CommandLineToArgvW.
#   2. Wait-ForPrintJobProgress zabijalo zadania, ktore w rzeczywistosci
#      konczyly sie sukcesem (PagesPrinted nie ruszalo sie na Flexi-archiwum2)
#      - test wymusza mockiem dokladnie ten scenariusz i sprawdza, ze funkcja
#      NIE zabija zadania po prostu dlatego, ze brak postepu.
#
# Uruchomienie: powershell -NoProfile -Command "Invoke-Pester -Path test/print-engine.Tests.ps1 -EnableExit"

$moduleRoot = Split-Path -Parent $PSScriptRoot
$modulePath = Join-Path $moduleRoot "lib\printing\PrintEngine.psm1"
Import-Module $modulePath -Force

# Dekoduje command-line string PRAWDZIWYM Windows API (nie wlasna, przyblizona
# implementacja) - to samo API, ktorego Windows uzywa do zbudowania argv[]
# dla kazdego nowego procesu. Zamiast zgadywac/stubowac SumatraPDF.exe,
# sprawdzamy dokladnie ten sam mechanizm, ktory realnie ucinal argumenty.
if (-not ("ScyzorykTest.Shell32" -as [type])) {
  # CharSet.Unicode jest KONIECZNY - bez jawnego okreslenia, .NET marshaluje
  # string parametr jako ANSI mimo ze funkcja to wariant "W" (szeroki znak),
  # co po cichu psuje CALY command-line string na wejsciu (zlapane empirycznie
  # przy pisaniu tego testu: argc wychodzilo 1 zamiast 5, a argv[0] byl
  # nieczytelnym smieciem).
  Add-Type -Namespace ScyzorykTest -Name Shell32 -MemberDefinition @"
[DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern IntPtr CommandLineToArgvW(string lpCmdLine, out int pNumArgs);
[DllImport("kernel32.dll")]
public static extern IntPtr LocalFree(IntPtr hMem);
"@
}

function ConvertTo-ArgvArray {
  param([string]$CommandLine)
  $argc = 0
  $argvPtr = [ScyzorykTest.Shell32]::CommandLineToArgvW($CommandLine, [ref]$argc)
  if ($argvPtr -eq [IntPtr]::Zero) { throw "CommandLineToArgvW zwrocilo NULL dla: $CommandLine" }
  try {
    $result = New-Object string[] $argc
    for ($i = 0; $i -lt $argc; $i++) {
      $strPtr = [System.Runtime.InteropServices.Marshal]::ReadIntPtr($argvPtr, $i * [IntPtr]::Size)
      $result[$i] = [System.Runtime.InteropServices.Marshal]::PtrToStringUni($strPtr)
    }
    return $result
  } finally {
    [void][ScyzorykTest.Shell32]::LocalFree($argvPtr)
  }
}

# Start-Process -ArgumentList <tablica> laczy elementy SPACJA w jeden
# command-line string (potwierdzone empirycznie 2026-08-13 przez podejrzenie
# prawdziwego okna bledu Sumatry) - odtwarzamy to tutaj, bez spawnowania
# zadnego procesu.
function ConvertTo-StartProcessCommandLine {
  param([string[]]$ArgumentList)
  return ($ArgumentList -join ' ')
}

Describe "New-SumatraPrintArgs - cytowanie argumentow ze spacjami (audyt 2026-08-13)" {
  It "nazwa drukarki ze spacjami przetrwa jako JEDEN argument argv, nie rozjezdza sie na spacji" {
    $printerName = "Brother HL-L8240CDW series Printer"
    $path = "C:\dane\Ul. Witkiewicza 12, Posada.pdf"
    $built = New-SumatraPrintArgs -path $path -targetPrinter $printerName
    $commandLine = ConvertTo-StartProcessCommandLine $built
    $argv = ConvertTo-ArgvArray $commandLine

    # Pester 3.4's "Should Contain" testuje ZAWARTOSC PLIKU (Get-Content), nie
    # przynaleznosc do tablicy - dla tablic uzywamy natywnego -contains.
    ($argv -contains $printerName) | Should Be $true
    ($argv -contains $path) | Should Be $true
    # Realny blad z nocy: "Couldn't open file '...test-sid_..._Adres'" -
    # sciezka ucieta na pierwszej spacji. Sprawdzamy explicite, ze ZADEN
    # fragment argv nie jest samym "Witkiewicza" (czesc sciezki po ucieciu).
    ($argv -contains "Witkiewicza") | Should Be $false
  }

  It "sciezka pliku z przecinkiem i spacjami (realna nazwa z drukarki-projektow) przetrwa jako jeden argument" {
    $path = "C:\merged\6d1b8c40 - Ul. Fredry 3A, Posada.pdf"
    $built = New-SumatraPrintArgs -path $path -targetPrinter "Zwykla Drukarka"
    $argv = ConvertTo-ArgvArray (ConvertTo-StartProcessCommandLine $built)
    ($argv -contains $path) | Should Be $true
  }

  It "drukarka bez spacji w nazwie dalej dziala poprawnie (brak regresji dla prostego przypadku)" {
    $built = New-SumatraPrintArgs -path "C:\a.pdf" -targetPrinter "HP1"
    $argv = ConvertTo-ArgvArray (ConvertTo-StartProcessCommandLine $built)
    ($argv -contains "HP1") | Should Be $true
    ($argv -contains "C:\a.pdf") | Should Be $true
  }
}

Describe "New-GhostscriptPrintArgs - cytowanie argumentow ze spacjami (audyt 2026-08-13)" {
  It "nazwa drukarki ze spacjami w -sOutputFile=%printer%... przetrwa jako jeden argument" {
    $printerName = "Brother HL-L8240CDW series Printer"
    $path = "C:\dane\Ul. Witkiewicza 12, Posada.pdf"
    $built = New-GhostscriptPrintArgs -path $path -targetPrinter $printerName
    $argv = ConvertTo-ArgvArray (ConvertTo-StartProcessCommandLine $built)

    ($argv -contains "-sOutputFile=%printer%$printerName") | Should Be $true
    ($argv -contains $path) | Should Be $true
  }

  It "nie wlacza -dNOSAFER (audyt bezpieczenstwa - tresc PDF-a nie moze dostac pelnego dostepu do plikow)" {
    $built = New-GhostscriptPrintArgs -path "C:\a.pdf" -targetPrinter "HP1"
    ($built -contains "-dNOSAFER") | Should Be $false
  }
}

Describe "Wait-ForPrintJobProgress - decyzje zabij/nie-zabij (audyt 2026-08-13, Flexi-archiwum2)" {

  function New-TestProcess {
    # Realny, dlugo dzialajacy proces (do testow "wciaz zywy, czekamy") -
    # $proc.HasExited musi byc realna wlasciwoscia System.Diagnostics.Process,
    # nie da sie tego podrobic fake obiektem przy typowanym parametrze funkcji.
    return Start-Process -FilePath "powershell.exe" -ArgumentList "-NoProfile", "-Command", "Start-Sleep -Seconds 30" -PassThru -WindowStyle Hidden
  }

  It "zadanie pojawia sie w kolejce, PagesPrinted zostaje 0 - zwraca TRUE od razu, nie czeka na cala pule czasu" {
    $proc = New-TestProcess
    try {
      Mock Get-PrintJob { return @([pscustomobject]@{ Id = 999; PagesPrinted = 0 }) } -ModuleName PrintEngine

      $before = New-Object 'System.Collections.Generic.HashSet[int]'
      $sw = [System.Diagnostics.Stopwatch]::StartNew()
      $result = Wait-ForPrintJobProgress -proc $proc -targetPrinter "Flexi-archiwum2" -jobIdsBeforeStart $before -engineName "Test" -HardDeadlineSeconds 8
      $sw.Stop()

      $result | Should Be $true
      # Nie powinno czekac na pelne 8s - zadanie zostaje uznane za sukces
      # przy PIERWSZYM odpytaniu kolejki.
      ($sw.Elapsed.TotalSeconds -lt 4) | Should Be $true
    } finally {
      try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
    }
  }

  It "zadne zadanie nigdy sie nie pojawia - zwraca FALSE po limicie czasu i zabija proces" {
    $proc = New-TestProcess
    try {
      Mock Get-PrintJob { return @() } -ModuleName PrintEngine
      Mock Stop-Process { } -ModuleName PrintEngine

      $before = New-Object 'System.Collections.Generic.HashSet[int]'
      $result = Wait-ForPrintJobProgress -proc $proc -targetPrinter "TestPrinter" -jobIdsBeforeStart $before -engineName "Test" -HardDeadlineSeconds 2

      $result | Should Be $false
      Assert-MockCalled Stop-Process -ModuleName PrintEngine -Times 1
    } finally {
      try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
    }
  }

  It "sledzenie niedostepne (brak drukarki) - FALSE od razu, bez czekania" {
    $proc = New-TestProcess
    try {
      Mock Stop-Process { } -ModuleName PrintEngine
      $sw = [System.Diagnostics.Stopwatch]::StartNew()
      $result = Wait-ForPrintJobProgress -proc $proc -targetPrinter "" -jobIdsBeforeStart $null -engineName "Test" -HardDeadlineSeconds 30
      $sw.Stop()

      $result | Should Be $false
      ($sw.Elapsed.TotalSeconds -lt 3) | Should Be $true
      Assert-MockCalled Stop-Process -ModuleName PrintEngine -Times 1
    } finally {
      try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
    }
  }

  It "proces konczy sie sam kodem 0 zanim dojdzie do odpytywania kolejki - TRUE" {
    $proc = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "exit 0" -PassThru -WindowStyle Hidden
    $proc.WaitForExit(5000) | Out-Null

    Mock Get-PrintJob { return @() } -ModuleName PrintEngine

    $before = New-Object 'System.Collections.Generic.HashSet[int]'
    $result = Wait-ForPrintJobProgress -proc $proc -targetPrinter "TestPrinter" -jobIdsBeforeStart $before -engineName "Test" -HardDeadlineSeconds 5

    $result | Should Be $true
  }
}
