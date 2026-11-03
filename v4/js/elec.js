/* Funkwerk Montage-Recorder – Schaltplan-PDF auswerten (V5)
   Liest Text und Vektorlinien eines aus dem E-CAD exportierten PDFs und leitet
   eine Verbindungsliste ab: Klemmstellen (=A50-X8 1.2), Geräteanschlüsse (=A50-M4 +),
   Seitenverweise (10.F2 V+ M4-5), Aderfarbe/Querschnitt (vio 0,75 mm²).
   Läuft vollständig lokal. */

const OPS = { save: 10, restore: 11, transform: 12, moveTo: 13, lineTo: 14, curveTo: 15, curveTo2: 16, curveTo3: 17, closePath: 18, rectangle: 19,
  stroke: 20, closeStroke: 21, fill: 22, eoFill: 23, fillStroke: 24, eoFillStroke: 25, closeFillStroke: 26, closeEOFillStroke: 27, endPath: 28,
  setDash: 6, setGState: 9, setLineWidth: 2, paintFormXObjectBegin: 74, paintFormXObjectEnd: 75, constructPath: 91 };

const RX_BMK = /^[=+\-][A-Za-z0-9_.+=]*-[A-Z]{1,3}\d+[A-Za-z]?$/;          // =A50-X8, -K1, +S1=A50-X8
const RX_BMK_PIN = /^([=+\-][A-Za-z0-9_.+=]*-[A-Z]{1,3}\d+[A-Za-z]?)[.:](\d+(?:\.\d+)?)$/; // =A50-X8.1.3, -X1:3
const RX_PIN = /^\d{1,3}(?:\.\d{1,2})?$/;
const RX_REF = /^\d{1,3}\.[A-Z]\d{1,2}$/;                                   // 10.F2
const RX_COLOR = /^(vio|vi|br|bn|sw|bk|bl|bu|rt|rd|gn|ge|ye|gnge|gnye|ws|wh|gr|gy|or|og|rs|pk|tk)$/i;
const RX_CS = /^(\d+(?:[.,]\d+)?)\s*(mm²|mm2|qmm)$/i;
const COLOR_NAMES = { vio: 'violett', vi: 'violett', br: 'braun', bn: 'braun', sw: 'schwarz', bk: 'schwarz', bl: 'blau', bu: 'blau', rt: 'rot', rd: 'rot', gn: 'grün', ge: 'gelb', ye: 'gelb', gnge: 'grün-gelb', gnye: 'grün-gelb', ws: 'weiß', wh: 'weiß', gr: 'grau', gy: 'grau', or: 'orange', og: 'orange', rs: 'rosa', pk: 'rosa', tk: 'türkis' };

const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const app = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function segPointDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1]; const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
  return { d: Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy), t };
}

/* ---------- Geometrie einer Seite einsammeln ---------- */
function collectGraphics(opList, viewport) {
  const segs = [], circles = [], tris = [], rects = [], groups = [];
  let ctm = viewport.transform.slice(); const stack = []; let dashed = false; const dashStack = [];
  let pending = null; // Subpfade des letzten constructPath
  const flush = (paint) => {
    if (!pending) return;
    const filled = paint === 'fill', stroked = paint === 'stroke';
    for (const sp of pending) {
      const pts = sp.pts; if (pts.length < 2 && !sp.rect) continue;
      if (sp.rect) {
        const [x, y, w, h] = sp.rect;
        const c = [app(ctm, x, y), app(ctm, x + w, y), app(ctm, x + w, y + h), app(ctm, x, y + h)];
        const xs = c.map(p => p[0]), ys = c.map(p => p[1]);
        const box = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), dashed, filled };
        if (!dashed && stroked) rects.push(box);
        else if (dashed) groups.push(box);
        continue;
      }
      const P = pts.map(p => app(ctm, p[0], p[1]));
      const xs = P.map(p => p[0]), ys = P.map(p => p[1]);
      const bw = Math.max(...xs) - Math.min(...xs), bh = Math.max(...ys) - Math.min(...ys);
      if (sp.curve && (sp.closed || dist(P[0], P[P.length - 1]) < 0.6 || pts.length >= 9) && bw < 30 && bh < 30 && Math.abs(bw - bh) < Math.max(1, 0.25 * bw)) {
        circles.push({ c: [(Math.max(...xs) + Math.min(...xs)) / 2, (Math.max(...ys) + Math.min(...ys)) / 2], r: (bw + bh) / 4, filled });
        continue;
      }
      if (sp.curve) continue;
      if (dashed) {
        if (P.length >= 4 && bw > 20 && bh > 20) groups.push({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) });
        continue;
      }
      // geschlossenes Dreieck = Querverweis-Pfeil
      const uniq = P.filter((p, i) => i === 0 || dist(p, P[i - 1]) > 0.01);
      if (sp.closed && (uniq.length === 3 || (uniq.length === 4 && dist(uniq[0], uniq[3]) < 0.01)) && bw < 20 && bh < 20) {
        tris.push({ pts: uniq.slice(0, 3), c: [(uniq[0][0] + uniq[1][0] + uniq[2][0]) / 3, (uniq[0][1] + uniq[1][1] + uniq[2][1]) / 3], box: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) } });
        continue;
      }
      // geschlossenes Rechteck aus Linien
      if (sp.closed && uniq.length >= 4 && uniq.length <= 5) {
        const axis = uniq.every((p, i) => { const q = uniq[(i + 1) % uniq.length]; return Math.abs(p[0] - q[0]) < 0.5 || Math.abs(p[1] - q[1]) < 0.5; });
        if (axis && bw > 10 && bh > 10) { rects.push({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }); continue; }
      }
      if (!stroked && !(paint === 'fillstroke')) continue;
      for (let i = 0; i + 1 < P.length; i++) if (dist(P[i], P[i + 1]) > 0.05) segs.push([P[i], P[i + 1]]);
      if (sp.closed && P.length > 2 && dist(P[P.length - 1], P[0]) > 0.05) segs.push([P[P.length - 1], P[0]]);
    }
    pending = null;
  };
  const { fnArray, argsArray } = opList;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i], a = argsArray[i];
    switch (fn) {
      case OPS.save: stack.push(ctm.slice()); dashStack.push(dashed); break;
      case OPS.restore: if (stack.length) ctm = stack.pop(); if (dashStack.length) dashed = dashStack.pop(); break;
      case OPS.transform: ctm = mul(ctm, a); break;
      case OPS.paintFormXObjectBegin: stack.push(ctm.slice()); dashStack.push(dashed); if (a && a[0]) ctm = mul(ctm, a[0]); break;
      case OPS.paintFormXObjectEnd: if (stack.length) ctm = stack.pop(); if (dashStack.length) dashed = dashStack.pop(); break;
      case OPS.setDash: dashed = !!(a && a[0] && a[0].length && a[0].some(v => v > 0)); break;
      case OPS.setGState: if (a && a[0]) for (const kv of a[0]) if (kv[0] === 'D' && kv[1]) dashed = !!(kv[1][0] && kv[1][0].length && kv[1][0].some(v => v > 0)); break;
      case OPS.constructPath: {
        const ops = a[0], co = a[1]; let k = 0; const subs = []; let cur = null;
        for (const op of ops) {
          if (op === OPS.moveTo) { cur = { pts: [[co[k], co[k + 1]]], curve: false, closed: false }; subs.push(cur); k += 2; }
          else if (op === OPS.lineTo) { if (!cur) { cur = { pts: [], curve: false }; subs.push(cur); } cur.pts.push([co[k], co[k + 1]]); k += 2; }
          else if (op === OPS.curveTo) { if (cur) { cur.curve = true; cur.pts.push([co[k + 4], co[k + 5]], [co[k], co[k + 1]], [co[k + 2], co[k + 3]]); } k += 6; }
          else if (op === OPS.curveTo2 || op === OPS.curveTo3) { if (cur) { cur.curve = true; cur.pts.push([co[k + 2], co[k + 3]], [co[k], co[k + 1]]); } k += 4; }
          else if (op === OPS.closePath) { if (cur) cur.closed = true; }
          else if (op === OPS.rectangle) { subs.push({ rect: [co[k], co[k + 1], co[k + 2], co[k + 3]], pts: [] }); k += 4; }
        }
        pending = (pending || []).concat(subs);
        break;
      }
      case OPS.stroke: case OPS.closeStroke: if (fn === OPS.closeStroke && pending) pending.forEach(s => s.closed = true); flush('stroke'); break;
      case OPS.fill: case OPS.eoFill: flush('fill'); break;
      case OPS.fillStroke: case OPS.eoFillStroke: case OPS.closeFillStroke: case OPS.closeEOFillStroke: flush('fillstroke'); break;
      case OPS.endPath: pending = null; break;
    }
  }
  return { segs, circles, tris, rects, groups };
}

/* ---------- Text in Wörter zerlegen (mit Position) ---------- */
function collectWords(textContent, viewport) {
  // 1) Textstücke mit Lage; 2) Stücke auf gleicher Grundlinie zusammenfügen (manche PDFs setzen jeden Buchstaben einzeln);
  // 3) in Wörter zerlegen
  const scale = Math.hypot(viewport.transform[0], viewport.transform[1]);
  const items = [];
  for (const it of textContent.items) {
    if (!it.str) continue;
    const m = mul(viewport.transform, it.transform);
    const h = Math.hypot(m[2], m[3]) || 8;
    const angle = Math.atan2(m[1], m[0]);
    const w = (it.width || it.str.length * h * 0.5) * scale;
    items.push({ s: it.str, x: m[4], y: m[5], w, h, angle });
  }
  const runs = [];
  const horiz = items.filter(i => Math.abs(Math.sin(i.angle)) < 0.2).sort((p, q) => (Math.round(p.y * 2) - Math.round(q.y * 2)) || (p.x - q.x));
  for (const it of horiz) {
    const last = runs[runs.length - 1];
    if (!it.s.trim()) continue;                      // Leer-Stücke tragen oft eine falsche Breite
    if (last && Math.abs(last.y - it.y) < 0.3 * it.h && Math.abs(last.h - it.h) < 0.3 * it.h) {
      const gap = it.x - (last.x + last.w);
      if (gap > -0.3 * it.h && gap < 0.18 * it.h) { last.s += it.s; last.w = it.x + it.w - last.x; continue; }
      if (gap >= 0.18 * it.h && gap < 0.9 * it.h && !/\s$/.test(last.s)) { last.s += ' ' + it.s; last.w = it.x + it.w - last.x; continue; }
    }
    runs.push(Object.assign({}, it));
  }
  for (const it of items) if (Math.abs(Math.sin(it.angle)) >= 0.2) runs.push(Object.assign({}, it));
  const words = [];
  for (const r of runs) {
    const s = r.s, n = s.length || 1; const re = /\S+/g; let mt;
    const ca = Math.cos(r.angle), sa = Math.sin(r.angle);
    while ((mt = re.exec(s))) {
      const f0 = mt.index / n, f1 = (mt.index + mt[0].length) / n;
      const x0 = r.x + ca * r.w * f0, y0 = r.y + sa * r.w * f0, x1 = r.x + ca * r.w * f1, y1 = r.y + sa * r.w * f1;
      words.push({ s: mt[0].replace(/\u2212/g, '-'), x0: Math.min(x0, x1), x1: Math.max(x0, x1), y: (y0 + y1) / 2, h: r.h, vertical: Math.abs(sa) > 0.7,
        cx: (x0 + x1) / 2 - sa * r.h * 0.35, cy: (y0 + y1) / 2 - ca * r.h * 0.35 });
    }
  }
  return words;
}

/* ---------- Eine Seite auswerten ---------- */
function analyzePage(g, words, pageNo, pageSize) {
  const tol = 1.2;
  // Rahmen/Schriftfeld ausblenden: sehr große Rechtecke
  const rects = g.rects.filter(r => (r.x1 - r.x0) < pageSize[0] * 0.5 && (r.y1 - r.y0) < pageSize[1] * 0.5 && (r.x1 - r.x0) > 15 && (r.y1 - r.y0) > 15);
  const termCircles = g.circles.filter(c => !c.filled && c.r < 6);
  const dots = g.circles.filter(c => c.filled && c.r < 4);

  // --- Kennzeichen-Texte ---
  const bmkWords = words.filter(w => RX_BMK.test(w.s));
  const bmkPinWords = words.filter(w => RX_BMK_PIN.test(w.s));
  const pinWords = words.filter(w => RX_PIN.test(w.s) && !RX_REF.test(w.s));

  // --- Klemmstellen: Kreis + Pin-Text rechts daneben (oder Kombi-Text "=A50-X8.1.3") ---
  const terminals = [];
  const usedPin = new Set(), usedCombo = new Set();
  for (const c of termCircles) {
    let best = null, bd = 1e9;
    pinWords.forEach((w, i) => {
      if (usedPin.has(i)) return;
      const dy = Math.abs(w.cy - c.c[1]), dx = w.x0 - c.c[0];
      if (dx > -1 && dx < c.r + 3 * w.h && dy < w.h) { const d = dx + dy * 2; if (d < bd) { bd = d; best = i; } }
    });
    let combo = null, cd = 1e9;
    bmkPinWords.forEach((w, i) => {
      if (usedCombo.has(i)) return;
      const d = Math.hypot(Math.max(w.x0 - c.c[0], 0, c.c[0] - w.x1), w.cy - c.c[1]);
      if (d < 3 * w.h && d < cd) { cd = d; combo = i; }
    });
    if (combo !== null && (best === null || cd < bd)) {
      usedCombo.add(combo); const m = bmkPinWords[combo].s.match(RX_BMK_PIN);
      terminals.push({ c: c.c, r: c.r, bmk: m[1], pin: m[2], h: bmkPinWords[combo].h, explicit: true });
    } else if (best !== null) {
      usedPin.add(best);
      terminals.push({ c: c.c, r: c.r, bmk: null, pin: pinWords[best].s, h: pinWords[best].h, wordX: pinWords[best].x0 });
    }
  }
  // Kennzeichen zuordnen: nächstes Kennzeichen links in derselben Zeile
  for (const t of terminals) {
    if (t.bmk) continue;
    let best = null, bd = 1e9;
    for (const w of bmkWords) {
      if (Math.abs(w.cy - t.c[1]) > t.h * 0.9) continue;
      const dx = t.c[0] - w.x1; if (dx < -1) continue;
      if (dx < bd) { bd = dx; best = w; }
    }
    if (best && bd < 400) { t.bmk = best.s; t.bmkDist = bd; }
  }
  // Ohne Kennzeichen in der Zeile: von der nächsten Klemme mit gleicher Etage (".3") oder nächster Klemme übernehmen
  for (const t of terminals) {
    if (t.bmk) continue;
    const lvl = t.pin.split('.')[1];
    let cands = terminals.filter(o => o.bmk && o !== t && !o.guessed);
    const same = cands.filter(o => lvl && o.pin.split('.')[1] === lvl);
    if (same.length) cands = same;
    let best = null, bd = 1e9;
    for (const o of cands) { const d = dist(o.c, t.c); if (d < bd) { bd = d; best = o; } }
    if (best) { t.bmk = best.bmk; t.guessed = true; }
  }
  // Kennzeichen, die neben einer Klemme stehen, sind Leisten; die übrigen sind Geräte
  const termBmkWords = new Set();
  for (const w of bmkWords) {
    for (const t of terminals) if (t.bmk === w.s && Math.abs(w.cy - t.c[1]) < t.h && t.c[0] - w.x1 < 60 && t.c[0] - w.x1 > -1) termBmkWords.add(w);
  }

  // --- Geräte: Kennzeichen + nächstes Rechteck ---
  const devices = [];
  const pairs = [];
  for (const w of bmkWords) {
    if (termBmkWords.has(w)) continue;
    for (const r of rects) {
      // Kennzeichen steht üblicherweise links oberhalb oder links neben dem Gerät
      const d = Math.hypot(r.x0 - w.x1, r.y0 - w.cy);
      const inside = w.cx > r.x0 && w.cx < r.x1 && w.cy > r.y0 && w.cy < r.y1;
      const dd = Math.min(d, Math.hypot(Math.max(r.x0 - w.x1, 0, w.x0 - r.x1), Math.max(r.y0 - w.cy, 0, w.cy - r.y1)) * 1.6);
      if (dd < 90 || inside) pairs.push({ w, r, d: inside ? 0 : dd });
    }
  }
  pairs.sort((x, y) => x.d - y.d);
  const usedW = new Set(), usedR = new Set();
  for (const pr of pairs) {
    if (usedW.has(pr.w) || usedR.has(pr.r)) continue;
    usedW.add(pr.w); usedR.add(pr.r);
    const best = pr.r;
    const below = words.filter(x => x.cx > best.x0 - 10 && x.cx < best.x1 + 10 && x.cy > best.y1 && x.cy < best.y1 + 25 && !RX_BMK.test(x.s) && !RX_PIN.test(x.s));
    const desc = below.sort((a, b) => a.x0 - b.x0).map(x => x.s).join(' ');
    // Gruppe: gestrichelter Rahmen um das Gerät (z. B. "Wärmetauscher")
    const cx = (best.x0 + best.x1) / 2, cy = (best.y0 + best.y1) / 2;
    const grp = (g.groups || []).filter(q => cx > q.x0 && cx < q.x1 && cy > q.y0 && cy < q.y1).sort((p1, p2) => (p1.x1 - p1.x0) * (p1.y1 - p1.y0) - (p2.x1 - p2.x0) * (p2.y1 - p2.y0))[0];
    let group = '';
    if (grp) {
      const inG = words.filter(x => x.cx > grp.x0 && x.cx < grp.x1 && x.cy > grp.y0 && x.cy < grp.y1 && !RX_BMK.test(x.s) && !RX_PIN.test(x.s) && x.s.length > 2);
      const cand = inG.filter(x => !(x.cx > best.x0 - 10 && x.cx < best.x1 + 10 && x.cy > best.y0 - 5 && x.cy < best.y1 + 25));
      // Text nahe am Rahmenrand
      cand.sort((p1, p2) => Math.min(p1.cy - grp.y0, grp.y1 - p1.cy) - Math.min(p2.cy - grp.y0, grp.y1 - p2.cy));
      if (cand[0]) group = cand[0].s;
    }
    devices.push({ bmk: pr.w.s, rect: best, desc, group });
  }

  // --- Querverweise: Dreieck + "10.F2" + Signalname ---
  const refs = [];
  for (const t of g.tris) {
    const ref = words.filter(w => RX_REF.test(w.s) && Math.abs(w.cy - t.c[1]) < w.h && w.x0 > t.box.x0 - 2 && w.x0 - t.box.x1 < 30).sort((a, b) => a.x0 - b.x0)[0];
    if (!ref) continue;
    const sig = words.filter(w => w !== ref && Math.abs(w.cy - ref.cy) < ref.h * 0.6 && w.x0 > ref.x1 && w.x0 - ref.x1 < 160).sort((a, b) => a.x0 - b.x0);
    const parts = []; let lastX = ref.x1;
    for (const w of sig) { if (w.x0 - lastX > ref.h * 4) break; parts.push(w.s); lastX = w.x1; }
    refs.push({ tri: t, ref: ref.s, sig: parts.join(' ') });
  }

  // --- Linien: Segmente in Geräten (Symbolinneres) ignorieren ---
  const inRect = (p, r, pad = -1) => p[0] > r.x0 - pad && p[0] < r.x1 + pad && p[1] > r.y0 - pad && p[1] < r.y1 + pad;
  const segs = g.segs.filter(s => !devices.some(d => inRect(s[0], d.rect, -0.8) && inRect(s[1], d.rect, -0.8)))
    .filter(s => !g.tris.some(t => inRect(s[0], t.box, 1) && inRect(s[1], t.box, 1)));

  // Union-Find über Segmente
  const parent = segs.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const unite = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
  // Gitter für schnelle Nachbarsuche
  const cell = 20, grid = new Map();
  const key = (x, y) => Math.floor(x / cell) + ',' + Math.floor(y / cell);
  segs.forEach((s, i) => {
    const x0 = Math.min(s[0][0], s[1][0]), x1 = Math.max(s[0][0], s[1][0]), y0 = Math.min(s[0][1], s[1][1]), y1 = Math.max(s[0][1], s[1][1]);
    for (let gx = Math.floor((x0 - tol) / cell); gx <= Math.floor((x1 + tol) / cell); gx++)
      for (let gy = Math.floor((y0 - tol) / cell); gy <= Math.floor((y1 + tol) / cell); gy++) {
        const k = gx + ',' + gy; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i);
      }
  });
  const near = (p) => grid.get(key(p[0], p[1])) || [];
  segs.forEach((s, i) => {
    for (const p of s) for (const j of near(p)) {
      if (j === i) continue;
      const o = segs[j];
      if (dist(p, o[0]) < tol || dist(p, o[1]) < tol) { unite(i, j); continue; }
      const { d } = segPointDist(p, o[0], o[1]); if (d < tol) unite(i, j);   // T-Abzweig
    }
  });
  // Verbindungspunkte (gefüllte Punkte) verbinden alle durchlaufenden Linien
  for (const dt of dots) {
    const hit = near(dt.c).filter(j => segPointDist(dt.c, segs[j][0], segs[j][1]).d < dt.r + tol);
    for (let k = 1; k < hit.length; k++) unite(hit[0], hit[k]);
  }

  // --- Endpunkte den Objekten zuordnen ---
  const endpoints = new Map(); // comp -> Map(id -> obj)
  const addEp = (seg, obj) => { const c = find(seg); if (!endpoints.has(c)) endpoints.set(c, new Map()); endpoints.get(c).set(obj.id, obj); };
  terminals.forEach((t, ti) => { t.id = 'T' + ti; });
  devices.forEach((d, di) => { d.id = 'D' + di; });
  refs.forEach((r, ri) => { r.id = 'R' + ri; });
  const devPinLabel = (d, p) => {
    const inside = words.filter(w => inRect([w.cx, w.cy], d.rect, 2) && !RX_BMK.test(w.s) && w.s.length <= 8 && !/^M$/.test(w.s));
    let best = null, bd = 1e9;
    for (const w of inside) { const dd = Math.hypot(w.cx - p[0], w.cy - p[1]); if (dd < bd) { bd = dd; best = w; } }
    if (best && bd < 30) return best.s.replace('−', '-');
    return null;
  };
  segs.forEach((s, i) => {
    for (const p of s) {
      for (const t of terminals) if (Math.abs(dist(p, t.c) - t.r) < tol + 0.8 || dist(p, t.c) < t.r) addEp(i, { id: t.id, type: 'term', t, p });
      for (const d of devices) {
        const r = d.rect; const onX = p[0] > r.x0 - tol && p[0] < r.x1 + tol, onY = p[1] > r.y0 - tol && p[1] < r.y1 + tol;
        const edge = (onX && (Math.abs(p[1] - r.y0) < tol || Math.abs(p[1] - r.y1) < tol)) || (onY && (Math.abs(p[0] - r.x0) < tol || Math.abs(p[0] - r.x1) < tol));
        if (edge) {
          const lab = devPinLabel(d, p) || ('Anschluss ' + Math.round(p[0]) + '/' + Math.round(p[1]));
          addEp(i, { id: d.id + ':' + lab, type: 'dev', d, pin: lab, p });
        }
      }
      for (const r of refs) if (inRect(p, r.tri.box, tol + 1)) addEp(i, { id: r.id, type: 'ref', r, p });
    }
  });

  // --- Farben / Querschnitte den Netzen zuordnen ---
  const annots = [];
  words.forEach((w, i) => {
    if (RX_COLOR.test(w.s)) {
      const csW = words.find(x => x !== w && Math.abs(x.cy - w.cy) < w.h && x.x0 > w.x1 - 1 && x.x0 - w.x1 < w.h * 2.5 && /^\d+(?:[.,]\d+)?$/.test(x.s));
      const unit = csW && words.find(x => Math.abs(x.cy - w.cy) < w.h && x.x0 >= csW.x1 - 1 && x.x0 - csW.x1 < w.h * 2 && /^(mm²|mm2|qmm)$/i.test(x.s));
      annots.push({ w, color: w.s.toLowerCase(), cs: csW ? csW.s.replace('.', ',') + ' mm²' : '' , unit });
    }
  });
  const compAnn = new Map();
  for (const a of annots) {
    let best = null, bd = 1e9;
    for (const j of segs.keys()) { const { d } = segPointDist([a.w.cx, a.w.cy], segs[j][0], segs[j][1]); if (d < bd) { bd = d; best = j; } }
    if (best !== null && bd < 25) compAnn.set(find(best), a);
  }

  // --- Netze → Verbindungen ---
  const conns = [];
  const keyOf = (o) => o.type === 'term' ? 'T|' + o.t.bmk + '|' + o.t.pin.split('.')[0] : o.id;   // gleiche Klemme (Etagen) intern verbunden
  for (const [comp, m] of endpoints) {
    const eps = [...m.values()];
    if (eps.length < 2) continue;
    const groups = new Map();
    for (const e of eps) { const k = keyOf(e); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); }
    const G = [...groups.values()];
    if (G.length < 2) continue;
    // minimaler Spannbaum zwischen den Gruppen (geometrisch nächste Endpunkte)
    const inTree = [0]; const rest = G.map((_, i) => i).slice(1);
    while (rest.length) {
      let best = null;
      for (const a of inTree) for (const b of rest) {
        for (const ea of G[a]) for (const eb of G[b]) {
          const d = dist(ea.p, eb.p);
          if (!best || d < best.d) best = { a, b, ea, eb, d };
        }
      }
      inTree.push(best.b); rest.splice(rest.indexOf(best.b), 1);
      const ann = compAnn.get(comp);
      conns.push({ a: endRef(best.ea), b: endRef(best.eb), color: ann ? ann.color : '', cs: ann ? ann.cs : '', page: pageNo });
    }
  }
  return {
    conns,
    devices: devices.map(d => ({ bmk: d.bmk, desc: d.desc, group: d.group, page: pageNo })),
    terminalBmks: [...new Set(terminals.map(t => t.bmk).filter(Boolean))],
    stats: { segs: segs.length, terms: terminals.length, devs: devices.length, refs: refs.length, guessed: terminals.filter(t => t.guessed).length },
  };
}
function endRef(e) {
  if (e.type === 'term') return { bmk: e.t.bmk, pin: e.t.pin, kind: 'term' };
  if (e.type === 'dev') return { bmk: e.d.bmk, pin: e.pin, kind: 'dev' };
  return { ext: e.r.ref, sig: e.r.sig, kind: 'ext' };
}

/* ---------- Ganzes Dokument ---------- */
export async function parseSchematic(pdfjsLib, data, onProgress) {
  const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false, disableFontFace: true, useSystemFonts: false }).promise;
  const out = { pages: doc.numPages, conns: [], devices: [], terminals: new Set(), textPages: 0, stats: [] };
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const [tc, ol] = await Promise.all([page.getTextContent(), page.getOperatorList()]);
    if (tc.items.some(i => i.str && i.str.trim())) out.textPages++;
    const words = collectWords(tc, viewport);
    const g = collectGraphics(ol, viewport);
    const r = analyzePage(g, words, p, [viewport.width, viewport.height]);
    out.conns.push(...r.conns); out.devices.push(...r.devices); r.terminalBmks.forEach(b => out.terminals.add(b));
    out.stats.push(Object.assign({ page: p }, r.stats));
    page.cleanup();
    onProgress && onProgress(p / doc.numPages);
  }
  out.terminals = [...out.terminals];
  // Geräte nur einmal (erste Seite gewinnt, Beschreibung ergänzen)
  const devMap = new Map();
  for (const d of out.devices) { if (!devMap.has(d.bmk)) devMap.set(d.bmk, d); else if (!devMap.get(d.bmk).desc && d.desc) devMap.get(d.bmk).desc = d.desc; }
  out.devices = [...devMap.values()];
  await doc.destroy();
  return out;
}

export function colorName(c) { return COLOR_NAMES[String(c || '').toLowerCase()] || c || ''; }
export function shortBmk(b) { return String(b || '').replace(/^.*-/, ''); }       // =A50-X8 → X8
export function endLabel(e, short) {
  if (!e) return '';
  if (e.kind === 'ext') return '→ ' + e.ext + (e.sig ? ' ' + e.sig : '');
  return (short ? shortBmk(e.bmk) : e.bmk) + ':' + e.pin;
}
