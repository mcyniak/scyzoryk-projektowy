// Buduje czysta paczke ZIP do rozeslania koncowemu uzytkownikowi (kolezanka/kolega z
// dzialu, nie deweloper) - `git archive` bierze WYLACZNIE to, co jest scommitowane
// (respektuje .gitignore automatycznie), wiec node_modules/, apps/*/data,logs,uploads,
// output,tmp/, robocze pliki testowe itp. nigdy tam nie trafiaja - node_modules
// doinstaluje sie samo przy pierwszym uruchomieniu (STARTUJ-SCYZORYK.cmd), tak jak
// dzis. Foldery czysto deweloperskie (.claude/, .serena/) sa dodatkowo wykluczone
// przez .gitattributes (export-ignore), mimo ze same SA scommitowane (potrzebne
// przyszlym sesjom Claude Code, niepotrzebne koncowemu uzytkownikowi).
//
// Pakuje ZAWSZE ostatni SCOMMITOWANY stan (HEAD) - jesli w drzewie roboczym sa
// niescommitowane zmiany, ostrzega, ale i tak buduje (nie blokuje), zeby dalo sie
// szybko spakowac znany, stabilny stan bez wymuszania commitu w tej samej chwili.
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RELEASE_DIR = path.join(ROOT, 'release');

function run(cmd, args) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function main() {
  const dirty = run('git', ['status', '--porcelain']);
  if (dirty) {
    console.warn('UWAGA: w drzewie roboczym sa niescommitowane zmiany - NIE trafia one do paczki.');
    console.warn('Scommituj je najpierw, jesli maja byc w spakowanej wersji.\n');
  }

  const rev = run('git', ['rev-parse', '--short', 'HEAD']);
  const stamp = new Date().toISOString().slice(0, 10);
  const prefix = 'scyzoryk-projektowy/';
  const outFile = path.join(RELEASE_DIR, `scyzoryk-projektowy-${stamp}-${rev}.zip`);

  fs.mkdirSync(RELEASE_DIR, { recursive: true });

  execFileSync('git', ['archive', '--format=zip', `--prefix=${prefix}`, '-o', outFile, 'HEAD'], { cwd: ROOT, stdio: 'inherit' });

  const sizeMb = (fs.statSync(outFile).size / (1024 * 1024)).toFixed(1);
  console.log(`\nSpakowano (${sizeMb} MB): ${outFile}`);
  console.log('Rozpakuj u odbiorcy i uruchom STARTUJ-SCYZORYK.cmd (wymaga Node.js >= 18 zainstalowanego na komputerze).');
}

main();
