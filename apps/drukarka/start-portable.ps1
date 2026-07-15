$env:Path="C:\Users\Piotr.Cyniak\node-v26.4.0-win-x64;$env:Path"

if (!(Test-Path ".\node_modules")) {
    npm install
}

node server.js