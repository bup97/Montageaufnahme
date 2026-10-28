/* Funkwerk Montage-Recorder V4 – Reiter „Aus CAD erstellen“
   STEP-Baugruppe + Stückliste → Montagereihenfolge (Demontage-Analyse) → Recorder-Anleitung mit Bildern.
   Läuft komplett im Browser; schwere Berechnung im Web Worker (cad/worker.js). */
import * as THREE from '../lib/three.module.min.js';
import { OrbitControls } from '../lib/OrbitControls.js';
import { parseSchematic, endLabel, shortBmk, colorName } from './elec.js';

const CAD_BASE = new URL('../cad/', import.meta.url).href;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rid = () => Math.random().toString(36).slice(2, 9);

const ACCENT = '#e8590c';   // neue Teile im Schritt
const ARROW = '#1971c2';    // Montagepfeil (blau, gut unterscheidbar von Orange und Grau)
let API = null;             // vom Recorder übergeben: toast, busy, createFromCad, projectForm
let ROOT = null;

// ======================= Zustand (bleibt beim Wechsel der Reiter erhalten) =======================
const S = {
  stepFile: null, bomFile: null, analyzed: false,
  parts: [], bom: null, match: {}, contacts: new Map(), boxVol: [],
  steps: [], sel: 0, warnings: [],
  meta: { title: '', art: '', upAxis: 'z', explode: true, ghost: false },
};

// ======================= Hilfen =======================
const norm = (s) => String(s ?? '').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, ' ').trim();
const digits = (s) => String(s ?? '').replace(/\D+/g, '');
const cleanName = (n) => { const segs = String(n).split('_').map(s => s.trim()).filter(Boolean); return segs.length ? segs[0] : String(n); };
const RX_FAST = /schraube|mutter|scheibe|schelle|niet|stift|clip|klammer|bolzen|sicherungsring|kabelbinder/i;
const RX_ELASTIC = /schlauch|dichtung|manschette|gummi|tuelle|tülle|o-ring|oring|schaum/i;
const toast = (m) => API?.toast ? API.toast(m) : console.log(m);

// ======================= Stückliste lesen (xlsx ohne Bibliothek) =======================
async function inflateRaw(u8) {
  const ds = new DecompressionStream('deflate-raw');
  return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer());
}
async function unzip(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 70000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Die Excel-Datei ist beschädigt oder kein .xlsx.');
  const n = dv.getUint16(eocd + 10, true); let p = dv.getUint32(eocd + 16, true);
  const files = {}; const td = new TextDecoder();
  for (let k = 0; k < n; k++) {
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
    files[td.decode(u8.subarray(p + 46, p + 46 + nlen))] = { method, csize, off };
    p += 46 + nlen + elen + clen;
  }
  return {
    names: Object.keys(files),
    async text(name) {
      const f = files[name]; if (!f) return null;
      const start = f.off + 30 + dv.getUint16(f.off + 26, true) + dv.getUint16(f.off + 28, true);
      const data = u8.subarray(start, start + f.csize);
      return td.decode(f.method === 0 ? data : await inflateRaw(data));
    }
  };
}
async function readXlsx(buf) {
  const z = await unzip(buf);
  const parse = (t) => new DOMParser().parseFromString(t, 'application/xml');
  let sheetPath = 'xl/worksheets/sheet1.xml';
  try {
    const wb = parse(await z.text('xl/workbook.xml'));
    const first = wb.getElementsByTagName('sheet')[0];
    const ridAttr = first && (first.getAttribute('r:id') || first.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id'));
    const rels = parse(await z.text('xl/_rels/workbook.xml.rels'));
    for (const r of rels.getElementsByTagName('Relationship')) if (r.getAttribute('Id') === ridAttr) {
      const t = r.getAttribute('Target'); sheetPath = t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, '');
    }
  } catch (e) { /* Standardpfad */ }
  if (!z.names.includes(sheetPath)) sheetPath = z.names.filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[0];
  const shared = [];
  const sst = await z.text('xl/sharedStrings.xml');
  if (sst) for (const si of parse(sst).getElementsByTagName('si')) shared.push([...si.getElementsByTagName('t')].map(t => t.textContent).join(''));
  const doc = parse(await z.text(sheetPath));
  const rows = [];
  const colIdx = (ref) => { let c = 0; for (const ch of ref.replace(/\d+/g, '')) c = c * 26 + (ch.charCodeAt(0) - 64); return c - 1; };
  for (const r of doc.getElementsByTagName('row')) {
    const ri = (+r.getAttribute('r') || rows.length + 1) - 1; const row = [];
    for (const c of r.getElementsByTagName('c')) {
      const t = c.getAttribute('t'); const v = c.getElementsByTagName('v')[0];
      let val = '';
      if (t === 's') val = shared[+v?.textContent] ?? '';
      else if (t === 'inlineStr') val = [...c.getElementsByTagName('t')].map(x => x.textContent).join('');
      else val = v ? v.textContent : '';
      row[colIdx(c.getAttribute('r') || 'A')] = val;
    }
    rows[ri] = row;
  }
  return rows.map(r => r || []);
}
function readCsv(text) {
  const first = text.split(/\r?\n/)[0] || '';
  const d = [';', '\t', ','].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === d) { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur.replace(/\r$/, '')); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
function interpretBom(rows) {
  const tests = {
    pos: h => /^pos/.test(h),
    art: h => /(art.*nr|artikel|teilenummer|sachnummer|materialnummer|part ?no|part number)/.test(h) && !/alt/.test(h),
    name: h => /(benennung|bezeichnung)/.test(h),
    desc: h => /(beschreibung|description)/.test(h),
    qty: h => /(menge|anzahl|stk|stueck|qty|quantity)/.test(h),
    torque: h => /(drehmoment|anzugsmoment|moment|torque)/.test(h),
    note: h => /(hinweis|bemerkung|notiz)/.test(h),
  };
  let best = { score: 0, at: -1, cols: {} };
  for (let r = 0; r < Math.min(15, rows.length); r++) {
    const cols = {}; let score = 0;
    (rows[r] || []).forEach((cell, ci) => {
      const h = norm(cell);
      for (const [k, f] of Object.entries(tests)) if (cols[k] === undefined && h && f(h)) { cols[k] = ci; score++; break; }
    });
    if (score > best.score) best = { score, at: r, cols };
  }
  if (best.at < 0 || (best.cols.name === undefined && best.cols.desc === undefined)) throw new Error('In der Stückliste wurde keine Spalte „Benennung“ gefunden.');
  if (best.cols.name === undefined) best.cols.name = best.cols.desc;
  const c = best.cols; const out = [];
  for (let r = best.at + 1; r < rows.length; r++) {
    const row = rows[r] || []; const name = String(row[c.name] ?? '').trim();
    if (!name) continue;
    const q = parseFloat(String(row[c.qty] ?? '1').replace(',', '.'));
    out.push({
      pos: String(row[c.pos] ?? '').trim(), art: String(row[c.art] ?? '').trim(), name,
      qty: isFinite(q) ? q : 1, torque: c.torque !== undefined ? String(row[c.torque] ?? '').trim() : '',
      note: c.note !== undefined ? String(row[c.note] ?? '').trim() : '',
    });
  }
  return { cols: c, rows: out };
}
function isUtf8(buf) { try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return true; } catch { return false; } }

// ======================= Zuordnung STEP ↔ Stückliste =======================
function scoreMatch(stepName, b) {
  const dn = digits(stepName), da = digits(b.art);
  if (da.length >= 6 && dn.includes(da)) return 100;
  const bn = norm(b.name); let best = 0;
  for (const s of String(stepName).split('_')) {
    const sn = norm(s); if (!sn) continue;
    if (sn === bn) best = Math.max(best, 92);
    const A = new Set(sn.split(' ')), B = new Set(bn.split(' '));
    let inter = 0; for (const t of A) if (B.has(t)) inter++;
    best = Math.max(best, Math.round(80 * inter / (A.size + B.size - inter)));
  }
  return best;
}
function autoMatch() {
  S.match = {};
  if (!S.bom) return;
  for (const n of new Set(S.parts.map(p => p.name))) {
    let bi = -1, bs = 0;
    S.bom.rows.forEach((b, i) => { const sc = scoreMatch(n, b); if (sc > bs) { bs = sc; bi = i; } });
    S.match[n] = bs >= 50 ? bi : -1;
  }
}
function bomOf(part) { const i = S.match[part.name]; return (i !== undefined && i >= 0 && S.bom) ? S.bom.rows[i] : null; }
function sharedRow(i) { let n = 0; for (const k in S.match) if (S.match[k] === i) n++; return n > 1; }
function distinctLabel(part) { const i = S.match[part.name]; const b = bomOf(part); return b && sharedRow(i) && norm(part.clean) !== norm(b.name); }
function labelOf(part) { const b = bomOf(part); return b && !distinctLabel(part) ? b.name : part.clean; }
function groupOf(part) { const i = S.match[part.name]; return (i !== undefined && i >= 0) ? 'pos:' + i + (distinctLabel(part) ? ':' + norm(part.clean) : '') : 'name:' + norm(part.clean); }

// ======================= Worker =======================
let worker = null, workerOk = null, msgId = 0;
const pending = new Map();
function initWorker() {
  if (workerOk !== null) return workerOk;
  try {
    worker = new Worker(CAD_BASE + 'worker.js');
    worker.onmessage = (e) => {
      const m = e.data; const p = pending.get(m.id); if (!p) return;
      if (m.type === 'progress') p.onProgress?.(m.phase, m.value);
      else if (m.type === 'done') { pending.delete(m.id); p.resolve(m.result); }
      else if (m.type === 'error') { pending.delete(m.id); p.reject(new Error(m.message)); }
    };
    worker.onerror = (e) => { for (const [, p] of pending) p.reject(new Error(e.message || 'Fehler im Hintergrundprozess')); pending.clear(); };
    workerOk = true;
  } catch (e) { workerOk = false; }
  return workerOk;
}
function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Konnte ' + src + ' nicht laden')); document.head.appendChild(s); }); }
async function call(msg, onProgress, transfer) {
  msg.base = CAD_BASE;
  if (initWorker()) {
    return new Promise((resolve, reject) => {
      const id = ++msgId; pending.set(id, { resolve, reject, onProgress });
      worker.postMessage(Object.assign({ id }, msg), transfer || []);
    });
  }
  if (!window.AsmWorker) { await loadScript(CAD_BASE + 'occt-import-js.js'); await loadScript(CAD_BASE + 'worker.js'); }
  await new Promise(r => setTimeout(r, 30));
  const { result } = await window.AsmWorker.handle(msg, (m) => onProgress?.(m.phase, m.value));
  return result;
}

// ======================= Analyse =======================
const PHASES = ['wasm', 'read', 'prep', 'seq'];
let readTimer = null;
function setPhase(phase, value) {
  const at = PHASES.indexOf(phase);
  $$('.cad-prog-row', ROOT).forEach(r => {
    const i = PHASES.indexOf(r.dataset.phase);
    r.classList.toggle('done', i < at); r.classList.toggle('active', i === at);
    if (r.dataset.phase !== 'read' || i !== at) r.querySelector('.v').textContent = i === at && value > 0 ? Math.round(value * 100) + ' %' : (i < at ? '✓' : '');
  });
  const bar = $('#cad-bar', ROOT); if (bar) bar.style.width = Math.round(((at + (value || 0)) / PHASES.length) * 100) + '%';
  if (phase === 'read') {
    const t0 = performance.now(); clearInterval(readTimer);
    readTimer = setInterval(() => { const r = $('.cad-prog-row[data-phase="read"].active .v', ROOT); if (r) r.textContent = Math.round((performance.now() - t0) / 1000) + ' s'; else clearInterval(readTimer); }, 500);
  }
}
async function analyze() {
  const err = $('#cad-err', ROOT); err.hidden = true;
  $('#cad-go', ROOT).disabled = true; $('#cad-prog', ROOT).hidden = false;
  try {
    S.bom = null;
    if (S.bomFile) {
      const buf = await S.bomFile.arrayBuffer();
      const rows = /\.xlsx$/i.test(S.bomFile.name) ? await readXlsx(buf) : readCsv(new TextDecoder(isUtf8(buf) ? 'utf-8' : 'windows-1252').decode(buf));
      S.bom = interpretBom(rows);
    }
    setPhase('wasm', 0);
    const buf = await S.stepFile.arrayBuffer();
    const res = await call({ type: 'parse', buffer: buf }, setPhase, [buf]);
    clearInterval(readTimer);
    buildParts(res);
    autoMatch();
    await runSequence();
    S.analyzed = true; thumbs.clear();
    render();
  } catch (e) {
    console.error(e); clearInterval(readTimer);
    err.textContent = String(e.message || e); err.hidden = false;
    $('#cad-go', ROOT).disabled = false;
  }
}
function buildParts(res) {
  disposeScene();
  S.parts = res.parts.map(p => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p.pos, 3));
    if (p.nrm && p.nrm.some(v => v !== 0)) g.setAttribute('normal', new THREE.BufferAttribute(p.nrm, 3)); else g.computeVertexNormals();
    g.setIndex(new THREE.BufferAttribute(p.idx, 1));
    g.computeBoundingBox();
    return { id: p.id, name: p.name, clean: cleanName(p.name), geom: g, box: g.boundingBox.clone() };
  });
  const rn = res.rootName || '';
  const segs = rn.split('_'); const last = segs.length > 1 ? segs[segs.length - 1] : '';
  if (/\d{3,}/.test(last)) { S.meta.title = segs.slice(0, -1).join('_').trim(); S.meta.art = last.trim(); }
  else { S.meta.title = rn || S.stepFile.name.replace(/\.(step|stp)$/i, ''); S.meta.art = ''; }
  buildScene();
}
async function runSequence() {
  const units = S.parts.map(p => {
    const label = labelOf(p);
    return { id: p.id, label, group: groupOf(p), fastener: RX_FAST.test(label), elastic: RX_ELASTIC.test(label) && !RX_FAST.test(label) };
  });
  setPhase('prep', 0);
  const r = await call({ type: 'sequence', units, upAxis: S.meta.upAxis }, setPhase);
  S.contacts = new Map(S.parts.map(p => [p.id, new Set()]));
  for (const [a, b] of r.contacts) { S.contacts.get(a).add(b); S.contacts.get(b).add(a); }
  S.boxVol = r.boxes.map(b => b.vol);
  S.warnings = r.warnings;
  S.steps = r.steps.map(s => ({
    uid: rid(), parts: s.parts.slice(), dir: s.removeDir,
    kind: s.base ? 'base' : s.sub ? 'sub' : s.fastener ? 'fast' : 'part',
    title: '', text: '', note: '', tools: '', auto: true, cam: null,
  }));
  regenTexts();
  S.sel = 0;
}

// ======================= Texte =======================
const DIRWORD = {
  z: ['von rechts', 'von links', 'von hinten', 'von vorne', 'von oben', 'von unten'],
  y: ['von rechts', 'von links', 'von oben', 'von unten', 'von vorne', 'von hinten'],
};
function stepGroups(step) {
  const m = new Map();
  for (const id of step.parts) {
    const p = S.parts[id]; const k = groupOf(p);
    if (!m.has(k)) m.set(k, { label: labelOf(p), bom: bomOf(p), ids: [] });
    m.get(k).ids.push(id);
  }
  return [...m.values()];
}
function placedBefore(si) { const s = new Set(); for (let i = 0; i < si; i++) S.steps[i].parts.forEach(p => s.add(p)); return s; }
function targetOf(si) {
  const placed = placedBefore(si); const st = S.steps[si];
  let best = null, bv = -1;
  for (const id of st.parts) for (const c of S.contacts.get(id) || []) {
    if (!placed.has(c)) continue;
    const v = (S.boxVol[c] || 0) * (RX_FAST.test(labelOf(S.parts[c])) ? 0.001 : 1);
    if (v > bv) { bv = v; best = c; }
  }
  if (best === null && si > 0) best = S.steps[0].parts[0];
  return best === null || best === undefined ? null : labelOf(S.parts[best]);
}
const qtyLabel = (g) => (g.ids.length > 1 ? g.ids.length + '× ' : '') + g.label;
function toolsFor(label) {
  const t = [];
  const tx = label.match(/\bT[XB]?\s?(\d{1,2})\b/i); if (tx && /tx|torx/i.test(label)) t.push('Torx TX' + tx[1]);
  if (/\bisk\b|innensechskant|inbus/i.test(label)) { const m = label.match(/M(\d+)/i); const sw = { 3: 2.5, 4: 3, 5: 4, 6: 5, 8: 6, 10: 8 }[m?.[1]]; t.push('Inbus' + (sw ? ' ' + sw : '')); }
  if (/sechskant|\bsk\b|din ?933|iso ?4017/i.test(label) && !/innen/i.test(label)) { const m = label.match(/M(\d+)/i); const sw = { 4: 7, 5: 8, 6: 10, 8: 13, 10: 16, 12: 18 }[m?.[1]]; t.push('Maulschlüssel' + (sw ? ' SW ' + sw : '')); }
  if (/kreuz|ph\d|pz\d/i.test(label)) t.push('Kreuzschlitz');
  return t;
}
function genText(si) {
  if (S.steps[si].kind === 'wire') return genWireText(S.steps[si]);
  const st = S.steps[si]; const groups = stepGroups(st);
  const dirW = st.dir >= 0 ? DIRWORD[S.meta.upAxis][st.dir] : '';
  const tgt = targetOf(si) || 'Baugruppe';
  const g = groups[0]; const L = g.label; const q = qtyLabel(g);
  let title, lines = [], tools = [];
  if (st.kind === 'base') {
    title = L + ' bereitlegen';
    lines = [L + ' als Grundteil bereitlegen', 'Wie abgebildet ausrichten'];
  } else if (st.kind === 'sub' && st.parts.length >= 2) {
    const ids = st.parts.slice().sort((a, b) => (S.boxVol[b] || 0) - (S.boxVol[a] || 0));
    const A = labelOf(S.parts[ids[0]]), B = labelOf(S.parts[ids[1]]);
    title = 'Vormontage: ' + B + ' in ' + A;
    lines = [B + ' in ' + A + ' einsetzen', 'Vormontierte Einheit ' + dirW + ' an ' + tgt + ' ansetzen'];
  } else if (/schraube|bolzen/i.test(L)) {
    title = (g.ids.length > 1 ? g.ids.length + '× ' : '') + 'Schraube ' + (L.match(/M\d+(?:[x×]\d+)?/i)?.[0] || '') + ' einschrauben';
    lines = [q + ' ' + dirW + ' einsetzen', 'Einschrauben und festziehen'];
    tools = toolsFor(L);
  } else if (/mutter/i.test(L)) { title = q + ' aufschrauben'; lines = [q + ' aufschrauben und festziehen']; tools = toolsFor(L); }
  else if (/scheibe/i.test(L)) { title = q + ' auflegen'; lines = [q + ' ' + dirW + ' auflegen']; }
  else if (/schelle/i.test(L)) { title = q + ' montieren'; lines = [q + ' auf ' + tgt + ' schieben', 'Wie abgebildet positionieren und festziehen']; }
  else if (/niet/i.test(L)) { title = q + ' setzen'; lines = [q + ' ' + dirW + ' setzen']; tools = ['Nietzange']; }
  else if (/clip|klammer/i.test(L)) { title = q + ' aufclipsen'; lines = [q + ' ' + dirW + ' an ' + tgt + ' aufclipsen', 'Einrasten prüfen']; }
  else if (/kabelbinder/i.test(L)) { title = q + ' anbringen'; lines = [q + ' anbringen und festziehen', 'Überstand abschneiden']; tools = ['Seitenschneider']; }
  else if (/dichtung|o-ring/i.test(L)) { title = L + ' anlegen'; lines = [q + ' ' + dirW + ' an ' + tgt + ' anlegen', 'Auf vollflächige, verdrehfreie Auflage achten']; }
  else if (/schlauch/i.test(L)) { title = L + ' aufschieben'; lines = [q + ' ' + dirW + ' auf ' + tgt + ' aufschieben', 'Sitz wie abgebildet prüfen']; }
  else if (/schild|aufkleber|etikett|label|typenschild/i.test(L)) { title = L + ' aufkleben'; lines = ['Klebefläche auf ' + tgt + ' reinigen', q + ' an der abgebildeten Position aufkleben']; }
  else if (/luefter|lüfter|ventilator/i.test(L)) { title = L + ' einsetzen'; lines = [q + ' ' + dirW + ' an ' + tgt + ' einsetzen', 'Luftrichtung und Kabelabgang beachten']; }
  else if (/gitter|deckel|abdeckung|haube|blende/i.test(L)) { title = L + ' aufsetzen'; lines = [q + ' ' + dirW + ' auf ' + tgt + ' aufsetzen']; }
  else if (/kabel|leitung|litze/i.test(L)) { title = L + ' verlegen'; lines = [q + ' wie abgebildet verlegen und anschließen']; }
  else if (/stecker|buchse/i.test(L)) { title = L + ' stecken'; lines = [q + ' ' + dirW + ' stecken, bis er einrastet']; }
  else { title = L + ' montieren'; lines = [q + ' ' + dirW + ' an ' + tgt + ' ansetzen und montieren']; }
  if (groups.length > 1 && st.kind !== 'sub') lines.push('Zusätzlich: ' + groups.slice(1).map(qtyLabel).join(', '));
  const clean = (x) => x.replace(/\s+/g, ' ').trim();
  return { title: clean(title), text: lines.map(clean).join('\n'), tools: tools.join(', '), note: groups.map(x => x.bom?.note).filter(Boolean).join(' ') };
}
function regenTexts() {
  S.steps.forEach((st, i) => {
    if (!st.auto) return;
    const g = genText(i); st.title = g.title; st.text = g.text;
    if (!st.toolsEdited) st.tools = g.tools;
    if (!st.noteEdited && g.note) st.note = g.note;
  });
}

// ======================= 3D =======================
let renderer, scene, camera, controls, offRenderer, offCamera, arrowGroup, mats, arrowMat;
const meshes = [], ghostMeshes = [];
const modelBox = new THREE.Box3();
let needRender = true, downAt = null, resizeObs = null;
const VIEWER_BG = '#eceef1';
function initThree() {
  if (renderer) return;
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(new THREE.Color(VIEWER_BG));
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(30, 1, 1, 100000); scene.add(camera);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x6a7580, 1.7));
  const d1 = new THREE.DirectionalLight(0xffffff, 1.6); d1.position.set(0.6, 0.9, 1); camera.add(d1);
  const d2 = new THREE.DirectionalLight(0xffffff, 0.6); d2.position.set(-1, -0.4, 0.3); camera.add(d2);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.12;
  controls.addEventListener('change', () => { needRender = true; });
  arrowGroup = new THREE.Group(); scene.add(arrowGroup);
  mats = {
    placed: new THREE.MeshStandardMaterial({ color: 0xb4bcc5, metalness: 0.15, roughness: 0.62 }),
    base: new THREE.MeshStandardMaterial({ color: 0x96a1ad, metalness: 0.2, roughness: 0.55 }),
    newp: new THREE.MeshStandardMaterial({ color: 0xe8590c, metalness: 0.05, roughness: 0.5, emissive: 0x3a1200 }),
    newGhost: new THREE.MeshBasicMaterial({ color: 0xe8590c, transparent: true, opacity: 0.18, depthWrite: false }),
    ghost: new THREE.MeshBasicMaterial({ color: 0x8a96a3, transparent: true, opacity: 0.08, depthWrite: false }),
    src: new THREE.MeshStandardMaterial({ color: 0x2f9e44, metalness: 0.05, roughness: 0.5, emissive: 0x0b2a12 }),
    dst: new THREE.MeshStandardMaterial({ color: 0x1971c2, metalness: 0.05, roughness: 0.5, emissive: 0x061a33 }),
    dim: new THREE.MeshStandardMaterial({ color: 0xc9cfd6, metalness: 0.1, roughness: 0.7, transparent: true, opacity: 0.55, depthWrite: false }),
  };
  arrowMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(ARROW), roughness: 0.45, emissive: 0x06223f });
  renderer.domElement.addEventListener('pointerdown', e => { downAt = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', onPick);
  offRenderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  offRenderer.setPixelRatio(1);
  offCamera = new THREE.PerspectiveCamera(30, 1, 1, 100000); scene.add(offCamera);
  offCamera.add(d1.clone()); offCamera.add(d2.clone());
  const loop = () => {
    requestAnimationFrame(loop);
    if (!renderer.domElement.isConnected) return;
    if (controls.update() || needRender) { needRender = false; renderer.render(scene, camera); }
  };
  loop();
}
function attachViewer(el) {
  initThree();
  el.prepend(renderer.domElement);
  resizeObs?.disconnect();
  resizeObs = new ResizeObserver(() => {
    const w = el.clientWidth, h = el.clientHeight; if (!w || !h) return;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); needRender = true;
  });
  resizeObs.observe(el);
}
function disposeScene() {
  for (const m of meshes) scene?.remove(m);
  for (const m of ghostMeshes) scene?.remove(m);
  S.parts.forEach(p => p.geom?.dispose());
  meshes.length = 0; ghostMeshes.length = 0;
}
function buildScene() {
  initThree();
  modelBox.makeEmpty();
  for (const p of S.parts) {
    const m = new THREE.Mesh(p.geom, mats.placed); m.userData.id = p.id; scene.add(m); meshes.push(m);
    const g = new THREE.Mesh(p.geom, mats.newGhost); g.visible = false; g.renderOrder = 2; scene.add(g); ghostMeshes.push(g);
    modelBox.union(p.box);
  }
  setUp();
}
function setUp() {
  const up = S.meta.upAxis === 'y' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  camera.up.copy(up); offCamera.up.copy(up);
}
const DIRV = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map(a => new THREE.Vector3(...a));
const isoDir = () => S.meta.upAxis === 'y' ? new THREE.Vector3(1, 0.9, 1.25).normalize() : new THREE.Vector3(1, -1.25, 0.9).normalize();
function partsBox(ids) { const b = new THREE.Box3(); ids.forEach(id => b.union(S.parts[id].box)); return b; }
function explodeOffset(si) {
  const st = S.steps[si]; if (!S.meta.explode || st.kind === 'base' || st.dir < 0) return null;
  const sz = partsBox(st.parts).getSize(new THREE.Vector3());
  const along = [sz.x, sz.y, sz.z][st.dir >> 1];
  const diag = modelBox.getSize(new THREE.Vector3()).length();
  return DIRV[st.dir].clone().multiplyScalar(Math.min(Math.max(along * 1.3, diag * 0.06, 15), diag * 0.35));
}
function makeArrow(from, dir, len) {
  const diag = modelBox.getSize(new THREE.Vector3()).length();
  const r = Math.max(diag * 0.0035, Math.min(len * 0.035, diag * 0.006));
  const headL = Math.min(len * 0.32, r * 9), headR = r * 3;
  const g = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len - headL, 16), arrowMat); shaft.position.y = (len - headL) / 2;
  const head = new THREE.Mesh(new THREE.ConeGeometry(headR, headL, 24), arrowMat); head.position.y = len - headL / 2;
  g.add(shaft, head); g.position.copy(from);
  g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  return g;
}
function applyStep(si) {
  const st = S.steps[si]; if (!st) return;
  clearWires();
  if (st.kind === 'wire') { arrowGroup.clear(); st._box = applyWireStep(st); needRender = true; return; }
  const placed = placedBefore(si); const now = new Set(st.parts);
  const off = explodeOffset(si);
  const baseIds = new Set(S.steps[0]?.parts || []);
  meshes.forEach((m, id) => {
    m.position.set(0, 0, 0); ghostMeshes[id].visible = false;
    if (now.has(id)) { m.visible = true; m.material = mats.newp; if (off) { m.position.copy(off); ghostMeshes[id].visible = true; } }
    else if (placed.has(id)) { m.visible = true; m.material = baseIds.has(id) ? mats.base : mats.placed; }
    else { m.visible = S.meta.ghost; m.material = mats.ghost; }
  });
  arrowGroup.children.forEach(c => c.children.forEach(x => x.geometry?.dispose()));
  arrowGroup.clear();
  if (off) {
    const c = partsBox(st.parts).getCenter(new THREE.Vector3());
    const len = off.length();
    arrowGroup.add(makeArrow(c.clone().add(off.clone().multiplyScalar(0.92)), off.clone().normalize().negate(), len * 0.8));
  }
  needRender = true;
}
function autoCam(si, cam, aspect) {
  const st = S.steps[si];
  if (st.kind === 'wire') {
    const bx = (st._box && !st._box.isEmpty()) ? st._box.clone() : modelBox.clone();
    const sph = bx.getBoundingSphere(new THREE.Sphere()); const r = Math.max(sph.radius * 1.15, modelBox.getSize(new THREE.Vector3()).length() * 0.22);
    const fov = cam.fov * Math.PI / 180; const fit = Math.min(fov, 2 * Math.atan(Math.tan(fov / 2) * aspect)); const dist = r / Math.sin(fit / 2) * 1.05;
    return { p: sph.center.clone().add(isoDir().multiplyScalar(dist)).toArray(), t: sph.center.toArray(), near: dist / 100, far: dist * 20 };
  }
  const b = st.kind === 'base' ? modelBox.clone() : partsBox(st.parts);
  const off = explodeOffset(si); if (off) { const nb = partsBox(st.parts); nb.translate(off); b.union(nb); }
  const minR = modelBox.getSize(new THREE.Vector3()).length() * 0.09;
  const sphere = b.getBoundingSphere(new THREE.Sphere());
  const r = Math.max(sphere.radius * (st.kind === 'base' ? 0.92 : 1.15), minR);
  let dir = isoDir();
  if (st.dir >= 0 && st.kind !== 'base') dir = dir.clone().add(DIRV[st.dir].clone().multiplyScalar(0.9)).normalize();
  const fov = cam.fov * Math.PI / 180; const fit = Math.min(fov, 2 * Math.atan(Math.tan(fov / 2) * aspect));
  const dist = r / Math.sin(fit / 2) * 1.05;
  return { p: sphere.center.clone().add(dir.multiplyScalar(dist)).toArray(), t: sphere.center.toArray(), near: dist / 100, far: dist * 20 };
}
function setCam(cam, v, ctrl) {
  cam.position.fromArray(v.p); cam.near = v.near || 1; cam.far = v.far || 1e5; cam.updateProjectionMatrix();
  if (ctrl) { ctrl.target.fromArray(v.t); ctrl.update(); } else cam.lookAt(new THREE.Vector3().fromArray(v.t));
}
const camFor = (si, cam, aspect) => S.steps[si].cam || autoCam(si, cam, aspect);
function showStep(si) { applyStep(si); setCam(camera, camFor(si, camera, camera.aspect), controls); }
function renderTo(si, w, h, bg) {
  offRenderer.setSize(w, h, false);
  offRenderer.setClearColor(new THREE.Color(bg || VIEWER_BG));
  offCamera.aspect = w / h; offCamera.updateProjectionMatrix();
  applyStep(si);
  setCam(offCamera, camFor(si, offCamera, w / h));
  offRenderer.render(scene, offCamera);
  return offRenderer.domElement;
}
function onPick(e) {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  const r = renderer.domElement.getBoundingClientRect();
  const v = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  const rc = new THREE.Raycaster(); rc.setFromCamera(v, camera);
  const hit = rc.intersectObjects(meshes.filter(m => m.visible && m.material !== mats.ghost), false)[0];
  if (pickMode) {
    if (!hit) return;
    const E = elecInit(); const b = pickMode.bmk;
    if (pickMode.mode === 'marker') E.map[b] = { type: 'marker', p: hit.point.toArray() };
    else E.map[b] = { type: 'part', ids: [hit.object.userData.id] };
    toast(shortBmk(b) + (pickMode.mode === 'marker' ? ': Position gesetzt' : ' → ' + labelOf(S.parts[hit.object.userData.id])));
    pickMode = null; updateUse(); regenTexts(); renderIns(); showStep(S.sel); thumbs.clear(); scheduleThumbs(); return;
  }
  const box = $('#cad-pick', ROOT); if (!box) return;
  if (!hit) { box.hidden = true; return; }
  const id = hit.object.userData.id; const p = S.parts[id]; const b = bomOf(p);
  const si = S.steps.findIndex(s => s.parts.includes(id));
  box.innerHTML = `<b>${esc(labelOf(p))}</b>
    <span class="tiny">${b ? 'Pos. ' + esc(b.pos) + ' · ' + esc(b.art) : 'nicht in der Stückliste zugeordnet'} · montiert in Schritt ${si + 1}</span>
    <div class="row" style="margin-top:6px">${si !== S.sel ? `<button class="btn sm primary" data-cad="movehere" data-id="${id}">In Schritt ${S.sel + 1} verschieben</button>` : ''}<button class="btn sm ghost" data-cad="pickclose">Schließen</button></div>`;
  box.hidden = false;
}

// ======================= Oberfläche =======================
const STYLE = `
.cad-drops{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
.cad-drop{position:relative;display:block;background:#fff;border:2px dashed #d6c0cb;border-radius:var(--r);padding:16px;cursor:pointer;min-height:150px}
.cad-drop:hover,.cad-drop.over{border-color:var(--brand);background:var(--brand-soft)}
.cad-drop.filled{border-style:solid;border-color:var(--ok);background:#fff}
.cad-drop input{position:absolute;inset:0;opacity:0;cursor:pointer;min-height:0}
.cad-drop .ic{font-size:26px}
.cad-drop b{display:block;font-size:17px;margin:4px 0 2px}
.cad-drop .file{display:block;margin-top:8px;font-weight:600;color:var(--ok);word-break:break-all;font-size:14px}
.cad-prog-row{display:grid;grid-template-columns:22px 1fr auto;gap:10px;align-items:center;font-size:14px;color:var(--ink3);padding:3px 0}
.cad-prog-row .d{width:14px;height:14px;border-radius:50%;border:2px solid #d3d3d8}
.cad-prog-row.active{color:var(--ink);font-weight:600}.cad-prog-row.active .d{border-color:var(--brand);border-top-color:transparent;animation:rot .8s linear infinite}
.cad-prog-row.done{color:var(--ink2)}.cad-prog-row.done .d{border-color:var(--ok);background:var(--ok)}
.cad-bar{height:5px;border-radius:3px;background:#ececf0;overflow:hidden;margin-top:8px}.cad-bar i{display:block;height:100%;width:0;background:var(--brand);transition:width .2s}
.cad-how{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px}
.cad-how b{display:block;color:var(--brand)}
.cad-work{display:grid;grid-template-columns:290px minmax(0,1fr) 360px;gap:14px;align-items:start}
.cad-list{display:flex;flex-direction:column;gap:6px;max-height:calc(100vh - 210px);overflow:auto;padding:2px}
.cad-step{display:grid;grid-template-columns:24px 64px minmax(0,1fr) auto;gap:8px;align-items:center;background:#fff;border-radius:var(--r-s);box-shadow:var(--shadow);padding:6px;cursor:pointer;border:2px solid transparent;position:relative}
.cad-step.sel{border-color:var(--brand)}
.cad-step.drag-over::before{content:"";position:absolute;left:6px;right:6px;top:-5px;height:3px;border-radius:2px;background:var(--brand)}
.cad-step .num{font-weight:800;color:var(--brand);text-align:center}
.cad-step img{width:64px;height:60px;border-radius:8px;object-fit:cover;background:#eceef1;display:block}
.cad-step .t{font-weight:600;font-size:14px;line-height:1.25;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.cad-step .mv{display:flex;flex-direction:column}
.cad-step .mv button{width:32px;height:28px;border:0;background:transparent;color:var(--ink2);border-radius:6px}
.cad-step .mv button:disabled{opacity:.25}
@media(pointer:coarse){.cad-step{grid-template-columns:24px 64px minmax(0,1fr) auto}.cad-step .mv button{width:44px;height:40px}}
.cad-viewer{position:relative;height:calc(100vh - 210px);min-height:380px;border-radius:var(--r);overflow:hidden;background:${VIEWER_BG};box-shadow:var(--shadow)}
.cad-viewer canvas{display:block;width:100%;height:100%;touch-action:none}
.cad-vtop{position:absolute;left:10px;right:10px;top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:flex-start;pointer-events:none}
.cad-vtop>*{pointer-events:auto}
.cad-vtitle{background:rgba(255,255,255,.94);border-radius:10px;padding:8px 12px;box-shadow:var(--shadow);margin-right:auto;max-width:100%}
.cad-vtitle .k{font-size:12px;font-weight:700;color:var(--brand);text-transform:uppercase;letter-spacing:.04em}
.cad-vtitle .h{font-weight:700}
.cad-tools{display:flex;gap:4px;background:rgba(255,255,255,.94);border-radius:10px;padding:4px;box-shadow:var(--shadow);flex-wrap:wrap}
.cad-tg{border:0;background:transparent;border-radius:7px;padding:6px 10px;font-size:13px;font-weight:600;color:var(--ink2);min-height:34px}
.cad-tg[aria-pressed="true"]{background:var(--brand-soft);color:var(--brand)}
.cad-nav{position:absolute;left:50%;bottom:12px;transform:translateX(-50%);display:flex;gap:6px;align-items:center;background:rgba(255,255,255,.95);border-radius:999px;padding:4px;box-shadow:var(--shadow)}
.cad-nav button{width:38px;height:38px;border-radius:50%;border:1.5px solid var(--line);background:#fff;font-size:18px}
.cad-nav span{min-width:64px;text-align:center;font-weight:700;font-variant-numeric:tabular-nums}
.cad-legend{position:absolute;left:10px;bottom:14px;font-size:12px;color:var(--ink2);background:rgba(255,255,255,.88);border-radius:8px;padding:4px 8px}
.cad-legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin:0 4px 0 8px;vertical-align:-1px}
.cad-pick{position:absolute;right:10px;bottom:62px;max-width:300px;background:#fff;border-radius:12px;box-shadow:var(--shadow);padding:10px 12px;display:grid;gap:2px;font-size:14px}
.cad-ptab{width:100%;border-collapse:collapse;font-size:13px}
.cad-ptab td,.cad-ptab th{padding:6px 4px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
.cad-ptab th{font-size:11.5px;color:var(--ink3);text-transform:uppercase;letter-spacing:.04em}
.cad-ptab select{min-height:34px;padding:4px 6px;font-size:13px}
.cad-maptab{width:100%;border-collapse:collapse;font-size:13.5px;table-layout:fixed}
.cad-maptab td,.cad-maptab th{padding:6px 4px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle}
.cad-maptab td:first-child{overflow-wrap:anywhere}
.cad-maptab select{min-height:38px;padding:5px 6px;font-size:13px}
.cad-dirsel{min-height:40px;padding:6px 8px}
.el-tab input.el-in{min-height:32px;padding:4px 6px;font-size:12.5px;width:100%;min-width:70px}
.el-tab input[type=checkbox]{width:18px;height:18px;min-height:0}
.el-tab tr.off td{opacity:.5}
.chip.scan{background:#fff6bf;color:#6b5a00}
@media(min-width:1700px){.cad-work{grid-template-columns:340px minmax(0,1fr) 440px;gap:18px}}
@media(max-width:1180px){.cad-work{grid-template-columns:260px minmax(0,1fr)}.cad-work .cad-ins{grid-column:1/-1}}
@media(max-width:760px){.cad-work{display:flex;flex-direction:column}.cad-viewer{height:52vh;width:100%}.cad-list{max-height:none}.cad-legend{display:none}.cad-work>*{width:100%}}
`;
function ensureStyle() { if (!document.getElementById('cad-style')) { const s = document.createElement('style'); s.id = 'cad-style'; s.textContent = STYLE; document.head.appendChild(s); } }

let thumbs = new Map(), thumbTimer = null;
function scheduleThumbs() { clearTimeout(thumbTimer); thumbTimer = setTimeout(makeThumbs, 250); }
function makeThumbs() {
  if (!S.analyzed || !ROOT?.isConnected) return;
  S.steps.forEach((st, i) => thumbs.set(st.uid, renderTo(i, 192, 180).toDataURL('image/jpeg', 0.8)));
  applyStep(S.sel);
  $$('.cad-step', ROOT).forEach(li => { const img = li.querySelector('img'); const u = thumbs.get(li.dataset.uid); if (img && u) img.src = u; });
}

export function mount(root, api) {
  ROOT = root; API = api; ensureStyle(); render();
}

function render() {
  if (!ROOT) return;
  if (!S.analyzed) return renderStart();
  renderWork();
}

function renderStart() {
  ROOT.innerHTML = `
  <div class="stack">
    <div class="banner info"><b>Montageanleitung aus 3D-Modell</b><br><span class="small">STEP-Datei der Baugruppe und Stückliste laden. Die App schlägt eine Montagereihenfolge mit Bildern, Material und Texten vor. Danach übernimmst du sie als normale Anleitung und bearbeitest sie wie gewohnt.</span></div>
    <div class="cad-drops">
      <label class="cad-drop ${S.stepFile ? 'filled' : ''}" id="cad-d-step"><input type="file" id="cad-f-step" accept=".step,.stp,.STEP,.STP">
        <span class="ic">🧊</span><b>3D-Modell (STEP)</b><span class="small muted">Pflicht · Export aus SolidWorks (.step/.stp)</span>
        <span class="file" id="cad-n-step">${S.stepFile ? esc(S.stepFile.name) + ' · ' + (S.stepFile.size / 1048576).toFixed(1) + ' MB' : ''}</span></label>
      <label class="cad-drop ${S.bomFile ? 'filled' : ''}" id="cad-d-bom"><input type="file" id="cad-f-bom" accept=".xlsx,.csv,.txt">
        <span class="ic">📋</span><b>Stückliste</b><span class="small muted">Empfohlen · .xlsx oder .csv mit Pos., Art.-Nr., Benennung, Menge (optional Drehmoment)</span>
        <span class="file" id="cad-n-bom">${S.bomFile ? esc(S.bomFile.name) : ''}</span></label>
    </div>
    <button class="btn primary block" id="cad-go" ${S.stepFile ? '' : 'disabled'} style="min-height:56px">Analyse starten</button>
    <div class="card" id="cad-prog" hidden>
      <div class="cad-prog-row" data-phase="wasm"><span class="d"></span><span>STEP-Leser laden</span><span class="v"></span></div>
      <div class="cad-prog-row" data-phase="read"><span class="d"></span><span>Modell einlesen</span><span class="v"></span></div>
      <div class="cad-prog-row" data-phase="prep"><span class="d"></span><span>Geometrie aufbereiten</span><span class="v"></span></div>
      <div class="cad-prog-row" data-phase="seq"><span class="d"></span><span>Demontage simulieren → Reihenfolge</span><span class="v"></span></div>
      <div class="cad-bar"><i id="cad-bar"></i></div>
    </div>
    <div class="banner" id="cad-err" hidden></div>
    <div class="sect">So funktioniert's</div>
    <div class="card cad-how">
      <div><b>1 · Zuordnen</b><span class="small muted">STEP-Teile werden über Art.-Nr. und Benennung den Stücklistenpositionen zugeordnet.</span></div>
      <div><b>2 · Reihenfolge</b><span class="small muted">Jedes Teil wird auf freie Bahn geprüft. Umgekehrte Demontage = Montage, Schrauben und Schellen nach ihrem Bauteil.</span></div>
      <div><b>3 · Übernehmen</b><span class="small muted">Prüfen, umsortieren, dann als Anleitung anlegen – mit Bildern, Material, Werkzeug. Export als PowerPoint wie gewohnt.</span></div>
    </div>
    <p class="tiny">Alles läuft lokal im Browser, Modell und Stückliste verlassen das Gerät nicht. Für größere Modelle einen PC verwenden.</p>
  </div>`;
  const bind = (zoneId, inputId, cb) => {
    const z = $('#' + zoneId, ROOT), inp = $('#' + inputId, ROOT);
    z.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); z.classList.add('over'); });
    z.addEventListener('dragleave', () => z.classList.remove('over'));
    z.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); z.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) cb(f); });
    inp.addEventListener('change', () => { const f = inp.files[0]; if (f) cb(f); });
  };
  bind('cad-d-step', 'cad-f-step', f => { S.stepFile = f; renderStart(); });
  bind('cad-d-bom', 'cad-f-bom', f => { S.bomFile = f; renderStart(); });
  $('#cad-go', ROOT).addEventListener('click', analyze);
}

function kindChip(st) {
  if (st.kind === 'wire') return '<span class="chip scan">⚡ Elektro</span>';
  return st.kind === 'base' ? '<span class="chip">Grundteil</span>' : st.kind === 'sub' ? '<span class="chip warn">Vormontage</span>' : st.kind === 'fast' ? '<span class="chip brand">Verbindung</span>' : '';
}
function mapStatus() {
  const names = [...new Set(S.parts.map(p => p.name))];
  let unmatched = 0, qtyDiff = 0; const perRow = new Map();
  for (const n of names) { const i = S.match[n]; const c = S.parts.filter(p => p.name === n).length; if (i >= 0) perRow.set(i, (perRow.get(i) || 0) + c); else unmatched++; }
  if (S.bom) S.bom.rows.forEach((b, i) => { const c = perRow.get(i) || 0; if (c && c !== b.qty) qtyDiff++; });
  return { names, unmatched, qtyDiff, perRow };
}
let insTab = 'step';
function renderWork() {
  const st = mapStatus();
  const warn = [...S.warnings];
  if (S.bom && st.unmatched) warn.push(st.unmatched + ' STEP-Teil(e) ohne Stücklistenposition – siehe „Zuordnung“.');
  if (S.bom && st.qtyDiff) warn.push(st.qtyDiff + ' Position(en) mit abweichender Menge zwischen Modell und Stückliste.');
  ROOT.innerHTML = `
  <div style="margin-bottom:12px"><div style="font-weight:700;font-size:17px">${esc(S.meta.title)}</div><div class="tiny">${esc(S.meta.art)}${S.meta.art ? ' · ' : ''}${S.parts.length} Teile · ${S.steps.length} Schritte</div></div>
  ${warn.length ? `<div class="warnbox" style="margin-bottom:12px">⚠ ${warn.map(esc).join('<br>⚠ ')}</div>` : ''}
  <div class="cad-work">
    <div class="cad-list" id="cad-list">${S.steps.map((s, i) => `
      <div class="cad-step ${i === S.sel ? 'sel' : ''}" draggable="true" data-i="${i}" data-uid="${s.uid}">
        <span class="num">${i + 1}</span><img alt="" src="${thumbs.get(s.uid) || ''}">
        <div style="min-width:0"><div class="t">${esc(s.title)}</div><div class="chips" style="margin-top:3px">${kindChip(s)}${s.kind === 'wire' ? `<span class="chip">${wiresOf(s).length} Ader${wiresOf(s).length === 1 ? '' : 'n'}</span>` : `<span class="chip">${s.parts.length} Teil${s.parts.length === 1 ? '' : 'e'}</span>`}${s.cam ? '<span class="chip">📷 Ansicht</span>' : ''}</div></div>
        <div class="mv"><button data-cad="up" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Nach oben">▲</button><button data-cad="down" data-i="${i}" ${i === S.steps.length - 1 ? 'disabled' : ''} aria-label="Nach unten">▼</button></div>
      </div>`).join('')}</div>
    <div class="cad-viewer" id="cad-viewer">
      <div class="cad-vtop">
        <div class="cad-vtitle"><div class="k" id="cad-vk"></div><div class="h" id="cad-vh"></div></div>
        <div class="cad-tools">
          <button class="cad-tg" data-cad="explode" aria-pressed="${S.meta.explode}">Explosion</button>
          <button class="cad-tg" data-cad="ghost" aria-pressed="${S.meta.ghost}">Folgeteile</button>
          <button class="cad-tg" data-cad="camsave">Ansicht merken</button>
          <button class="cad-tg" data-cad="camauto">Auto</button>
        </div>
      </div>
      <div class="cad-legend"><i style="background:${ACCENT}"></i>neu im Schritt<i style="background:#a9b1ba"></i>bereits montiert<i style="background:${ARROW}"></i>Montagerichtung</div>
      <div class="cad-nav"><button data-cad="prev" aria-label="Vorheriger Schritt">‹</button><span id="cad-pos"></span><button data-cad="next" aria-label="Nächster Schritt">›</button></div>
      <div class="cad-pick" id="cad-pick" hidden></div>
    </div>
    <div class="cad-ins">
      <div class="seg" style="margin-bottom:10px"><button class="${insTab === 'step' ? 'on' : ''}" data-cad="ins:step">Schritt</button><button class="${insTab === 'map' ? 'on' : ''}" data-cad="ins:map">Zuordnung${S.bom && st.unmatched ? ' <span class="n" style="background:var(--warn)">!</span>' : ''}</button><button class="${insTab === 'elec' ? 'on' : ''}" data-cad="ins:elec">⚡ Elektro</button><button class="${insTab === 'opt' ? 'on' : ''}" data-cad="ins:opt">Optionen</button></div>
      <div id="cad-ins"></div>
    </div>
  </div>
  <div class="bottom"><div class="bottom-in"><button class="btn" data-cad="restart">Andere Dateien</button><button class="btn primary" data-cad="takeover">Als Anleitung übernehmen</button></div></div>`;
  attachViewer($('#cad-viewer', ROOT));
  renderIns(); updateHead(); showStep(S.sel);
  if (!thumbs.size) requestAnimationFrame(makeThumbs);
  bindList();
}
function updateHead() {
  const st = S.steps[S.sel]; if (!st) return;
  const k = $('#cad-vk', ROOT); if (k) k.textContent = 'Schritt ' + (S.sel + 1) + (st.kind === 'sub' ? ' · Vormontage' : st.kind === 'base' ? ' · Grundteil' : '');
  const h = $('#cad-vh', ROOT); if (h) h.textContent = st.title;
  const p = $('#cad-pos', ROOT); if (p) p.textContent = (S.sel + 1) + ' / ' + S.steps.length;
}
function renderIns() {
  const el = $('#cad-ins', ROOT); if (!el) return;
  if (insTab === 'map') return renderMap(el);
  if (insTab === 'opt') return renderOpt(el);
  if (insTab === 'elec') return renderElec(el);
  const st = S.steps[S.sel]; if (!st) { el.innerHTML = ''; return; }
  if (st.kind === 'wire') return renderWireIns(el, st);
  const groups = stepGroups(st);
  const stepOpts = S.steps.map((s, i) => s.kind === 'wire' ? '' : `<option value="${i}" ${i === S.sel ? 'selected' : ''}>Schritt ${i + 1}</option>`).join('') + '<option value="new">→ eigener Schritt</option>';
  el.innerHTML = `<div class="card stack">
    <div><label class="f" for="cad-ti">Überschrift</label><input id="cad-ti" value="${esc(st.title)}" maxlength="70"></div>
    <div><label class="f" for="cad-tx">Montageanweisung <span class="tiny">(jede Zeile = ein Punkt)</span></label><textarea id="cad-tx" rows="4">${esc(st.text)}</textarea>
      <div class="tiny" style="margin-top:4px">${st.auto ? 'Automatisch erzeugt – passt sich beim Umsortieren an.' : 'Manuell bearbeitet.'} <button class="btn ghost sm" data-cad="regen" style="min-height:28px;padding:0 6px">neu erzeugen</button></div></div>
    <div class="grid2">
      <div><label class="f" for="cad-to">Werkzeug</label><input id="cad-to" value="${esc(st.tools)}" placeholder="z. B. Torx TX20"></div>
      <div><label class="f" for="cad-dir">Montagerichtung</label><select id="cad-dir" class="cad-dirsel"><option value="-1">keine</option>${DIRWORD[S.meta.upAxis].map((w, i) => `<option value="${i}" ${st.dir === i ? 'selected' : ''}>${w.replace('von ', 'Von ')}</option>`).join('')}</select></div>
    </div>
    <div><label class="f" for="cad-no">Wichtiger Hinweis</label><textarea id="cad-no" rows="2" placeholder="z. B. Kabel vorher durchführen, Gewinde sichern">${esc(st.note)}</textarea></div>
  </div>
  <div class="sect">Material in diesem Schritt</div>
  <div class="card" style="padding:8px 12px"><table class="cad-ptab"><thead><tr><th>Anz.</th><th>Bezeichnung</th><th>Schritt</th></tr></thead><tbody>
    ${groups.map(g => g.ids.map((id, k) => `<tr>${k === 0 ? `<td rowspan="${g.ids.length}"><b>${g.ids.length}×</b></td><td rowspan="${g.ids.length}">${esc(g.label)}<div class="tiny" style="color:#0057b8;font-weight:600">${g.bom ? esc(g.bom.art) : 'ohne Art.-Nr.'}</div></td>` : ''}<td><select data-move="${id}" aria-label="Teil verschieben">${stepOpts}</select></td></tr>`).join('')).join('')}
  </tbody></table></div>
  <div class="row" style="margin-top:10px;flex-wrap:wrap">
    <button class="btn sm" data-cad="merge" ${S.sel === 0 ? 'disabled' : ''}>Mit vorherigem zusammenfassen</button>
  </div>
  <p class="tiny">Tipp: Im 3D-Bild ein Teil antippen, um es in diesen Schritt zu holen. Schritte per Ziehen oder ▲▼ umsortieren.</p>`;
  const on = (id, ev, fn) => $('#' + id, el).addEventListener(ev, fn);
  on('cad-ti', 'input', e => { st.title = e.target.value; st.auto = false; updateHead(); const t = $(`.cad-step[data-uid="${st.uid}"] .t`, ROOT); if (t) t.textContent = st.title; });
  on('cad-tx', 'input', e => { st.text = e.target.value; st.auto = false; });
  on('cad-to', 'input', e => { st.tools = e.target.value; st.toolsEdited = true; });
  on('cad-no', 'input', e => { st.note = e.target.value; st.noteEdited = true; });
  on('cad-dir', 'change', e => { st.dir = +e.target.value; st.cam = null; afterChange(); });
  $$('select[data-move]', el).forEach(s => s.addEventListener('change', e => movePart(+e.target.dataset.move, e.target.value === 'new' ? 'new' : +e.target.value)));
}
function renderWireIns(el, st) {
  const ws = wiresOf(st);
  el.innerHTML = `<div class="card stack">
    <div><label class="f" for="cad-ti">Überschrift</label><input id="cad-ti" value="${esc(st.title)}" maxlength="70"></div>
    <div><label class="f" for="cad-tx">Montageanweisung <span class="tiny">(jede Zeile = ein Punkt)</span></label><textarea id="cad-tx" rows="5">${esc(st.text)}</textarea>
      <div class="tiny" style="margin-top:4px">${st.auto ? 'Automatisch aus dem Schaltplan erzeugt.' : 'Manuell bearbeitet.'} <button class="btn ghost sm" data-cad="regen" style="min-height:28px;padding:0 6px">neu erzeugen</button></div></div>
    <div><label class="f" for="cad-to">Werkzeug</label><input id="cad-to" value="${esc(st.tools)}" placeholder="z. B. Schraubendreher 0,6 × 3,5"></div>
    <div><label class="f" for="cad-no">Wichtiger Hinweis</label><textarea id="cad-no" rows="2">${esc(st.note)}</textarea></div>
  </div>
  <div class="sect">Verkabelung in diesem Schritt</div>
  <div class="card" style="padding:8px 12px"><table class="cad-ptab"><thead><tr><th>von</th><th>nach</th><th>Ader</th><th></th></tr></thead><tbody>
    ${ws.map(c => `<tr><td>${esc(short(c.a))}</td><td>${esc(short(c.b))}</td><td>${esc(adern(c) || '–')}</td><td><button class="x" data-cad="wire-rm" data-id="${c.id}" aria-label="Aus Schritt entfernen" style="width:30px;height:30px">×</button></td></tr>`).join('')}
  </tbody></table></div>
  <p class="tiny"><span style="color:${SRC_COL};font-weight:700">■ Gerät</span> · <span style="color:${DST_COL};font-weight:700">■ Klemme</span> · Linie = Kabelweg (Aderfarbe, sonst gelb). Fehlt eine Klemme im Modell, im Reiter „⚡ Elektro“ ihre Position setzen.</p>`;
  const on = (id, ev, fn) => $('#' + id, el).addEventListener(ev, fn);
  on('cad-ti', 'input', e => { st.title = e.target.value; st.auto = false; updateHead(); const t = $(`.cad-step[data-uid="${st.uid}"] .t`, ROOT); if (t) t.textContent = st.title; });
  on('cad-tx', 'input', e => { st.text = e.target.value; st.auto = false; });
  on('cad-to', 'input', e => { st.tools = e.target.value; st.toolsEdited = true; });
  on('cad-no', 'input', e => { st.note = e.target.value; st.noteEdited = true; });
}
function renderMap(el) {
  if (!S.bom) { el.innerHTML = '<div class="card"><p class="small muted" style="margin:0">Keine Stückliste geladen – die Benennungen kommen aus den STEP-Teilenamen, Artikelnummern fehlen.</p></div>'; return; }
  const st = mapStatus();
  const opts = (cur) => '<option value="-1">— keine —</option>' + S.bom.rows.map((b, i) => `<option value="${i}" ${i === cur ? 'selected' : ''}>${esc(b.pos)} · ${esc(b.name)}</option>`).join('');
  const missing = S.bom.rows.filter((b, i) => !st.perRow.get(i));
  el.innerHTML = `<div class="card" style="padding:8px 12px"><table class="cad-maptab"><colgroup><col style="width:42%"><col style="width:32px"><col><col style="width:44px"></colgroup>
    <thead><tr><th>STEP-Teil</th><th>Anz.</th><th>Position</th><th></th></tr></thead><tbody>
    ${st.names.map(n => {
      const i = S.match[n]; const c = S.parts.filter(p => p.name === n).length;
      const b = i >= 0 ? S.bom.rows[i] : null; const tot = i >= 0 ? st.perRow.get(i) : 0;
      const chip = !b ? '<span class="chip warn">fehlt</span>' : tot === b.qty ? '<span class="chip" style="background:var(--ok-soft);color:var(--ok)">✓</span>' : `<span class="chip warn" title="Modell ${tot} / Stückliste ${b.qty}">${tot}/${b.qty}</span>`;
      return `<tr><td>${esc(cleanName(n))}</td><td>${c}</td><td><select data-map="${esc(n)}">${opts(i)}</select></td><td>${chip}</td></tr>`;
    }).join('')}</tbody></table></div>
    ${missing.length ? `<p class="small"><b>Nur in der Stückliste:</b> ${missing.map(b => esc(b.pos + ' ' + b.name)).join(', ')}</p>` : ''}
    <button class="btn block" data-cad="reseq" style="margin-top:10px">Reihenfolge neu berechnen</button>
    <p class="tiny">Überschreibt Schrittfolge und Texte.</p>`;
  $$('select[data-map]', el).forEach(s => s.addEventListener('change', e => { S.match[e.target.dataset.map] = +e.target.value; regenTexts(); renderWork(); }));
}
function renderOpt(el) {
  el.innerHTML = `<div class="card stack">
    <div><label class="f" for="cad-up">Oben im Modell</label><select id="cad-up" class="cad-dirsel"><option value="z" ${S.meta.upAxis === 'z' ? 'selected' : ''}>+Z ist oben (vorne = −Y)</option><option value="y" ${S.meta.upAxis === 'y' ? 'selected' : ''}>+Y ist oben (SolidWorks-Standard)</option></select>
      <div class="tiny" style="margin-top:4px">Bestimmt „von oben / von vorne“ und die Kameraansicht.</div></div>
    <div><label class="f" for="cad-mt">Produkt (für die Anleitung)</label><input id="cad-mt" value="${esc(S.meta.title)}"></div>
    <div><label class="f" for="cad-ma">Artikelnummer / Variante</label><input id="cad-ma" value="${esc(S.meta.art)}"></div>
  </div>`;
  $('#cad-up', el).addEventListener('change', e => { S.meta.upAxis = e.target.value; setUp(); S.steps.forEach(s => s.cam = null); regenTexts(); afterChange(); });
  $('#cad-mt', el).addEventListener('input', e => { S.meta.title = e.target.value; });
  $('#cad-ma', el).addEventListener('input', e => { S.meta.art = e.target.value; });
}
function bindList() {
  const list = $('#cad-list', ROOT); let dragFrom = null;
  list.addEventListener('dragstart', e => { const li = e.target.closest('.cad-step'); dragFrom = +li.dataset.i; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(dragFrom)); });
  list.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); $$('.cad-step.drag-over', list).forEach(x => x.classList.remove('drag-over')); e.target.closest('.cad-step')?.classList.add('drag-over'); });
  list.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); $$('.cad-step.drag-over', list).forEach(x => x.classList.remove('drag-over')); const li = e.target.closest('.cad-step'); if (li && dragFrom !== null) moveStep(dragFrom, +li.dataset.i); dragFrom = null; });
}
function select(i) {
  S.sel = Math.max(0, Math.min(S.steps.length - 1, i));
  const pk = $('#cad-pick', ROOT); if (pk) pk.hidden = true;
  $$('.cad-step', ROOT).forEach(li => li.classList.toggle('sel', +li.dataset.i === S.sel));
  $(`.cad-step[data-i="${S.sel}"]`, ROOT)?.scrollIntoView({ block: 'nearest' });
  if (insTab !== 'step') insTab = 'step';
  renderInsTabs(); renderIns(); updateHead(); showStep(S.sel);
}
function renderInsTabs() { $$('.cad-ins .seg button', ROOT).forEach(b => b.classList.toggle('on', b.dataset.cad === 'ins:' + insTab)); }
function moveStep(from, to) {
  if (from === to || to < 0 || to >= S.steps.length) return;
  const keep = S.steps[S.sel].uid;
  const [s] = S.steps.splice(from, 1); S.steps.splice(to, 0, s);
  S.sel = S.steps.findIndex(x => x.uid === (from === S.sel ? s.uid : keep));
  afterChange();
}
function movePart(id, to) {
  const from = S.steps.find(s => s.parts.includes(id));
  if (to === 'new') {
    from.parts = from.parts.filter(x => x !== id);
    S.steps.splice(S.steps.indexOf(from) + 1, 0, { uid: rid(), parts: [id], dir: from.dir, kind: RX_FAST.test(labelOf(S.parts[id])) ? 'fast' : 'part', title: '', text: '', note: '', tools: '', auto: true, cam: null });
  } else {
    const t = S.steps[to]; if (!t || t === from) return;
    from.parts = from.parts.filter(x => x !== id); t.parts.push(id);
  }
  afterChange();
}
function afterChange() {
  S.steps = S.steps.filter(s => s.parts.length || (s.kind === 'wire' && wiresOf(s).length));
  S.sel = Math.max(0, Math.min(S.sel, S.steps.length - 1));
  regenTexts(); renderWork(); scheduleThumbs();
}

// ======================= Elektro (V5): Schaltplan → Verdrahtungsschritte =======================
const WIRE_COLORS = { vio: 0x7048e8, vi: 0x7048e8, br: 0x8b5a2b, bn: 0x8b5a2b, sw: 0x222222, bk: 0x222222, bl: 0x1c7ed6, bu: 0x1c7ed6, rt: 0xe03131, rd: 0xe03131,
  gn: 0x2f9e44, ge: 0xf2c200, ye: 0xf2c200, gnge: 0x8bc34a, gnye: 0x8bc34a, ws: 0xf1f3f5, wh: 0xf1f3f5, gr: 0x868e96, gy: 0x868e96, or: 0xfd7e14, og: 0xfd7e14 };
const SRC_COL = '#2f9e44', DST_COL = '#1971c2', CABLE_COL = 0xf2b705;
let pickMode = null;      // {bmk, mode:'part'|'marker'}
let wireGroup = null;

function elecInit() { if (!S.elec) S.elec = { file: null, res: null, conns: [], devices: [], terminals: [], map: {}, busy: false, err: '' }; return S.elec; }
const isDev = (b) => elecInit().devices.some(d => d.bmk === b);
const descOf = (b) => (elecInit().devices.find(d => d.bmk === b) || {}).desc || '';
function devPartIds(b) { const m = elecInit().map[b]; return m && m.type === 'part' ? m.ids : []; }

async function loadSchematic(file) {
  const E = elecInit(); E.busy = true; E.err = ''; E.file = file; renderIns();
  try {
    const pdfjs = await import('../lib/pdf.js');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('../lib/pdf.worker.js', import.meta.url).href;
    const res = await parseSchematic(pdfjs, new Uint8Array(await file.arrayBuffer()));
    E.res = res;
    E.devices = res.devices; E.terminals = res.terminals;
    E.conns = res.conns.map(c => ({ id: rid(), a: c.a, b: c.b, color: c.color, cs: c.cs, page: c.page, use: false, userSet: false }));
    if (!res.textPages) E.err = 'Das PDF enthält keinen auslesbaren Text (vermutlich ein Scan). Verbindungen bitte von Hand anlegen.';
    else if (!E.conns.length) E.err = 'Es wurden keine Verbindungen erkannt. Verbindungen bitte von Hand anlegen.';
    autoMapElec(); updateUse();
  } catch (e) { console.error(e); E.err = 'Das PDF konnte nicht gelesen werden: ' + e.message; }
  finally { E.busy = false; renderIns(); }
}

// Geräte (Lüfter, Netzteil …) den 3D-Teilen zuordnen: Beschreibung ↔ Benennung, Gruppe ↔ Baugruppenname
function autoMapElec() {
  const E = elecInit(); const title = new Set(norm(S.meta.title).split(' ').filter(t => t.length > 3));
  const tok = (s) => new Set(norm(s).split(' ').filter(t => t.length > 2));
  const used = new Set(Object.values(E.map).filter(m => m.type === 'part').flatMap(m => m.ids));
  const cand = [];
  for (const d of E.devices) {
    if (E.map[d.bmk]) continue;
    const dt = tok(d.desc + ' ' + d.desc.replace(/-/g, ' '));
    const grpBonus = [...tok(d.group)].some(t => title.has(t) || [...title].some(x => x.includes(t) || t.includes(x))) ? 10 : 0;
    for (const p of S.parts) {
      const words = norm(labelOf(p)).split(' ').filter(Boolean);
      const pt = new Set(words.filter(t => t.length > 2)); let sc = 0;
      for (const t of dt) for (const u of pt) { if (t === u) sc += 2; else if (t.length > 4 && (u.includes(t) || t.includes(u))) sc += 0.5; }
      if (sc && dt.has(words[0])) sc += 1;             // Benennung beginnt mit dem Gerätenamen (z. B. "Luefter 24VDC …")
      if (sc) cand.push({ bmk: d.bmk, id: p.id, sc: sc + grpBonus });
    }
  }
  cand.sort((x, y) => y.sc - x.sc || (x.bmk < y.bmk ? -1 : 1) || x.id - y.id);
  const done = new Set();
  for (const c of cand) {
    if (done.has(c.bmk) || used.has(c.id)) continue;
    // nur zuordnen, wenn die Gruppe passt oder es keine Konkurrenz mit Gruppenbonus gibt
    if (c.sc < 10 && cand.some(o => o.id === c.id && o.sc >= 10)) continue;
    E.map[c.bmk] = { type: 'part', ids: [c.id] }; done.add(c.bmk); used.add(c.id);
  }
}
// Relevante Verbindungen: an zugeordneten Geräten, Brücken zwischen deren Klemmleisten, Zuleitungen an diese Klemmleisten
function updateUse() {
  const E = elecInit();
  const devs = new Set(E.devices.filter(d => devPartIds(d.bmk).length).map(d => d.bmk));
  const terms = new Set();
  for (const c of E.conns) for (const [x, y] of [[c.a, c.b], [c.b, c.a]]) if (x.kind === 'dev' && devs.has(x.bmk) && y.kind === 'term') terms.add(y.bmk);
  for (const b in E.map) if (E.map[b].type === 'marker' || (E.map[b].type === 'part' && !isDev(b))) terms.add(b);
  for (const c of E.conns) {
    if (c.userSet) continue;
    const ends = [c.a, c.b];
    c.use = ends.some(e => e.kind === 'dev' && devs.has(e.bmk)) ||
      (ends.every(e => e.kind === 'ext' || (e.kind === 'term' && terms.has(e.bmk))) && ends.some(e => e.kind === 'term'));
  }
}
function parseEnd(txt) {
  const E = elecInit(); txt = String(txt || '').trim();
  if (!txt) return null;
  if (/^(→|->)/.test(txt)) { const r = txt.replace(/^(→|->)\s*/, ''); const m = r.match(/^(\S+)\s*(.*)$/); return { kind: 'ext', ext: m ? m[1] : r, sig: m ? m[2] : '' }; }
  const m = txt.match(/^(.+?)[:](.+)$/); if (!m) return null;
  const known = [...E.devices.map(d => d.bmk), ...E.terminals];
  const full = known.find(b => b === m[1]) || known.find(b => shortBmk(b) === m[1].replace(/^.*-/, '')) || m[1];
  return { kind: isDev(full) ? 'dev' : 'term', bmk: full, pin: m[2].trim() };
}

// Schritte erzeugen
function buildWireSteps() {
  const E = elecInit();
  const used = E.conns.filter(c => c.use && c.a && c.b);
  if (!used.length) { toast('Keine Verbindungen ausgewählt.'); return; }
  S.steps = S.steps.filter(s => s.kind !== 'wire');
  const stepOfPart = new Map(); S.steps.forEach((s, i) => s.parts.forEach(p => stepOfPart.set(p, i)));
  const byDev = new Map(), bridges = new Map(), feeds = new Map(), rest = [];
  for (const c of used) {
    const dEnd = [c.a, c.b].find(e => e.kind === 'dev' && devPartIds(e.bmk).length) || [c.a, c.b].find(e => e.kind === 'dev');
    if (dEnd) { if (!byDev.has(dEnd.bmk)) byDev.set(dEnd.bmk, []); byDev.get(dEnd.bmk).push(c); continue; }
    if (c.a.kind === 'term' && c.b.kind === 'term') { const k = [c.a.bmk, c.b.bmk].sort().join('|'); if (!bridges.has(k)) bridges.set(k, []); bridges.get(k).push(c); continue; }
    const t = [c.a, c.b].find(e => e.kind === 'term');
    if (t) { if (!feeds.has(t.bmk)) feeds.set(t.bmk, []); feeds.get(t.bmk).push(c); continue; }
    rest.push(c);
  }
  const devOrder = [...byDev.keys()].sort((x, y) => {
    const sx = Math.min(...devPartIds(x).map(id => stepOfPart.get(id) ?? 1e9), 1e9), sy = Math.min(...devPartIds(y).map(id => stepOfPart.get(id) ?? 1e9), 1e9);
    return sx - sy || (x < y ? -1 : 1);
  });
  const mk = (sub, conns, key) => ({ uid: rid(), parts: [], dir: -1, kind: 'wire', sub, key, wires: conns.map(c => c.id), title: '', text: '', note: '', tools: '', auto: true, cam: null });
  const add = [];
  for (const b of devOrder) add.push(mk('dev', byDev.get(b), b));
  for (const [k, cs] of bridges) add.push(mk('bridge', cs, k));
  for (const [k, cs] of feeds) add.push(mk('feed', cs, k));
  if (rest.length) add.push(mk('other', rest, ''));
  S.steps.push(...add);
  S.sel = S.steps.length - add.length;
  insTab = 'step'; regenTexts(); renderWork(); scheduleThumbs();
  toast(add.length + ' Verdrahtungsschritt' + (add.length === 1 ? '' : 'e') + ' angelegt');
}
const wiresOf = (st) => (st.wires || []).map(id => elecInit().conns.find(c => c.id === id)).filter(Boolean);
const short = (e) => endLabel(e, true);
const adern = (c) => [c.color ? colorName(c.color) : '', c.cs].filter(Boolean).join(', ');
function genWireText(st) {
  // Kurzer Text – die genaue Belegung steht in der Tabelle „Verkabelung“ auf der Folie
  const ws = wiresOf(st); const lines = []; let title = '';
  const n = ws.length, aw = n === 1 ? '1 Ader' : n + ' Adern';
  const tSet = [...new Set(ws.flatMap(c => [c.a, c.b]).filter(e => e.kind === 'term').map(e => shortBmk(e.bmk)))];
  if (st.sub === 'dev') {
    const desc = descOf(st.key);
    title = (desc ? desc + ' ' : '') + shortBmk(st.key) + ' anschließen';
    lines.push(`${shortBmk(st.key)}: ${aw} an ${tSet.join(', ') || 'Klemme'} anschließen`, 'Belegung siehe Tabelle Verkabelung', 'Sitz der Adern prüfen (Zugprobe)');
  } else if (st.sub === 'bridge') {
    const [x, y] = st.key.split('|').map(shortBmk);
    title = 'Brücken ' + x + ' → ' + y + ' setzen';
    lines.push(`${n} Brücke${n === 1 ? '' : 'n'} von ${x} nach ${y} setzen`, 'Aderfarbe und Querschnitt siehe Tabelle');
  } else if (st.sub === 'feed') {
    title = 'Zuleitung an ' + shortBmk(st.key) + ' anschließen';
    lines.push(`${aw} der Zuleitung an ${shortBmk(st.key)} anschließen`, 'Belegung siehe Tabelle Verkabelung');
  } else { title = 'Weitere Verbindungen'; lines.push(aw + ' laut Tabelle anschließen'); }
  const pages = [...new Set(ws.map(c => c.page).filter(Boolean))];
  return { title, text: lines.join('\n'), tools: '', note: pages.length ? 'Laut Schaltplan Seite ' + pages.join(', ') : '' };
}
// Anker im 3D für ein Kennzeichen
function anchorOf(bmk, towards) {
  const m = elecInit().map[bmk];
  if (m && m.type === 'marker') return new THREE.Vector3().fromArray(m.p);
  if (m && m.type === 'part' && m.ids.length) {
    const b = partsBox(m.ids);
    return towards ? b.clampPoint(towards, new THREE.Vector3()) : b.getCenter(new THREE.Vector3());
  }
  return null;
}
function labelSprite(text, color) {
  const cv = document.createElement('canvas'); const ctx = cv.getContext('2d');
  const fs = 44; ctx.font = `700 ${fs}px system-ui, sans-serif`;
  const w = Math.ceil(ctx.measureText(text).width) + 36; cv.width = w; cv.height = fs + 28;
  ctx.font = `700 ${fs}px system-ui, sans-serif`;
  ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(0, 0, w, cv.height, 14) : ctx.rect(0, 0, w, cv.height); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(text, 18, cv.height / 2 + 2);
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, sizeAttenuation: false }));
  const h = 0.034; sp.scale.set(h * w / cv.height, h, 1); sp.renderOrder = 10;   // feste Größe auf dem Bild
  return sp;
}
function clearWires() {
  if (!wireGroup) return;
  wireGroup.traverse(o => { o.geometry?.dispose(); if (o.material) { o.material.map?.dispose(); o.material.dispose(); } });
  wireGroup.clear();
}
// Szene für einen Verdrahtungsschritt; liefert die Box der beteiligten Punkte
function applyWireStep(st) {
  if (!wireGroup) { wireGroup = new THREE.Group(); scene.add(wireGroup); }
  clearWires();
  const E = elecInit(); const ws = wiresOf(st);
  const diag = modelBox.getSize(new THREE.Vector3()).length(); const center = modelBox.getCenter(new THREE.Vector3());
  const up = S.meta.upAxis === 'y' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  const srcIds = new Set(), dstIds = new Set(); const box = new THREE.Box3();
  const endsBmk = new Set(ws.flatMap(c => [c.a, c.b]).filter(e => e.kind !== 'ext').map(e => e.bmk));
  for (const b of endsBmk) { const m = E.map[b]; if (m && m.type === 'part') (isDev(b) ? srcIds : dstIds).add(...m.ids); }
  meshes.forEach((m, id) => {
    m.position.set(0, 0, 0); ghostMeshes[id].visible = false; m.visible = true;
    m.material = srcIds.has(id) ? mats.src : dstIds.has(id) ? mats.dst : mats.dim;
  });
  srcIds.forEach(id => box.union(S.parts[id].box)); dstIds.forEach(id => box.union(S.parts[id].box));
  // Ersatzpositionen für nicht platzierte Klemmen: neben dem Gerät
  const fallback = new Map();
  const anchor = (e, other) => {
    if (e.kind === 'ext') return null;
    const a = anchorOf(e.bmk, other); if (a) return a;
    if (!fallback.has(e.bmk)) {
      let base = other;
      if (!base) {   // nicht platzierte Klemme: neben dem verbundenen Gerät anordnen
        const dev = E.conns.filter(c => c.use).flatMap(c => [[c.a, c.b], [c.b, c.a]]).find(([x, y]) => x.kind === 'term' && x.bmk === e.bmk && y.kind === 'dev' && devPartIds(y.bmk).length);
        base = dev ? partsBox(devPartIds(dev[1].bmk)).getCenter(new THREE.Vector3()) : center.clone();
      }
      const out = base.clone().sub(center); out.sub(up.clone().multiplyScalar(out.dot(up))); if (out.lengthSq() < 1) out.set(1, 0, 0); out.normalize();
      fallback.set(e.bmk, base.clone().add(out.multiplyScalar(diag * 0.2)).add(up.clone().multiplyScalar(diag * 0.05 * (fallback.size + 1))));
    }
    return fallback.get(e.bmk);
  };
  const labels = new Map();
  const pairs = new Map();
  ws.forEach((c, i) => {
    let A0 = anchor(c.a, null), B0 = anchor(c.b, null);
    const a = c.a.kind === 'ext' ? null : anchor(c.a, B0 || A0), b = c.b.kind === 'ext' ? null : anchor(c.b, A0 || B0);
    let pa = a, pb = b;
    if (!pa && pb) { const out = pb.clone().sub(center).normalize(); pa = pb.clone().add(out.multiplyScalar(diag * 0.22)); }
    if (!pb && pa) { const out = pa.clone().sub(center).normalize(); pb = pa.clone().add(out.multiplyScalar(diag * 0.22)); }
    if (!pa || !pb) return;
    const key = [short(c.a).split(':')[0], short(c.b).split(':')[0]].join('|');
    const n = pairs.get(key) || 0; pairs.set(key, n + 1);
    const mid = pa.clone().add(pb).multiplyScalar(0.5);
    const out = mid.clone().sub(center); if (out.lengthSq() < 1) out.copy(up); out.normalize();
    const len = pa.distanceTo(pb);
    const ctrl = mid.add(out.multiplyScalar(len * 0.25 + diag * 0.02)).add(up.clone().multiplyScalar(len * 0.12 + n * diag * 0.012));
    const curve = new THREE.QuadraticBezierCurve3(pa, ctrl, pb);
    const col = WIRE_COLORS[(c.color || '').toLowerCase()] ?? CABLE_COL;
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 40, diag * 0.0035, 8, false), new THREE.MeshStandardMaterial({ color: col, roughness: 0.45, emissive: col, emissiveIntensity: 0.15 }));
    wireGroup.add(tube);
    for (const p of [pa, pb]) { const s = new THREE.Mesh(new THREE.SphereGeometry(diag * 0.007, 12, 8), new THREE.MeshStandardMaterial({ color: col })); s.position.copy(p); wireGroup.add(s); }
    box.expandByPoint(pa); box.expandByPoint(pb); box.expandByPoint(ctrl);
    for (const [e, p] of [[c.a, pa], [c.b, pb]]) {
      const k = e.kind === 'ext' ? 'ext|' + e.ext + '|' + e.sig : e.bmk;
      if (!labels.has(k)) labels.set(k, { e, p, pins: new Set() });
      if (e.pin) labels.get(k).pins.add(e.pin);
    }
  });
  for (const [k, L] of labels) {
    const e = L.e;
    let text, col;
    if (e.kind === 'ext') { text = '→ ' + (e.sig || e.ext); col = '#495057'; }
    else { text = shortBmk(e.bmk) + (L.pins.size && !isDev(e.bmk) ? ' ' + [...L.pins].join(' / ') : ''); col = isDev(e.bmk) ? SRC_COL : DST_COL; }
    const sp = labelSprite(text, col);
    sp.position.copy(L.p).add(up.clone().multiplyScalar(diag * (e.kind === 'dev' ? 0.06 : 0.025)));
    wireGroup.add(sp);
    // nicht platzierte Klemmleiste als Würfel andeuten
    if (e.kind === 'term' && !(E.map[e.bmk] && E.map[e.bmk].type === 'part')) {
      const cube = new THREE.Mesh(new THREE.BoxGeometry(diag * 0.022, diag * 0.022, diag * 0.022), mats.dst); cube.position.copy(L.p); wireGroup.add(cube);
    }
  }
  return box;
}

function renderElec(el) {
  const E = elecInit();
  if (E.busy) { el.innerHTML = '<div class="card"><span class="spin" style="display:inline-block;vertical-align:middle"></span> Schaltplan wird ausgewertet…</div>'; return; }
  if (!E.res) {
    el.innerHTML = `<div class="card stack">
      <label class="cad-drop" id="el-drop" style="min-height:120px"><input type="file" id="el-file" accept=".pdf,application/pdf">
        <span class="ic">⚡</span><b>Schaltplan (PDF)</b><span class="small muted">Aus dem E-CAD exportiertes PDF mit markierbarem Text. Kennzeichen, Klemmstellen und Leitungen werden ausgelesen.</span></label>
      ${E.err ? `<div class="banner">${esc(E.err)}</div>` : ''}
      <p class="tiny" style="margin:0">Das PDF wird nur in diesem Browser gelesen und nicht hochgeladen.</p>
      <button class="btn sm" data-cad="el-manual">Ohne PDF: Verbindungen von Hand anlegen</button>
    </div>`;
    const inp = $('#el-file', el), z = $('#el-drop', el);
    inp.addEventListener('change', () => inp.files[0] && loadSchematic(inp.files[0]));
    z.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); z.classList.add('over'); });
    z.addEventListener('dragleave', () => z.classList.remove('over'));
    z.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); z.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) loadSchematic(f); });
    return;
  }
  const partOpts = (cur) => '<option value="">— nicht in dieser Baugruppe —</option>' + S.parts.map(p => {
    const si = S.steps.findIndex(s => s.parts.includes(p.id));
    return `<option value="${p.id}" ${cur && cur.type === 'part' && cur.ids[0] === p.id ? 'selected' : ''}>${esc(labelOf(p))}${si >= 0 ? ' (Schritt ' + (si + 1) + ')' : ''}</option>`;
  }).join('') + (cur && cur.type === 'marker' ? '<option value="marker" selected>📍 Position gesetzt</option>' : '');
  const bmkRow = (b, kind) => {
    const m = E.map[b]; const d = E.devices.find(x => x.bmk === b);
    const st = m ? '<span class="chip" style="background:var(--ok-soft);color:var(--ok)">✓</span>' : '<span class="chip">–</span>';
    return `<tr><td><b>${esc(shortBmk(b))}</b><div class="tiny">${esc(kind === 'dev' ? (d.desc || 'Gerät') + (d.group ? ' · ' + d.group : '') : 'Klemmleiste')}</div></td>
      <td><select data-elmap="${esc(b)}" aria-label="3D-Teil für ${esc(b)}">${partOpts(m)}</select>
      <div class="row" style="gap:4px;margin-top:4px"><button class="btn sm ghost" data-cad="el-pick" data-bmk="${esc(b)}" style="min-height:28px;padding:0 6px">im 3D wählen</button>${kind === 'term' ? `<button class="btn sm ghost" data-cad="el-mark" data-bmk="${esc(b)}" style="min-height:28px;padding:0 6px">📍 Position setzen</button>` : ''}</div></td><td>${st}</td></tr>`;
  };
  const used = E.conns.filter(c => c.use).length;
  const relevantDevs = E.devices.filter(d => E.map[d.bmk] || E.conns.some(c => c.use && [c.a, c.b].some(e => e.bmk === d.bmk)));
  const otherDevs = E.devices.filter(d => !relevantDevs.includes(d));
  const termsUsed = E.terminals.filter(t => E.conns.some(c => c.use && [c.a, c.b].some(e => e.bmk === t)) || E.map[t]);
  const termsOther = E.terminals.filter(t => !termsUsed.includes(t));
  const sortedConns = E.conns.slice().sort((x, y) => (y.use - x.use));
  el.innerHTML = `
  <div class="card stack">
    <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:6px"><div><b>${esc(E.file ? E.file.name : 'Manuelle Eingabe')}</b><div class="tiny">${E.res.pages || 0} Seiten · ${E.conns.length} Verbindungen · ${E.devices.length} Geräte · ${E.terminals.length} Klemmleisten</div></div>
      <button class="btn sm ghost" data-cad="el-reset">Anderes PDF</button></div>
    ${E.err ? `<div class="warnbox">⚠ ${esc(E.err)}</div>` : ''}
    ${pickMode ? `<div class="banner info"><b>${pickMode.mode === 'marker' ? 'Position für ' : 'Teil für '}${esc(shortBmk(pickMode.bmk))}</b> jetzt im 3D-Bild antippen. <button class="btn sm ghost" data-cad="el-pickcancel">Abbrechen</button></div>` : ''}
  </div>
  <div class="sect">Geräte und Klemmen im 3D-Modell</div>
  <div class="card" style="padding:8px 12px"><table class="cad-maptab"><colgroup><col style="width:34%"><col><col style="width:40px"></colgroup><tbody>
    ${relevantDevs.map(d => bmkRow(d.bmk, 'dev')).join('')}${termsUsed.map(t => bmkRow(t, 'term')).join('')}
    ${!relevantDevs.length && !termsUsed.length ? '<tr><td colspan="3" class="small muted">Noch nichts zugeordnet. Wähle unten bei „Weitere“ das passende Teil.</td></tr>' : ''}
  </tbody></table>
  ${otherDevs.length || termsOther.length ? `<details style="margin-top:6px"><summary class="small" style="cursor:pointer">Weitere Kennzeichen im Plan (${otherDevs.length + termsOther.length})</summary><table class="cad-maptab"><colgroup><col style="width:34%"><col><col style="width:40px"></colgroup><tbody>${otherDevs.map(d => bmkRow(d.bmk, 'dev')).join('')}${termsOther.map(t => bmkRow(t, 'term')).join('')}</tbody></table></details>` : ''}
  <p class="tiny" style="margin:6px 0 0">Klemmen, die im Modell fehlen, mit „📍 Position setzen“ einmal im 3D-Bild markieren.</p></div>
  <div class="sect">Verbindungen (${used} für diese Baugruppe)</div>
  <div class="card" style="padding:6px 8px;overflow-x:auto"><table class="cad-ptab el-tab"><thead><tr><th></th><th>von</th><th>nach</th><th>Ader</th></tr></thead><tbody>
    ${sortedConns.map(c => `<tr class="${c.use ? '' : 'off'}"><td><input type="checkbox" data-eluse="${c.id}" ${c.use ? 'checked' : ''} aria-label="verwenden"></td>
      <td><input class="el-in" data-elend="${c.id}:a" value="${esc(short(c.a))}"></td><td><input class="el-in" data-elend="${c.id}:b" value="${esc(short(c.b))}"></td>
      <td><input class="el-in" data-elad="${c.id}" value="${esc([c.color, c.cs].filter(Boolean).join(' '))}" placeholder="—" style="width:80px"></td></tr>`).join('')}
  </tbody></table>
  <button class="btn sm" data-cad="el-add" style="margin-top:6px">+ Verbindung</button></div>
  <button class="btn primary block" data-cad="el-build" style="margin-top:12px" ${used ? '' : 'disabled'}>Verdrahtungsschritte erzeugen (${used})</button>
  <p class="tiny">Die Schritte kommen nach der Verschraubung: je Gerät ein Schritt, dann Brücken und Zuleitungen. Vorhandene Verdrahtungsschritte werden ersetzt.</p>`;
  $$('select[data-elmap]', el).forEach(s => s.addEventListener('change', e => {
    const b = e.target.dataset.elmap, v = e.target.value;
    if (v === '') delete E.map[b]; else if (v !== 'marker') E.map[b] = { type: 'part', ids: [+v] };
    updateUse(); renderIns(); previewBmk(b);
  }));
  $$('input[data-eluse]', el).forEach(i => i.addEventListener('change', e => { const c = E.conns.find(x => x.id === e.target.dataset.eluse); c.use = e.target.checked; c.userSet = true; renderIns(); }));
  $$('input[data-elend]', el).forEach(i => i.addEventListener('change', e => {
    const [id, side] = e.target.dataset.elend.split(':'); const c = E.conns.find(x => x.id === id); const v = parseEnd(e.target.value);
    if (v) { c[side] = v; c.userSet = true; c.use = true; } else toast('Format: X8:1.2 oder → 10.F2 V+');
    regenTexts(); renderIns();
  }));
  $$('input[data-elad]', el).forEach(i => i.addEventListener('change', e => {
    const c = E.conns.find(x => x.id === e.target.dataset.elad); const t = e.target.value.trim().split(/\s+/);
    c.color = t[0] && !/\d/.test(t[0]) ? t[0] : ''; c.cs = t.filter(x => /\d/.test(x)).join(' ').replace(/(\d)$/, '$1 mm²').replace(/mm² mm²/, 'mm²'); regenTexts();
  }));
}
// Vorschau: zugeordnetes Teil kurz grün zeigen
function previewBmk(b) {
  const ids = elecInit().map[b]?.ids || [];
  if (!ids.length) return;
  meshes.forEach((m, id) => { m.visible = true; m.position.set(0, 0, 0); ghostMeshes[id].visible = false; m.material = ids.includes(id) ? mats.src : mats.dim; });
  arrowGroup.clear(); clearWires(); needRender = true;
  clearTimeout(previewBmk.t); previewBmk.t = setTimeout(() => showStep(S.sel), 1800);
}

// ======================= Übernahme in den Recorder =======================
async function takeOver() {
  const info = await API.projectForm({ area: 'funkwerk', type: 'vormontage', customer: '', product: S.meta.title, variant: S.meta.art }, 'Als Montageanleitung anlegen', 'Anlegen');
  if (!info) return;
  const stop = API.busy('Bilder werden erzeugt…');
  try {
    const steps = [];
    for (let i = 0; i < S.steps.length; i++) {
      const st = S.steps[i];
      const canvas = renderTo(i, 1600, 1500, '#ffffff');
      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.88));
      if (st.kind === 'wire') {
        steps.push({ title: st.title.slice(0, 70), instructions: st.text, warning: st.note || '', materials: [],
          tools: (st.tools || '').split(',').map(x => x.trim()).filter(Boolean).map(t => ({ tool: t, torque: '' })),
          cables: wiresOf(st).map(c => ({ designation: adern(c) || 'Ader', from: short(c.a), to: short(c.b) })),
          image: { blob, w: 1600, h: 1500 } });
        continue;
      }
      const groups = stepGroups(st);
      const torque = groups.map(g => g.bom?.torque).find(Boolean) || '';
      const toolList = (st.tools || '').split(',').map(x => x.trim()).filter(Boolean);
      const tools = toolList.length ? toolList.map((t, k) => ({ tool: t, torque: k === 0 ? (torque && !/nm/i.test(torque) ? torque + ' Nm' : torque) : '' })) : (torque ? [{ tool: '', torque: /nm/i.test(torque) ? torque : torque + ' Nm' }] : []);
      steps.push({
        title: st.title.slice(0, 70),
        instructions: st.text,
        warning: st.note || '',
        materials: groups.map(g => ({ number: g.bom?.art || '–', description: g.label, quantity: g.ids.length })),
        tools,
        image: { blob, w: 1600, h: 1500 },
      });
    }
    applyStep(S.sel);
    await API.createFromCad(info, steps);
  } catch (e) { console.error(e); toast('Übernahme fehlgeschlagen: ' + e.message); }
  finally { stop(); }
}

// ======================= Ereignisse (delegiert) =======================
document.addEventListener('click', e => {
  if (!ROOT || !ROOT.isConnected) return;
  const stepEl = e.target.closest('.cad-step');
  const el = e.target.closest('[data-cad]');
  if (!el && stepEl && ROOT.contains(stepEl)) return select(+stepEl.dataset.i);
  if (!el) return;
  const [a, x] = el.dataset.cad.split(':');
  switch (a) {
    case 'up': return moveStep(+el.dataset.i, +el.dataset.i - 1);
    case 'down': return moveStep(+el.dataset.i, +el.dataset.i + 1);
    case 'prev': return select(S.sel - 1);
    case 'next': return select(S.sel + 1);
    case 'ins': insTab = x; renderInsTabs(); return renderIns();
    case 'explode': S.meta.explode = !S.meta.explode; el.setAttribute('aria-pressed', S.meta.explode); showStep(S.sel); return scheduleThumbs();
    case 'ghost': S.meta.ghost = !S.meta.ghost; el.setAttribute('aria-pressed', S.meta.ghost); applyStep(S.sel); return scheduleThumbs();
    case 'camsave': { const st = S.steps[S.sel]; st.cam = { p: camera.position.toArray(), t: controls.target.toArray(), near: camera.near, far: camera.far }; toast('Ansicht für Schritt ' + (S.sel + 1) + ' gemerkt'); thumbs.delete(st.uid); return renderWork(); }
    case 'camauto': S.steps[S.sel].cam = null; showStep(S.sel); return scheduleThumbs();
    case 'regen': { const st = S.steps[S.sel]; st.auto = true; st.toolsEdited = false; return afterChange(); }
    case 'merge': { const st = S.steps[S.sel], prev = S.steps[S.sel - 1]; prev.parts.push(...st.parts); st.parts = []; S.sel--; return afterChange(); }
    case 'movehere': { const pk = $('#cad-pick', ROOT); if (pk) pk.hidden = true; return movePart(+el.dataset.id, S.sel); }
    case 'pickclose': { const pk = $('#cad-pick', ROOT); if (pk) pk.hidden = true; return; }
    case 'reseq': {
      el.disabled = true; el.textContent = 'Berechne …';
      return runSequence().then(() => { thumbs.clear(); insTab = 'step'; renderWork(); toast('Reihenfolge neu berechnet'); }).catch(err => toast(err.message));
    }
    case 'restart': S.analyzed = false; return render();
    case 'takeover': return takeOver();
    case 'el-manual': { const E = elecInit(); E.res = { pages: 0, textPages: 0 }; E.conns.push({ id: rid(), a: { kind: 'term', bmk: 'X1', pin: '1' }, b: { kind: 'dev', bmk: 'M1', pin: '+' }, color: '', cs: '', use: true, userSet: true, manual: true }); E.terminals = [...new Set([...E.terminals, 'X1'])]; E.devices = E.devices.some(d => d.bmk === 'M1') ? E.devices : [...E.devices, { bmk: 'M1', desc: 'Gerät' }]; return renderIns(); }
    case 'el-reset': { const E = elecInit(); E.res = null; E.file = null; E.conns = []; E.err = ''; pickMode = null; return renderIns(); }
    case 'el-pick': pickMode = { bmk: el.dataset.bmk, mode: 'part' }; renderIns(); return toast('Teil im 3D-Bild antippen');
    case 'el-mark': pickMode = { bmk: el.dataset.bmk, mode: 'marker' }; renderIns(); return toast('Stelle im 3D-Bild antippen, an der die Klemme sitzt');
    case 'el-pickcancel': pickMode = null; return renderIns();
    case 'el-add': { const E = elecInit(); E.conns.unshift({ id: rid(), a: { kind: 'term', bmk: E.terminals[0] || 'X1', pin: '1' }, b: { kind: 'dev', bmk: (E.devices[0] || {}).bmk || 'M1', pin: '+' }, color: '', cs: '', use: true, userSet: true, manual: true }); return renderIns(); }
    case 'el-build': return buildWireSteps();
    case 'wire-rm': { const st = S.steps[S.sel]; st.wires = st.wires.filter(x => x !== el.dataset.id); return afterChange(); }
  }
});
document.addEventListener('keydown', e => {
  if (!ROOT?.isConnected || !S.analyzed || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { select(S.sel + 1); e.preventDefault(); }
  if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { select(S.sel - 1); e.preventDefault(); }
});

export function isReady() { return S.analyzed; }
