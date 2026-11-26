/* PowerPoint-Import: liest Montageanleitungen im Funkwerk-Folienlayout (aus V3/V4 exportiert)
   und macht daraus wieder bearbeitbare Schritte. Läuft komplett im Browser. */
'use strict';

const PptxImport = (() => {
  const EMU = 914400;

  /* ---------- XML-Hilfen ---------- */
  const xml = s => new DOMParser().parseFromString(s, 'application/xml');
  const kids = (el, ln) => [...el.children].filter(c => c.localName === ln);
  const desc = (el, ln) => [...el.getElementsByTagNameNS('*', ln)];
  function rels(doc) {
    const m = {};
    desc(doc, 'Relationship').forEach(r => { m[r.getAttribute('Id')] = r.getAttribute('Target'); });
    return m;
  }
  function resolve(base, target) {
    if (target.startsWith('/')) return target.slice(1);
    const parts = base.split('/'); parts.pop();
    target.split('/').forEach(seg => { if (seg === '..') parts.pop(); else if (seg !== '.') parts.push(seg); });
    return parts.join('/');
  }
  function box(el) {
    const xf = desc(el, 'xfrm')[0]; if (!xf) return null;
    const off = kids(xf, 'off')[0], ext = kids(xf, 'ext')[0]; if (!off || !ext) return null;
    return { x: +off.getAttribute('x') / EMU, y: +off.getAttribute('y') / EMU, w: +ext.getAttribute('cx') / EMU, h: +ext.getAttribute('cy') / EMU };
  }
  function paraText(txBody) {
    return desc(txBody, 'p').map(p => {
      let s = '';
      [...p.getElementsByTagNameNS('*', '*')].forEach(n => { if (n.localName === 't') s += n.textContent; else if (n.localName === 'br') s += '\n'; });
      return s;
    }).join('\n').replace(/ /g, ' ');
  }

  /* ---------- Folie lesen ---------- */
  // Der Folienbaum wird mit Gruppen-Transformationen durchlaufen; Bilder in Platzhaltern bekommen ihre Lage
  // aus dem Folienlayout. Ergebnis: Texte, Tabellen, Bilder und Formen (für Markierungen auf Fotos) in Zoll.
  const RNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const rid = (el, a) => el.getAttributeNS(RNS, a) || el.getAttribute('r:' + a);
  function xfrmOf(el) {   // eigenes xfrm des Elements (nicht das von Kindformen)
    let xf;
    if (el.localName === 'graphicFrame') xf = kids(el, 'xfrm')[0];
    else { const pr = kids(el, 'spPr')[0] || kids(el, 'grpSpPr')[0]; xf = pr && kids(pr, 'xfrm')[0]; }
    if (!xf) return null;
    const off = kids(xf, 'off')[0], ext = kids(xf, 'ext')[0]; if (!off || !ext) return null;
    const r = { x: +off.getAttribute('x'), y: +off.getAttribute('y'), w: +ext.getAttribute('cx'), h: +ext.getAttribute('cy'),
      rot: (+xf.getAttribute('rot') || 0) / 60000, flipH: xf.getAttribute('flipH') === '1', flipV: xf.getAttribute('flipV') === '1' };
    const co = kids(xf, 'chOff')[0], ce = kids(xf, 'chExt')[0];
    if (co && ce) { r.cx = +co.getAttribute('x'); r.cy = +co.getAttribute('y'); r.cw = +ce.getAttribute('cx') || 1; r.ch = +ce.getAttribute('cy') || 1; }
    return r;
  }
  const phKey = (el) => { const ph = desc(el, 'ph')[0]; return ph ? { idx: ph.getAttribute('idx') || '', type: ph.getAttribute('type') || '' } : null; };
  async function relTarget(zip, path, type) {
    const rp = path.replace(/([^/]+)$/, '_rels/$1.rels'); if (!zip.has(rp)) return null;
    const r = desc(xml(await zip.text(rp)), 'Relationship').find(x => (x.getAttribute('Type') || '').endsWith('/' + type));
    return r ? resolve(path, r.getAttribute('Target')) : null;
  }
  async function placeholderBoxes(zip, path) {      // Platzhalter-Lagen aus Folienlayout und Master
    const out = [];
    const add = async (pth) => { if (!pth || !zip.has(pth)) return; const d = xml(await zip.text(pth)); desc(d, 'sp').concat(desc(d, 'pic')).forEach(sp => { const k = phKey(sp), x = xfrmOf(sp); if (k && x) out.push({ ...k, x }); }); };
    const lay = await relTarget(zip, path, 'slideLayout'); await add(lay);
    if (lay) await add(await relTarget(zip, lay, 'slideMaster'));
    return out;
  }

  async function readSlide(zip, path, slideW) {
    const doc = xml(await zip.text(path));
    const relPath = path.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels');
    const R = zip.has(relPath) ? rels(xml(await zip.text(relPath))) : {};
    const texts = [], pics = [], tables = [], shapes = [];
    let phs = null, z = 0;
    const tree = desc(doc, 'spTree')[0]; if (!tree) return { texts, pics, tables, shapes };
    // T: Kindkoordinaten (EMU) → Folie (Zoll)
    const toIn = (T, x) => { const X = T.a * x.x + T.c, Y = T.b * x.y + T.d; return { x: X / EMU, y: Y / EMU, w: x.w * T.a / EMU, h: x.h * T.b / EMU, rot: x.rot, flipH: x.flipH, flipV: x.flipV }; };
    async function phBox(el) {
      const k = phKey(el); if (!k) return null;
      if (!phs) phs = await placeholderBoxes(zip, path);
      const hit = phs.find(p => k.idx && p.idx === k.idx) || phs.find(p => k.type && p.type === k.type) || (!k.type ? phs.find(p => p.type === 'pic' || p.type === 'obj' || p.type === 'body') : null);
      return hit ? hit.x : null;
    }
    async function walk(node, T) {
      for (const el of [...node.children]) {
        const ln = el.localName;
        if (ln === 'grpSp') {
          const g = xfrmOf(el); if (!g) { await walk(el, T); continue; }
          const sx = g.cw ? g.w / g.cw : 1, sy = g.ch ? g.h / g.ch : 1;
          const ox = g.x - (g.cx || 0) * sx, oy = g.y - (g.cy || 0) * sy;
          await walk(el, { a: T.a * sx, b: T.b * sy, c: T.a * ox + T.c, d: T.b * oy + T.d });
          continue;
        }
        if (ln === 'AlternateContent') { const ch = kids(el, 'Choice')[0] || kids(el, 'Fallback')[0]; if (ch) await walk(ch, T); continue; }
        if (ln !== 'sp' && ln !== 'pic' && ln !== 'cxnSp' && ln !== 'graphicFrame') continue;
        let x = xfrmOf(el) || (ln !== 'cxnSp' ? await phBox(el) : null); if (!x) continue;
        const b = toIn(T, x); b.z = z++;
        if (ln === 'graphicFrame') {
          const tbl = desc(el, 'tbl')[0]; if (!tbl) continue;
          const rows = kids(tbl, 'tr').map(tr => kids(tr, 'tc').map(tc => { const tb = kids(tc, 'txBody')[0]; return tb ? paraText(tb).trim() : ''; }));
          tables.push({ ...b, rows }); continue;
        }
        const spPr = kids(el, 'spPr')[0];
        const blipFill = kids(el, 'blipFill')[0] || (spPr && kids(spPr, 'blipFill')[0]);
        const blip = blipFill && desc(blipFill, 'blip')[0];
        if (blip) {
          const id = rid(blip, 'embed');
          if (id && R[id]) {
            const sr = desc(blipFill, 'srcRect')[0], crop = sr ? ['l', 't', 'r', 'b'].map(k => (+sr.getAttribute(k) || 0) / 100000) : [0, 0, 0, 0];
            pics.push({ ...b, media: resolve(path, R[id]), crop, geom: geomOf(spPr) });
          }
          if (ln === 'pic') continue;
        }
        const tb = kids(el, 'txBody')[0];
        const t = tb ? paraText(tb).trim() : '';
        if (t) texts.push({ ...b, t });
        if (spPr) shapes.push({ ...b, kind: ln, geom: geomOf(spPr) || (ln === 'cxnSp' ? 'line' : 'rect'), spPr, style: kids(el, 'style')[0], txBody: t ? tb : null, isTextBox: !!desc(el, 'cNvSpPr')[0]?.getAttribute('txBox') });
      }
    }
    await walk(tree, { a: 1, b: 1, c: 0, d: 0 });
    return { texts, pics, tables, shapes };
  }
  const geomOf = (spPr) => { const g = spPr && desc(spPr, 'prstGeom')[0]; return g ? g.getAttribute('prst') : (spPr && desc(spPr, 'custGeom')[0] ? 'custom' : null); };

  /* ---------- Farben (inkl. Design-Farben) ---------- */
  let THEME = {};
  async function readTheme(zip) {
    THEME = { dk1: '000000', lt1: 'FFFFFF', dk2: '44546A', lt2: 'E7E6E6', accent1: '4472C4', accent2: 'ED7D31', accent3: 'A5A5A5', accent4: 'FFC000', accent5: '5B9BD5', accent6: '70AD47', hlink: '0563C1', folHlink: '954F72' };
    const p = zip.has('ppt/theme/theme1.xml') ? 'ppt/theme/theme1.xml' : null; if (!p) return;
    const cs = desc(xml(await zip.text(p)), 'clrScheme')[0]; if (!cs) return;
    [...cs.children].forEach(c => { const v = c.children[0]; if (!v) return; THEME[c.localName] = v.getAttribute('val') && v.localName === 'srgbClr' ? v.getAttribute('val') : (v.getAttribute('lastClr') || THEME[c.localName]); });
  }
  const SCHEME = { tx1: 'dk1', bg1: 'lt1', tx2: 'dk2', bg2: 'lt2' };
  const PRST = { red: 'FF0000', green: '008000', blue: '0000FF', yellow: 'FFFF00', black: '000000', white: 'FFFFFF', orange: 'FFA500' };
  function colorFrom(holder) {   // holder enthält srgbClr/schemeClr/… → 'rgba(…)'
    if (!holder) return null;
    const c = [...holder.children].find(n => /^(srgbClr|schemeClr|sysClr|prstClr|scrgbClr)$/.test(n.localName)); if (!c) return null;
    let hex = c.localName === 'srgbClr' ? c.getAttribute('val') : c.localName === 'schemeClr' ? THEME[SCHEME[c.getAttribute('val')] || c.getAttribute('val')] : c.localName === 'sysClr' ? c.getAttribute('lastClr') : c.localName === 'prstClr' ? PRST[c.getAttribute('val')] : null;
    if (c.localName === 'scrgbClr') hex = ['r', 'g', 'b'].map(k => Math.round(Math.min(1, (+c.getAttribute(k) || 0) / 100000) * 255).toString(16).padStart(2, '0')).join('');
    if (!hex) hex = '000000';
    let r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), bl = parseInt(hex.slice(4, 6), 16), al = 1;
    for (const m of c.children) {
      const v = (+m.getAttribute('val') || 0) / 100000;
      if (m.localName === 'alpha') al = v;
      else if (m.localName === 'lumMod') { r *= v; g *= v; bl *= v; }
      else if (m.localName === 'lumOff') { r += 255 * v; g += 255 * v; bl += 255 * v; }
      else if (m.localName === 'shade') { r *= v; g *= v; bl *= v; }
      else if (m.localName === 'tint') { r = 255 - (255 - r) * v; g = 255 - (255 - g) * v; bl = 255 - (255 - bl) * v; }
    }
    const cl = x => Math.max(0, Math.min(255, Math.round(x)));
    return `rgba(${cl(r)},${cl(g)},${cl(bl)},${al})`;
  }
  function shapeStyle(sh) {
    const sp = sh.spPr, st = sh.style;
    let fill = null, line = null, lw = 12700, dash = null, head = null, tail = null;
    const fNo = kids(sp, 'noFill')[0], fSol = kids(sp, 'solidFill')[0];
    if (fSol) fill = colorFrom(fSol); else if (!fNo && !kids(sp, 'gradFill')[0] && st) { const fr = kids(st, 'fillRef')[0]; if (fr && +fr.getAttribute('idx') > 0) fill = colorFrom(fr); }
    if (kids(sp, 'gradFill')[0]) { const gs = desc(kids(sp, 'gradFill')[0], 'gs')[0]; if (gs) fill = colorFrom(gs); }
    const ln = kids(sp, 'ln')[0];
    if (ln) {
      if (ln.getAttribute('w')) lw = +ln.getAttribute('w');
      if (kids(ln, 'noFill')[0]) line = null; else if (kids(ln, 'solidFill')[0]) line = colorFrom(kids(ln, 'solidFill')[0]); else if (st) { const lr = kids(st, 'lnRef')[0]; if (lr && +lr.getAttribute('idx') > 0) line = colorFrom(lr); }
      const pd = kids(ln, 'prstDash')[0]; if (pd && pd.getAttribute('val') !== 'solid') dash = pd.getAttribute('val');
      const he = kids(ln, 'headEnd')[0], te = kids(ln, 'tailEnd')[0];
      if (he && he.getAttribute('type') && he.getAttribute('type') !== 'none') head = true;
      if (te && te.getAttribute('type') && te.getAttribute('type') !== 'none') tail = true;
    } else if (st) { const lr = kids(st, 'lnRef')[0]; if (lr && +lr.getAttribute('idx') > 0) line = colorFrom(lr); }
    if (!ln && st && !line) { /* keine Linie */ }
    return { fill, line, lw: lw / EMU, dash, head, tail };
  }

  /* ---------- Foto der Folie zusammensetzen: Bilder (Zuschnitt, Drehung) + Markierungen darüber ---------- */
  function drawGeom(ctx, g, w, h) {
    ctx.beginPath();
    const arrow = (dir) => {   // Blockpfeil in (0,0,w,h) Richtung rechts, dann gedreht
      ctx.save(); const W = dir === 'u' || dir === 'd' ? h : w, H = dir === 'u' || dir === 'd' ? w : h;
      ctx.translate(w / 2, h / 2); ctx.rotate({ r: 0, d: Math.PI / 2, l: Math.PI, u: -Math.PI / 2 }[dir]); ctx.translate(-W / 2, -H / 2);
      const hl = Math.min(W * 0.5, H); ctx.moveTo(0, H * 0.25); ctx.lineTo(W - hl, H * 0.25); ctx.lineTo(W - hl, 0); ctx.lineTo(W, H / 2); ctx.lineTo(W - hl, H); ctx.lineTo(W - hl, H * 0.75); ctx.lineTo(0, H * 0.75); ctx.closePath(); ctx.restore();
    };
    switch (g) {
      case 'ellipse': case 'flowChartConnector': ctx.ellipse(w / 2, h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2); break;
      case 'roundRect': { const r = Math.min(w, h) * 0.16667; ctx.roundRect ? ctx.roundRect(0, 0, w, h, r) : ctx.rect(0, 0, w, h); break; }
      case 'line': case 'straightConnector1': case 'bentConnector2': case 'bentConnector3': case 'curvedConnector3': ctx.moveTo(0, 0); ctx.lineTo(w, h); break;
      case 'rightArrow': arrow('r'); break; case 'leftArrow': arrow('l'); break; case 'upArrow': arrow('u'); break; case 'downArrow': arrow('d'); break;
      case 'triangle': ctx.moveTo(w / 2, 0); ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath(); break;
      default: ctx.rect(0, 0, w, h);
    }
  }
  function arrowHead(ctx, x0, y0, x1, y1, size) {
    const a = Math.atan2(y1 - y0, x1 - x0); ctx.beginPath(); ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - size * Math.cos(a - 0.45), y1 - size * Math.sin(a - 0.45)); ctx.lineTo(x1 - size * Math.cos(a + 0.45), y1 - size * Math.sin(a + 0.45)); ctx.closePath(); ctx.fill();
  }
  function drawText(ctx, sh, w, h, k) {
    const ps = desc(sh.txBody, 'p'); let y = 0; const lines = [];
    for (const p of ps) {
      const runs = kids(p, 'r'); const t = runs.map(r => (kids(r, 't')[0] || {}).textContent || '').join(''); if (!t.trim()) continue;
      const rp = runs.map(r => kids(r, 'rPr')[0]).find(Boolean) || desc(p, 'endParaRPr')[0];
      const sz = (rp && +rp.getAttribute('sz') || 1800) / 100;   // pt
      const col = rp && kids(rp, 'solidFill')[0] ? colorFrom(kids(rp, 'solidFill')[0]) : 'rgba(0,0,0,1)';
      lines.push({ t, px: sz / 72 * k, col, bold: rp && rp.getAttribute('b') === '1' });
    }
    const total = lines.reduce((a, l) => a + l.px * 1.2, 0);
    const center = !sh.isTextBox;
    y = center ? (h - total) / 2 : 0.05 * k;
    for (const l of lines) {
      ctx.font = `${l.bold ? 'bold ' : ''}${l.px}px Calibri, Arial, sans-serif`; ctx.fillStyle = l.col; ctx.textBaseline = 'top';
      ctx.textAlign = center ? 'center' : 'left';
      ctx.fillText(l.t, center ? w / 2 : 0.1 * k, y + l.px * 0.1, w); y += l.px * 1.2;
    }
  }
  async function compose(cluster, shapes, getImg) {
    // Maßstab aus der Bildauflösung, höchstens 2400 px breit
    let k = 0; for (const p of cluster.pics) { const im = await getImg(p.media); if (im) k = Math.max(k, im.width * (1 - p.crop[0] - p.crop[2]) / p.w); }
    if (!k) return null;
    const B = cluster.box; k = Math.min(k, 2400 / B.w, 2400 / B.h); k = Math.max(k, 60);
    const cv = document.createElement('canvas'); cv.width = Math.round(B.w * k); cv.height = Math.round(B.h * k);
    const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
    const items = [...cluster.pics.map(p => ({ p })), ...shapes.map(s => ({ s }))].sort((a, b) => (a.p || a.s).z - (b.p || b.s).z);
    for (const it of items) {
      const o = it.p || it.s, x = (o.x - B.x) * k, y = (o.y - B.y) * k, w = o.w * k, h = o.h * k;
      ctx.save(); ctx.translate(x + w / 2, y + h / 2); if (o.rot) ctx.rotate(o.rot * Math.PI / 180); ctx.scale(o.flipH ? -1 : 1, o.flipV ? -1 : 1); ctx.translate(-w / 2, -h / 2);
      if (it.p) {
        const im = await getImg(o.media);
        if (im) {
          const [l, t, r, b] = o.crop, sx = im.width * l, sy = im.height * t, sw = im.width * (1 - l - r), sh = im.height * (1 - t - b);
          if (o.geom === 'ellipse' || o.geom === 'roundRect') { drawGeom(ctx, o.geom, w, h); ctx.clip(); }
          if (sw > 0 && sh > 0) ctx.drawImage(im, sx, sy, sw, sh, 0, 0, w, h);
        }
      } else {
        const st = shapeStyle(o), isLine = /line|Connector/.test(o.geom);
        drawGeom(ctx, o.geom, w, h);
        if (st.fill && !isLine) { ctx.fillStyle = st.fill; ctx.fill(); }
        if (st.line) {
          ctx.strokeStyle = st.line; ctx.lineWidth = Math.max(1, st.lw * k);
          if (st.dash) ctx.setLineDash([ctx.lineWidth * 3, ctx.lineWidth * 2]);
          ctx.stroke(); ctx.setLineDash([]);
          if (isLine && (st.head || st.tail)) { ctx.fillStyle = st.line; const s = Math.max(8, ctx.lineWidth * 4); if (st.tail) arrowHead(ctx, 0, 0, w, h, s); if (st.head) arrowHead(ctx, w, h, 0, 0, s); }
        }
        if (o.txBody) drawText(ctx, o, w, h, k);
      }
      ctx.restore();
    }
    const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.9));
    return blob ? URL.createObjectURL(blob) : null;
  }

  const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
  const sameTools = (a, b) => JSON.stringify(a.map(t => [t.tool || '', t.torque || ''])) === JSON.stringify(b.map(t => [t.tool || '', t.torque || '']));

  /* Liefert { info, steps (Format wie V3-JSON), stats } */
  async function parse(file) {
    const zip = await Zip.read(await file.arrayBuffer());
    if (!zip.has('ppt/presentation.xml')) throw new Error('Keine PowerPoint-Datei.');
    const pres = xml(await zip.text('ppt/presentation.xml'));
    const pr = rels(xml(await zip.text('ppt/_rels/presentation.xml.rels')));
    const order = desc(pres, 'sldId').map(s => resolve('ppt/presentation.xml', pr[s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || s.getAttribute('r:id')])).filter(Boolean);

    // Foliengröße: Positionsgrenzen sind für 13,33 × 7,5 Zoll (16:9) angegeben und werden umgerechnet
    const sz = desc(pres, 'sldSz')[0], SW = sz ? +sz.getAttribute('cx') / EMU : 13.333, SH = sz ? +sz.getAttribute('cy') / EMU : 7.5;
    const fx = SW / 13.333, fy = SH / 7.5;
    await readTheme(zip);

    const info = { customer: '', product: '', variant: '', productionArea: '', funkwerkType: '' };
    const steps = []; let labels = 0, skipped = 0, photoCount = 0, composed = 0; const badFmt = new Map();
    const imgCache = new Map();
    async function getImg(media) {     // decodiertes Bild oder null (z. B. EMF/WMF/TIFF kann der Browser nicht)
      if (!imgCache.has(media)) {
        let im = null;
        try { const b = await zip.bytes(media); const ext = media.split('.').pop().toLowerCase(); if (b) im = await createImageBitmap(new Blob([b], { type: MIME[ext] || 'application/octet-stream' })); } catch (e) { im = null; }
        imgCache.set(media, im);
      }
      return imgCache.get(media);
    }
    const mediaURL = new Map();
    async function photoURL(media) {
      if (!mediaURL.has(media)) {
        const b = await zip.bytes(media); if (!b) return null;
        const ext = media.split('.').pop().toLowerCase();
        mediaURL.set(media, URL.createObjectURL(new Blob([b], { type: MIME[ext] || 'image/png' })));
      }
      return mediaURL.get(media);
    }

    for (const path of order) {
      const S = await readSlide(zip, path);
      const titleEl = S.texts.filter(t => t.y < 0.6 * fy && t.w > 8 * fx).sort((a, b) => a.y - b.y)[0];

      // Titelfolie
      if (!titleEl && S.texts.some(t => /^Montageanleitung$/i.test(t.t))) {
        const val = key => {
          const k = S.texts.find(t => t.t.replace(/\s+/g, '') === key + ':'); if (!k) return '';
          const v = S.texts.filter(t => t !== k && Math.abs(t.y - k.y) < 0.15 * fy && t.x > k.x).sort((a, b) => a.x - b.x)[0];
          return v ? v.t.trim() : '';
        };
        info.customer = val('Kunde'); info.product = val('Produkt'); info.variant = val('Variante');
        const areaLine = S.texts.find(t => /Funkwerk (Vor|End)montage|^Elexon\b/i.test(t.t));
        if (areaLine) {
          if (/Elexon/i.test(areaLine.t)) info.productionArea = 'elexon';
          else { info.productionArea = 'funkwerk'; info.funkwerkType = /Vormontage/i.test(areaLine.t) ? 'vormontage' : 'endmontage'; }
        }
        continue;
      }
      if (!titleEl) { skipped++; continue; }

      // Label-Folien erzeugt die App selbst – nur den Bereich daraus ablesen
      if (/^(Schritt\s*\d+\s*[:.\-–]\s*)?Label\b/i.test(titleEl.t)) {
        labels++;
        if (!info.productionArea) {
          info.productionArea = 'funkwerk';
          info.funkwerkType = /Baugruppenlabel/i.test(titleEl.t) ? 'vormontage' : 'endmontage';
        }
        continue;
      }

      // Arbeitsschritt
      const m = titleEl.t.match(/^Schritt\s*\d+\s*[:.\-–]\s*([\s\S]*)$/i);
      const num = steps.length + 1;
      let title = (m ? m[1] : titleEl.t).trim();
      const right = S.texts.filter(t => t !== titleEl && t.x >= 6.2 * fx);
      const isHead = t => /^Montageanweisung$/i.test(t.t) || /^⚠\s*Hinweis$/i.test(t.t);
      const isTool = t => /^[🔧⚡]/u.test(t.t);
      const below = head => head && right.filter(t => t !== head && !isHead(t) && !isTool(t) && t.y >= head.y + 0.1 * fy && t.y <= head.y + 1.0 * fy).sort((a, b) => a.y - b.y)[0];

      const iHead = right.find(t => /^Montageanweisung$/i.test(t.t));
      const iBody = below(iHead);
      let lines = iBody ? iBody.t.split('\n').map(l => l.replace(/^\s*[•·▪\-–]\s*/, '').trim()).filter(Boolean) : [];
      if (lines.length === 1 && /^Text für Montageanweisung$/i.test(lines[0])) lines = [];
      const instructions = lines.join('\n');

      const hHead = right.find(t => /^⚠\s*Hinweis$/i.test(t.t));
      let warning = (below(hHead) || {}).t || '';
      if (warning && warning === Layout.stepHint({ instructions, warning: '' })) warning = '';

      const rows = {};
      right.filter(isTool).forEach(t => {
        const k = Math.round(t.y / fy * 10);
        rows[k] = rows[k] || { tool: '', torque: '' };
        const v = t.t.replace(/^[🔧⚡]\s*/u, '').trim();
        if (t.t.startsWith('🔧')) rows[k].tool = v; else rows[k].torque = v;
      });
      let tools = Object.keys(rows).sort((a, b) => a - b).map(k => rows[k]);
      if (tools.length && sameTools(tools, Layout.stepTools({ instructions, tools: [] }))) tools = []; // war aus dem Text erkannt

      const matT = S.tables.find(t => t.rows[0] && t.rows[0].some(c => /Artikelnummer/i.test(c)));
      const materials = matT ? matT.rows.slice(1).filter(r => r[1] && r[1] !== '-').map(r => ({
        number: r[1], description: r[2] && r[2] !== '-' && r[2] !== r[1] ? r[2] : '', quantity: parseInt(String(r[3] || '').replace(/\D+/g, ''), 10) || 1
      })) : [];
      const cabT = S.tables.find(t => t.rows[0] && /^Kabel$/i.test(t.rows[0][0] || ''));
      const cables = cabT ? cabT.rows.slice(1).map(r => ({ designation: r[0] === '-' ? '' : r[0] || '', from: r[1] === '-' ? '' : r[1] || '', to: r[2] === '-' ? '' : r[2] || '' }))
        .filter(c => c.designation || c.from || c.to) : [];

      // sichtbare Lage (gedrehte Bilder nehmen eine andere Fläche ein als ihr Rahmen)
      const vis = p => { if (!p.rot) return p; const r = p.rot * Math.PI / 180, c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r)), w = p.w * c + p.h * s, h = p.w * s + p.h * c;
        return { x: p.x + p.w / 2 - w / 2, y: p.y + p.h / 2 - h / 2, w, h }; };
      S.pics.forEach(p => { const v = vis(p); p.vx = v.x; p.vy = v.y; p.vw = v.w; p.vh = v.h; });
      const isScanIcon = p => p.x > 11.5 * fx && p.y > 6.0 * fy && p.w < 1.6 * fx;
      const isScanStep = S.pics.some(isScanIcon);
      // Fotos: alles Bildhafte unterhalb des Titels, außer Logo, Scanner-Symbol, kleine Symbole rechts, Hintergrundbilder
      const inTable = p => S.tables.some(t => p.x + p.w / 2 > t.x && p.x + p.w / 2 < t.x + t.w && p.y + p.h / 2 > t.y && p.y + p.h / 2 < t.y + t.h);
      const cand = S.pics.filter(p => p.w > 0.8 * fx && p.h > 0.45 * fy && p.y + p.h / 2 > 0.75 * fy && !isScanIcon(p) && !inTable(p)
        && !(p.x >= 6.2 * fx && p.w < 2 * fx) && !(p.w > SW * 0.9 && p.h > SH * 0.9));
      // Überlappende Bilder gehören zu einem Foto (Collage, Ausschnitt über Gesamtbild …)
      const par = cand.map((_, i) => i), f = i => par[i] === i ? i : (par[i] = f(par[i]));
      const ov = (a, b, e = 0.02) => a.vx < b.vx + b.vw + e && b.vx < a.vx + a.vw + e && a.vy < b.vy + b.vh + e && b.vy < a.vy + a.vh + e;
      cand.forEach((a, i) => cand.forEach((b, j) => { if (j > i && ov(a, b)) par[f(i)] = f(j); }));
      const cl = new Map(); cand.forEach((p, i) => { const r = f(i); if (!cl.has(r)) cl.set(r, []); cl.get(r).push(p); });
      const clusters = [...cl.values()].map(pics => {
        const x0 = Math.min(...pics.map(p => p.vx)), y0 = Math.min(...pics.map(p => p.vy)), x1 = Math.max(...pics.map(p => p.vx + p.vw)), y1 = Math.max(...pics.map(p => p.vy + p.vh));
        return { pics, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
      });
      // Reihenfolge: zeilenweise (nach Bildmitte), innerhalb der Zeile von links nach rechts
      clusters.sort((a, b) => { const ay = a.box.y + a.box.h / 2, by = b.box.y + b.box.h / 2; return Math.abs(ay - by) > 0.8 * fy ? ay - by : a.box.x - b.box.x; });
      const photos = [];
      for (const c of clusters) {
        const B = c.box, inB = (x, y) => x >= B.x - 0.01 && x <= B.x + B.w + 0.01 && y >= B.y - 0.01 && y <= B.y + B.h + 0.01;
        // Markierungen: Formen, deren Mitte (bei Linien: ein Ende) auf dem Foto liegt und die nicht größer als das Foto sind
        const marks = S.shapes.filter(sh => sh.geom !== 'custom' && sh.w <= B.w * 1.05 + 0.05 && sh.h <= B.h * 1.05 + 0.05 &&
          (inB(sh.x + sh.w / 2, sh.y + sh.h / 2) || (/line|Connector/.test(sh.geom) && (inB(sh.x, sh.y) || inB(sh.x + sh.w, sh.y + sh.h)))));
        const ok = []; for (const p of c.pics) { if (await getImg(p.media)) ok.push(p); else { const e = p.media.split('.').pop().toUpperCase(); badFmt.set(e, (badFmt.get(e) || 0) + 1); } }
        if (!ok.length) continue;
        const p0 = ok[0];
        const plain = ok.length === 1 && c.pics.length === 1 && !marks.length && !p0.rot && !p0.flipH && !p0.flipV && p0.crop.every(v => Math.abs(v) < 0.001) && (!p0.geom || p0.geom === 'rect');
        let u = null;
        if (plain) u = await photoURL(p0.media);        // unverändert: Originaldatei, volle Qualität
        else { u = await compose({ pics: ok, box: B }, marks, getImg); if (u) { composed++; mediaURL.set('composed:' + composed, u); } }
        if (u) photos.push({ data: u });
      }
      photoCount += photos.length;

      if (/^Arbeitsvorgang\s*\d+$/i.test(title) || title === lines[0]) title = '';
      steps.push({ stepNumber: num, title, instructions, warning, tools, cables, materials, isScanStep, photos });
    }

    if (!info.productionArea) info.productionArea = labels ? 'funkwerk' : 'elexon';
    if (!info.customer && !info.product && !info.variant) {
      info.product = file.name.replace(/\.pptx$/i, '').replace(/^Montageanleitung_/i, '').replace(/_\d{4}-\d{2}-\d{2}$/, '').replace(/_/g, ' ').trim();
    }
    const release = () => mediaURL.forEach(u => URL.revokeObjectURL(u));
    imgCache.forEach(im => im && im.close && im.close());
    return { info, steps, stats: { steps: steps.length, photos: photoCount, labels, skipped, composed, badFmt: [...badFmt].map(([e, n]) => `${n}× ${e}`).join(', ') }, release };
  }

  return { parse };
})();

window.PptxImport = PptxImport;
