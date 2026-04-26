'use strict';
// Dump every non-empty cell of the master template with row, col, value, fill, font.
const XLSX = require('xlsx');
const path = require('path');

const file = process.argv[2] || 'C:\\Users\\admin\\Downloads\\DW SHEET DEMO NEW 11-03-26.xlsx';
const wb = XLSX.readFile(file, { cellStyles: true, cellFormula: true });

for (const name of wb.SheetNames) {
  const ws = wb.Sheets[name];
  const ref = ws['!ref'] || 'A1';
  const range = XLSX.utils.decode_range(ref);
  console.log(`\n===== SHEET: ${name}  (${ref}, rows ${range.s.r}-${range.e.r}, cols ${range.s.c}-${range.e.c}) =====`);
  console.log(`MERGES: ${(ws['!merges']||[]).length}`);
  for (const m of (ws['!merges']||[])) {
    console.log(`  MERGE ${XLSX.utils.encode_range(m)}`);
  }
  const rowsWithData = new Set();
  for (let r = range.s.r; r <= range.e.r; r++) {
    let any = false;
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr];
      if (!cell) continue;
      if (cell.v == null || cell.v === '') continue;
      any = true;
      const v = String(cell.v).slice(0, 80).replace(/\s+/g, ' ');
      const f = cell.f ? ` f=${cell.f}` : '';
      let fill = '';
      if (cell.s && cell.s.fgColor && cell.s.fgColor.rgb && cell.s.patternType === 'solid') {
        const hex = cell.s.fgColor.rgb.length >= 8 ? cell.s.fgColor.rgb.slice(2) : cell.s.fgColor.rgb;
        fill = ` fill=${hex}`;
      }
      let bold = '';
      if (cell.s && cell.s.font && cell.s.font.bold) bold = ' bold';
      console.log(`  R${r} C${c} ${addr}: "${v}"${f}${fill}${bold}`);
    }
    if (any) rowsWithData.add(r);
  }
  console.log(`Rows with data: ${rowsWithData.size}`);
}
