param(
  [string]$ProjectRoot = (Resolve-Path "$PSScriptRoot\..").Path
)

$ErrorActionPreference = 'Stop'

$platformRoot = Join-Path $env:ProgramData 'Microsoft\Windows Defender\Platform'
$mpcmd = $null

if (Test-Path $platformRoot) {
  $latest = Get-ChildItem $platformRoot -Directory | Sort-Object Name -Descending | Select-Object -First 1
  if ($latest) {
    $mpcmd = Join-Path $latest.FullName 'MpCmdRun.exe'
  }
}

if (-not $mpcmd -or -not (Test-Path $mpcmd)) {
  $mpcmd = Join-Path $env:ProgramFiles 'Windows Defender\MpCmdRun.exe'
}

if (-not (Test-Path $mpcmd)) {
  Write-Error 'MpCmdRun.exe not found. Check Microsoft Defender installation.'
  exit 1
}

$targets = @(
  'apps\drukarka\data',
  'apps\drukarka\uploads',
  'apps\pieczatki-pdf\uploads',
  'apps\pieczatki-pdf\output',
  'apps\formularze-ecodan\uploads',
  'apps\formularze-ecodan\output',
  'apps\dokumenty-seryjne\data\uploads',
  'apps\dokumenty-seryjne\data\output',
  'apps\wnioski-powykonawcze\data\uploads',
  'apps\wnioski-powykonawcze\data\output'
)

$failed = $false
$scanned = 0

foreach ($rel in $targets) {
  $target = Join-Path $ProjectRoot $rel
  if (-not (Test-Path $target)) {
    continue
  }

  $scanned += 1
  Write-Host "Scanning: $target"
  & $mpcmd -Scan -ScanType 3 -File $target

  if ($LASTEXITCODE -ne 0) {
    Write-Warning "Defender returned code $LASTEXITCODE for: $target"
    $failed = $true
  }
}

if ($failed) {
  exit 2
}

Write-Host "Defender scan finished. Folders scanned: $scanned"
exit 0
