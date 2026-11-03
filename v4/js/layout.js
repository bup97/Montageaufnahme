/* Folien-Layout – eine Quelle für Vorschau UND PowerPoint-Export.
   Alle Maße in Zoll, Folie 13,333 × 7,5 (Breitbild wie bisher). */
'use strict';

const SLIDE_W = 13.333, SLIDE_H = 7.5;
const C = {
  headFill: 'DBDBDB', line: '000000', black: '000000', white: 'FFFFFF',
  zebra: 'F5F5F5', artNo: '0057B8', tool: 'EBBBD7', toolLine: '8E4585',
  hint: 'FFF0C8', wireZebra: 'F0F4FF', wireBorder: '003b7a', title: '1e3c72'
};
const COL = { left: 0.2, top: 0.9, w: 6.2, h: 6.0 };      // Bildbereich links
const RIGHT = { x: 6.5, top: 0.86, w: 6.6 };               // rechte Spalte
const SCAN = { x: 12.328, y: 6.5, w: 1.0, h: 1.0 };

const LABELS = {
  vormontage: [{ key: 'vm', title: 'Label: Baugruppenlabel aufkleben und scannen',
    lines: ['Label aufkleben und scannen'], warning: '', img: null }],
  endmontage: [
    { key: 'eol', title: 'Label EOL: Fertigwarenlabel scannen und für EOL beilegen',
      lines: ['Label ausdrucken', 'Label scannen', 'Für Prüfer beilegen'],
      warning: 'Label wird nach erfolgreicher Prüfung von Prüfer aufgeklebt', img: 'img/label-eol.jpg' },
    { key: 'vp', title: 'Label VP: Fertigwarenlabel scannen und für VP beilegen',
      lines: ['Label ausdrucken', 'Label scannen', 'Für Verpackung beilegen'],
      warning: 'Label wird beim Verpacken aufgeklebt', img: 'img/label-vp.jpg' },
    { key: 'fa', title: 'Label FA: Fertigwarenlabel scannen und für FA beilegen',
      lines: ['Label ausdrucken', 'Label scannen', 'Auf Fertigungsauftrag aufkleben'],
      warning: 'Label wird auf Fertigungsauftrag aufgeklebt', img: 'img/label-fa.jpg' }
  ]
};

/* ---------- Textmaß-Schätzung ---------- */
function lineH(pt) { return pt * 1.2 / 72; }
function charW(pt, bold) { return pt * (bold ? 0.56 : 0.52) / 72; }
/* Textbreite in Zoll – gemessen in der Folienschrift (Calibri; sonst ähnlich breite Ersatzschrift).
   Kleiner Sicherheitszuschlag, damit eher eine Zeile zu viel als zu wenig eingeplant wird. */
let _mctx = null;
function textW(t, pt, bold) {
  try {
    _mctx = _mctx || document.createElement('canvas').getContext('2d');
    _mctx.font = `${bold ? '700 ' : ''}${(pt * 96 / 72).toFixed(2)}px Calibri, Carlito, "Segoe UI", Arial, sans-serif`;
    return _mctx.measureText(t).width / 96 * 1.06;
  } catch (e) { return t.length * charW(pt, bold); }
}
function countLines(text, w, pt, bold) {
  const avail = Math.max(0.1, w - 0.2);
  return String(text || '').split('\n').reduce((n, para) => {
    let lines = 1, cur = 0;
    for (const word of para.split(/(?<=[\s\-\/])/)) {        // Umbruch nach Leerzeichen, Bindestrich, Schrägstrich
      const ww = textW(word, pt, bold);
      if (cur + ww <= avail || cur === 0) {
        if (ww > avail) { lines += Math.ceil(ww / avail) - 1; cur = ww % avail; } else cur += ww;
      } else { lines++; cur = ww > avail ? ww % avail : ww; if (ww > avail) lines += Math.ceil(ww / avail) - 1; }
    }
    return n + lines;
  }, 0);
}
function textH(text, w, pt, bold) { return countLines(text, w, pt, bold) * lineH(pt) + 0.12; }

/* ---------- Ableitungen aus einem Schritt ---------- */
function stepTitle(step, n) {
  if (step.title && step.title.trim()) return step.title.trim();
  const first = (step.instructions || '').split('\n')[0].trim();
  if (first && first.length < 50) return first;
  return `Arbeitsvorgang ${n}`;
}
function instructionBullets(step) {
  const lines = (step.instructions || '').split('\n').map(s => s.trim()).filter(Boolean);
  return lines;
}
function stepTools(step) {
  const t = (step.tools || []).filter(x => (x.tool || '').trim() || (x.torque || '').trim());
  if (t.length) return t;
  // Fallback wie V3: aus dem Text erkennen
  const s = step.instructions || '';
  let tool = '', torque = '';
  const ib = s.match(/inbus\s*(\d+[.,]?\d*)/i); if (ib) tool = `Inbus ${ib[1]}`;
  const sk = !tool && s.match(/steckschlüssel\s*(\d+)/i); if (sk) tool = `Steckschlüssel ${sk[1]}`;
  if (/handfest/i.test(s)) torque = 'handfest';
  const nm = s.match(/(\d+(?:[.,]\d+)?)\s*nm\b/i); if (nm) torque = `${nm[1]} Nm`;
  return (tool || torque) ? [{ tool, torque, auto: true }] : [];
}
function stepHint(step) {
  if ((step.warning || '').trim()) return step.warning.trim();
  const hints = [];
  (step.instructions || '').split('\n').forEach(l => {
    if (/(?:achtung|hinweis|vorsicht|warnung|⚠)/i.test(l)) {
      const h = l.replace(/^(?:⚠\s*|achtung[:\s]*|hinweis[:\s]*|vorsicht[:\s]*|warnung[:\s]*)/i, '').trim();
      if (h) hints.push(h);
    }
  });
  return hints.join(' ');
}

/* ---------- Bilder anordnen (1–4 Fotos, beste Größe) ---------- */
function arrangePhotos(photos) {
  const list = photos.slice(0, 4);
  const n = list.length;
  if (!n) return [];
  const gap = 0.15;
  const options = [];
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    if (rows > 4) continue;
    const cw = (COL.w - gap * (cols - 1)) / cols, ch = (COL.h - gap * (rows - 1)) / rows;
    let minA = Infinity;
    const boxes = list.map((p, i) => {
      const r = Math.floor(i / cols), c = i % cols;
      const ar = (p.w && p.h) ? p.w / p.h : 4 / 3;
      let w = cw, h = cw / ar; if (h > ch) { h = ch; w = ch * ar; }
      minA = Math.min(minA, w * h);
      // letzte, unvollständige Zeile zentrieren
      const inRow = (r === rows - 1) ? n - r * cols : cols;
      const rowOff = (cols - inRow) * (cw + gap) / 2;
      return { x: COL.left + rowOff + c * (cw + gap) + (cw - w) / 2, y: COL.top + r * (ch + gap) + (ch - h) / 2, w, h, photo: p };
    });
    options.push({ minA, boxes });
  }
  options.sort((a, b) => b.minA - a.minA);
  return options[0].boxes;
}

/* ---------- Bausteine rechte Spalte ---------- */
/* Kompakte Tabellen: Zeilenhöhe = Text + kleiner Innenabstand (statt fester 0,4") */
const TAB = { pt: 18, desc: 14, padV: 0.03, padH: 0.06 };
const TAB_MARGIN = [TAB.padV, TAB.padH, TAB.padV, TAB.padH];
const cellH = (text, w, pt, bold) => countLines(text, w - 2 * TAB.padH + 0.2, pt, bold) * lineH(pt) + 2 * TAB.padV;
const ROW_MIN = lineH(TAB.pt) + 2 * TAB.padV;

function materialTable(materials, y) {
  const head = { fontSize: TAB.pt, bold: true, color: C.white, fill: C.black, align: 'left' };
  const rows = [[
    { text: 'Pos.', o: head }, { text: 'Artikelnummer', o: head },
    { text: 'Bezeichnung', o: head }, { text: 'Anz.', o: head }]];
  const colW = [0.64, 1.9, 3.34, 0.72];
  const rowH = [Math.max(ROW_MIN, ...rows[0].map((c, k) => cellH(c.text, colW[k], TAB.pt, true)))];
  if (materials.length) {
    materials.forEach((m, i) => {
      const fill = i % 2 === 0 ? C.white : C.zebra;
      const desc = m.description || m.number;
      rows.push([
        { text: String(i + 1), o: { fontSize: TAB.pt, color: C.black, fill, align: 'center' } },
        { text: m.number, o: { fontSize: TAB.pt, bold: true, color: C.artNo, fill, align: 'left' } },
        { text: desc, o: { fontSize: TAB.desc, color: C.black, fill, align: 'left' } },
        { text: `${m.quantity} x`, o: { fontSize: TAB.pt, color: C.black, fill, align: 'center' } }
      ]);
      rowH.push(Math.max(ROW_MIN, cellH(m.number, colW[1], TAB.pt, true), cellH(desc, colW[2], TAB.desc)));
    });
  } else {
    const o = { fontSize: TAB.pt, color: C.black, fill: C.white };
    rows.push(['-', '-', '-', '-'].map((t, i) => ({ text: t, o: { ...o, align: i === 0 || i === 3 ? 'center' : 'left' } })));
    rowH.push(ROW_MIN);
  }
  const h = rowH.reduce((a, b) => a + b, 0);
  return { type: 'table', x: RIGHT.x, y, w: RIGHT.w, h, colW, rowH, rows, margin: TAB_MARGIN,
    border: { pt: 0.6, color: C.white }, kind: 'materials' };
}

function headBar(text, y, h, fill, pt) {
  return { type: 'text', text, x: RIGHT.x, y, w: RIGHT.w, h, fontSize: pt || 20, bold: true,
    color: C.black, valign: 'middle', fill: fill || C.headFill, line: C.line, shape: 'roundRect' };
}

function rightColumn(els, { materials, bullets, cables, tools, hint, minInstrH }) {
  const table = materialTable(materials, RIGHT.top);
  els.push(table);
  // Anweisung wie V3 bei 3,06" – rutscht nur nach unten, wenn die Tabelle länger ist
  let y = Math.max(RIGHT.top + 2.2, table.y + table.h + 0.12);
  els.push(headBar('Montageanweisung', y, 0.32));
  y += 0.32;
  const text = bullets.length ? bullets.map(b => '• ' + b).join('\n') : 'Text für Montageanweisung';
  const instrH = Math.max(minInstrH, textH(text, RIGHT.w, 18));
  els.push({ type: 'text', text, x: RIGHT.x, y, w: RIGHT.w, h: instrH, fontSize: 18, color: C.black,
    valign: 'top', kind: 'instructions', placeholder: !bullets.length });
  y += instrH + 0.1;

  if (cables.length) {
    const head = { fontSize: TAB.pt, bold: true, color: C.black, fill: C.tool, align: 'left' };
    const rows = [[{ text: 'Kabel', o: head }, { text: 'Von (Stecker/Pin)', o: head }, { text: 'Nach (Stecker/Pin)', o: head }]];
    const rowH = [ROW_MIN];
    cables.forEach((c, i) => {
      const fill = i % 2 === 0 ? C.white : C.wireZebra;
      rows.push([
        { text: c.designation || '-', o: { fontSize: TAB.pt, bold: true, color: C.black, fill, align: 'left' } },
        { text: c.from || '-', o: { fontSize: TAB.pt, color: C.black, fill, align: 'left' } },
        { text: c.to || '-', o: { fontSize: TAB.pt, color: C.black, fill, align: 'left' } }]);
      rowH.push(Math.max(ROW_MIN, ...[c.designation, c.from, c.to].map((t, k) => cellH(t || '-', 2.2, TAB.pt, k === 0))));
    });
    const h = rowH.reduce((a, b) => a + b, 0);
    els.push({ type: 'table', x: RIGHT.x, y, w: RIGHT.w, h, colW: [2.2, 2.2, 2.2], rowH, rows, margin: TAB_MARGIN,
      border: { pt: 0.5, color: C.wireBorder }, kind: 'cables' });
    y += h + 0.15;
  }

  tools.forEach(t => {
    let x = RIGHT.x;
    const box = (text) => ({ type: 'text', text, x, y, w: 2.48, h: 0.3, fontSize: 18, color: C.black,
      valign: 'middle', fill: C.tool, line: C.toolLine, shape: 'roundRect', kind: 'tool' });
    if ((t.tool || '').trim()) { els.push(box('🔧 ' + t.tool.trim())); x += 2.68; }
    if ((t.torque || '').trim()) { const b = box('⚡ ' + t.torque.trim()); b.x = x; els.push(b); }
    y += 0.45;
  });
  if (tools.length) y += 0.05;

  if (hint) {
    els.push(headBar('⚠ Hinweis', y, 0.35, C.hint, 18));
    y += 0.35;
    const h = Math.max(0.6, textH(hint, RIGHT.w, 18));
    els.push({ type: 'text', text: hint, x: RIGHT.x, y, w: RIGHT.w, h, fontSize: 18, color: C.black,
      valign: 'top', fill: C.white, line: C.line, shape: 'rect', kind: 'hint' });
    y += h;
  }
  return y; // Unterkante rechte Spalte
}

function commonTop(els, title) {
  els.push({ type: 'text', text: title, x: 0.16, y: 0.16, w: 13.0, h: 0.55, fontSize: 28, bold: true,
    color: C.black, valign: 'middle', fill: C.headFill, line: C.line, shape: 'roundRect', kind: 'title' });
  els.push({ type: 'image', src: 'logo', x: 11.65, y: 0.22, w: 1.5, h: 0.45 });
}

function checkFit(els, bottom, scan) {
  const warn = [];
  if (bottom > SLIDE_H - 0.05) warn.push('Rechte Spalte passt nicht auf die Folie – Text kürzen oder auf zwei Schritte aufteilen.');
  else if (scan && bottom > SCAN.y - 0.02) warn.push('Scanschritt-Logo überdeckt den Hinweis unten rechts.');
  return warn;
}

/* Elemente der rechten Spalte, die ins Scan-Logo ragen, schmaler machen */
function avoidScan(els) {
  const maxR = SCAN.x - 0.08;
  els.forEach(e => {
    if (e.x < RIGHT.x - 0.01 || e.y + e.h <= SCAN.y || e.x + e.w <= maxR) return;
    const nw = maxR - e.x;
    if (e.type === 'table') { const k = nw / e.w; e.colW = e.colW.map(c => c * k); }
    if (nw > 0.5) e.w = nw;
  });
}

/* ---------- Öffentliche Layouts ---------- */
function layoutStepSlide(step, n, photos /* [{id,w,h}] */) {
  const els = [];
  commonTop(els, `Schritt ${n}: ${stepTitle(step, n)}`);
  const warnings = [];
  if (photos.length) {
    arrangePhotos(photos).forEach(b => els.push({ type: 'image', src: 'photo', photoId: b.photo.id, x: b.x, y: b.y, w: b.w, h: b.h }));
    if (photos.length > 4) warnings.push(`Nur die ersten 4 von ${photos.length} Fotos kommen auf die Folie.`);
  } else {
    els.push({ type: 'text', text: '[BILD]', x: COL.left + 2, y: COL.top + 2.5, w: 2, h: 0.5, fontSize: 16, color: '969696', align: 'center', kind: 'noimg' });
  }
  const cables = (step.cables || []).filter(c => c.designation || c.from || c.to);
  const bottom = rightColumn(els, {
    materials: step.materials || [], bullets: instructionBullets(step), cables,
    tools: stepTools(step), hint: stepHint(step), minInstrH: cables.length ? 0.8 : 1.4
  });
  if (step.isScanStep) { avoidScan(els); els.push({ type: 'image', src: 'scan', ...SCAN }); }
  return { els, warnings: warnings.concat(checkFit(els, bottom, false)) };
}

function layoutLabelSlide(label) {
  const els = [];
  commonTop(els, label.title);
  if (label.img) {
    const h = 5, w = h * 0.8;
    els.push({ type: 'image', src: 'label', label: label.key, x: COL.left + (COL.w - w) / 2, y: COL.top + (COL.h - h) / 2, w, h });
  } else {
    els.push({ type: 'rect', x: COL.left, y: COL.top, w: COL.w, h: COL.h, fill: 'F5F5F5', line: 'CCCCCC', dash: true });
    els.push({ type: 'text', text: '[BILD]', x: COL.left + 2, y: COL.top + 2.5, w: 2, h: 0.5, fontSize: 16, color: '969696', align: 'center' });
  }
  rightColumn(els, { materials: [], bullets: label.lines, cables: [], tools: [], hint: label.warning, minInstrH: 1.4 });
  els.push({ type: 'image', src: 'scan', ...SCAN });
  return { els, warnings: [] };
}

function layoutTitleSlide(project, stepCount) {
  const els = [];
  const cx = SLIDE_W / 2;
  els.push({ type: 'image', src: 'logo', x: SLIDE_W - 2.3 - 0.6, y: 0.3, w: 2.3, h: 0.69 });
  els.push({ type: 'text', text: 'Montageanleitung', x: cx - 4, y: 1.8, w: 8, h: 0.8, fontSize: 44, bold: true, color: C.title, align: 'center' });
  els.push({ type: 'rect', x: cx - 2.5, y: 2.8, w: 5, h: 0.02, fill: C.title });
  let y = 3.2;
  [['Kunde:', project.customer], ['Produkt:', project.product], ['Variante:', project.variant]].forEach(([k, v]) => {
    if (!v) return;
    els.push({ type: 'text', text: k, x: cx - 4.2, y, w: 3, h: 0.5, fontSize: 20, bold: true, color: '333333', align: 'right' });
    els.push({ type: 'text', text: v, x: cx - 1.1, y, w: 5.3, h: 0.5, fontSize: 20, color: C.black, align: 'left' });
    y += 0.6;
  });
  y += 0.1;
  els.push({ type: 'text', text: `Erstellt am: ${project.createdAtText || ''}`, x: cx - 4, y: y + 0.3, w: 8, h: 0.4, fontSize: 14, color: '666666', align: 'center', italic: true });
  els.push({ type: 'text', text: `${areaLabel(project)} · ${stepCount} Arbeitsschritt${stepCount !== 1 ? 'e' : ''}`, x: cx - 4, y: y + 0.75, w: 8, h: 0.4, fontSize: 14, color: '666666', align: 'center' });
  els.push({ type: 'text', text: 'Funkwerk | Digitale Arbeitsanweisungen', x: cx - 4, y: 6.8, w: 8, h: 0.4, fontSize: 12, color: '999999', align: 'center' });
  return { els, warnings: [] };
}

function areaLabel(p) {
  if (p.area === 'elexon') return 'Elexon';
  return p.type === 'vormontage' ? 'Funkwerk Vormontage' : 'Funkwerk Endmontage';
}
function labelsFor(p) {
  if (p.area !== 'funkwerk') return { start: [], end: [] };
  return p.type === 'vormontage' ? { start: LABELS.vormontage, end: [] } : { start: [], end: LABELS.endmontage };
}

window.Layout = { SLIDE_W, SLIDE_H, layoutStepSlide, layoutLabelSlide, layoutTitleSlide, labelsFor, areaLabel,
  stepTitle, stepTools, stepHint, instructionBullets, LABELS };
