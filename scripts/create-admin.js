#!/usr/bin/env node
// Terminalowe narzedzie do tworzenia/aktualizacji kont logowania dla profilu
// linux-pilot. Uzycie:
//   node scripts/create-admin.js --username=jkowalski --password=... [--role=admin|user] [--force]
// Bez --username/--password przechodzi w tryb interaktywny (readline, haslo
// wpisywane jawnie - ten skrypt ma dzialac w terminalu administratora, nie
// przez siec).
const readline = require('readline');
const { createUser, listUsersSafe } = require('../lib/auth/users');

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
  let username = args.username;
  let password = args.password;
  const role = args.role === 'user' ? 'user' : 'admin';
  const force = Boolean(args.force);

  if (!username) username = (await ask('Nazwa uzytkownika: ')).trim();
  if (!password) password = await ask('Haslo (min. 8 znakow): ');

  try {
    const user = await createUser(username, password, role, { force });
    console.log('');
    console.log(`Utworzono konto: ${user.username} (rola: ${user.role})`);
    console.log('');
    console.log('Wszystkie konta:');
    for (const u of listUsersSafe()) console.log(`  - ${u.username} (${u.role}${u.disabled ? ', wylaczone' : ''})`);
  } catch (err) {
    console.error('');
    console.error(`Blad: ${err.message}`);
    process.exitCode = 1;
  }
}

main();
