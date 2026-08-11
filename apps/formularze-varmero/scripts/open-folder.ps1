# Otwiera folder w Eksploratorze i miga jego przyciskiem na pasku zadan.
#
# Zlapane realnie przez wlasciciela: samo spawn('explorer.exe', [path]) z
# Node (proces bez "praw pierwszego planu") otwiera okno GDZIES W TLE, bez
# zadnego potwierdzenia - wlasciciel klikal przycisk ~20 razy, bo nie
# widzial, ze cokolwiek sie stalo. DWIE proby wymuszenia okna na wierzch
# (SetForegroundWindow samo, potem z symulacja klawisza ALT + zwin/przywroc)
# zostaly przetestowane NA ZYWO i obie NIE zadzialaly - Windows na tej
# maszynie (prawdopodobnie polityka grupowa) skutecznie blokuje kradziez
# fokusu procesom w tle, kropka. Zamiast dalej walczyc z zabezpieczeniem
# systemowym, uzywamy FlashWindowEx - jedynego mechanizmu, ktory Windows
# CELOWO udostepnia procesom w tle wlasnie do tego scenariusza (powiadom
# uzytkownika bez kradziezy fokusu) - podswietla przycisk na pasku zadan,
# co dziala niezaleznie od blokady SetForegroundWindow. Glowne
# potwierdzenie i tak jest w UI (public/inline-1.js: "Otwieram..." ->
# "Otwarto"), zeby uzytkownik nigdy nie musial polegac wylacznie na tym,
# co zrobi okno.
param(
  [Parameter(Mandatory = $true)]
  [string]$FolderPath
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $FolderPath)) {
  Write-Error "Folder nie istnieje: $FolderPath"
  exit 1
}

Start-Process -FilePath 'explorer.exe' -ArgumentList $FolderPath
Start-Sleep -Milliseconds 800

try {
  Add-Type -Namespace ScyzorykWin32 -Name Flash -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)]
public struct FLASHWINFO {
  public uint cbSize;
  public System.IntPtr hwnd;
  public uint dwFlags;
  public uint uCount;
  public uint dwTimeout;
}
[DllImport("user32.dll")] public static extern bool FlashWindowEx(ref FLASHWINFO pwfi);
'@

  $leafName = Split-Path -Path $FolderPath -Leaf
  $window = $null
  for ($attempt = 1; $attempt -le 5 -and -not $window; $attempt++) {
    $window = Get-Process -Name explorer -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowTitle -eq $leafName -and $_.MainWindowHandle -ne [IntPtr]::Zero } |
      Select-Object -First 1
    if (-not $window) { Start-Sleep -Milliseconds 300 }
  }

  if ($window) {
    $info = New-Object ScyzorykWin32.Flash+FLASHWINFO
    $info.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($info)
    $info.hwnd = $window.MainWindowHandle
    $info.dwFlags = 0x3   # FLASHW_ALL (ikona + pasek zadan)
    $info.uCount = 6
    $info.dwTimeout = 0
    [ScyzorykWin32.Flash]::FlashWindowEx([ref]$info) | Out-Null
  }
} catch {
  # Best-effort - folder i tak jest juz otwarty (Start-Process powyzej),
  # wiec brak tu krytycznego bledu do zaraportowania.
}
