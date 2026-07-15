#!/usr/bin/env node
// Ustawia/zmienia JEDNO wspolne haslo panelu administratora dla profilu
// linux-pilot. Pracownicy nie maja kont - to haslo chroni wylacznie
// /admin (diagnostyka, logi), nie zwykle narzedzia.
// Uzycie:
//   node scripts/set-admin-password.js --password=...
// Bez --password przechodzi w tryb interaktywny (readline, haslo wpisywane
// jawnie - ten skrypt ma dzialac w terminalu administratora, nie przez siec).
const readline = require('readline');
const { setAdminPassword } = require('../lib/auth/adminAuth');

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const match = arg.match(/^--([a-z]+)(?:=(.*))?$/i);
    if (!match) continue;
    out[match[1]] = match[2] === undefined ? true : match[2];
  }
  return out;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer); }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let password = args.password;
  if (!password) password = await ask('Nowe haslo administratora (min. 8 znakow): ');

  try {
    await setAdminPassword(password);
    console.log('');
    console.log('Haslo administratora zostalo ustawione. Panel /admin jest teraz za nim chroniony.');
  } catch (err) {
    console.error('');
    console.error(`Blad: ${err.message}`);
    process.exitCode = 1;
  }
}

main();
