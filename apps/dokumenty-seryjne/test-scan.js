const ts = require('./src/templateScan.js');

const folders = [
  ['Paradyz Kolektory', 'G:\\Dyski współdzielone\\Dział Projektowy Sanitarny\\6. Paradyż Żarnów\\Kolektory\\wzór'],
  ['Paradyz Pompy', 'G:\\Dyski współdzielone\\Dział Projektowy Sanitarny\\6. Paradyż Żarnów\\PC\\Wzory dokumentacji projektowej Pompy ciepła'],
  ['Kamiensk Kolektory', 'G:\\Dyski współdzielone\\Dział Projektowy Sanitarny\\17. Kamieńsk\\Kolektory\\wzór']
];
for (const [label, f] of folders) {
  console.log('=== ' + label + ' ===');
  const items = ts.scanTemplateFolder(f);
  const groups = ts.classifyTemplates(items);
  for (const g of groups) {
    console.log('  ' + g.name + ' | rozpoznane: ' + g.recognized + ' | warianty: ' + g.hasVariants + ' | liczba plikow: ' + g.entries.length);
  }
}

console.log('');
console.log('=== TEST resolveEntriesForRow (roznych formatow) ===');
const kolItems = ts.scanTemplateFolder('G:\\Dyski współdzielone\\Dział Projektowy Sanitarny\\6. Paradyż Żarnów\\Kolektory\\wzór');
const kolGroups = ts.classifyTemplates(kolItems);
const otGroup = kolGroups.find(g => g.name === 'Opis techniczny');
console.log('OT dla wiersza z "2/300":', ts.resolveEntriesForRow(otGroup, {}, '2/300', null).map(e => e.originalName));
console.log('OT dla wiersza z "x250L/3,2kW":', ts.resolveEntriesForRow(otGroup, {}, 'x250L/3,2kW', null).map(e => e.originalName));

const symGroup = kolGroups.find(g => g.name === 'Symulacja solarna');
console.log('Symulacja dla mocy=2/300, gmina=Żarnów:', ts.resolveEntriesForRow(symGroup, {}, '2/300', 'Żarnów').map(e => e.originalName));

const kamItems = ts.scanTemplateFolder('G:\\Dyski współdzielone\\Dział Projektowy Sanitarny\\17. Kamieńsk\\Kolektory\\wzór');
const kamGroups = ts.classifyTemplates(kamItems);
const kamOt = kamGroups.find(g => g.name === 'Opis techniczny');
console.log('Kamiensk OT dla wiersza "2/300 " (ze spacja jak w realnych danych):', ts.resolveEntriesForRow(kamOt, {}, '2/300 ', null).map(e => e.originalName));

const pcItems = ts.scanTemplateFolder('G:\\Dyski współdzielone\\Dział Projektowy Sanitarny\\6. Paradyż Żarnów\\PC\\Wzory dokumentacji projektowej Pompy ciepła');
const pcGroups = ts.classifyTemplates(pcItems);
const kartaGroup = pcGroups.find(g => g.name === 'Karta katalogowa');
console.log('Karta katalogowa dla "Varmero VPM9020":', ts.resolveEntriesForRow(kartaGroup, {}, 'Varmero VPM9020', null).map(e => e.originalName));
