'use strict';
const XLSX = require('xlsx');
const wb = XLSX.readFile(process.argv[2] || 'C:\\Users\\admin\\Downloads\\DW SHEET DEMO NEW 11-03-26.xlsx', { cellStyles: true });
const ws = wb.Sheets[wb.SheetNames[0]];
console.log('!cols[0]:', JSON.stringify(ws['!cols'] && ws['!cols'][0]));
console.log('!cols[1]:', JSON.stringify(ws['!cols'] && ws['!cols'][1]));
for (let r = 58; r <= 70; r++) {
  for (let c = 0; c <= 8; c++) {
    const a = XLSX.utils.encode_cell({ r, c });
    const cell = ws[a];
    if (!cell) { console.log(`R${r} C${c} ${a}: <empty>`); continue; }
    console.log(`R${r} C${c} ${a}: v=${JSON.stringify(cell.v)} t=${cell.t} f=${cell.f||''} s=${JSON.stringify(cell.s||{})}`);
  }
}
