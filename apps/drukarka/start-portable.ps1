# Opcjonalny portable Node - ustaw zmienna srodowiskowa SCYZORYK_PORTABLE_NODE na folder
# z node.exe, jesli nie masz Node.js zainstalowanego globalnie na tym komputerze.
if ($env:SCYZORYK_PORTABLE_NODE -and (Test-Path $env:SCYZORYK_PORTABLE_NODE)) {
  $env:Path = "$($env:SCYZORYK_PORTABLE_NODE);$env:Path"
}

if (!(Test-Path ".\node_modules")) {
    npm install
}

node server.js