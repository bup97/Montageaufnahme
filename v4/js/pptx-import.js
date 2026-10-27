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
  async function readSlide(zip, path) {
    const doc = xml(await zip.text(path));
    const relPath = path.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels');
    const R = zip.has(relPath) ? rels(xml(await zip.text(relPath))) : {};
    const texts = [], pics = [], tables = [];
    desc(doc, 'sp').forEach(sp => {
      const tb = kids(sp, 'txBody')[0]; const b = box(sp); if (!tb || !b) return;
      const t = paraText(tb).trim(); if (t) texts.push({ ...b, t });
    });
    desc(doc, 'pic').forEach(pic => {
      const b = box(pic); const blip = desc(pic, 'blip')[0]; if (!b || !blip) return;
      const rid = blip.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed') || blip.getAttribute('r:embed');
      if (R[rid]) pics.push({ ...b, media: resolve(path, R[rid]) });
    });
    desc(doc, 'graphicFrame').forEach(gf => {
      const tbl = desc(gf, 'tbl')[0]; const b = box(gf); if (!tbl || !b) return;
      const rows = kids(tbl, 'tr').map(tr => kids(tr, 'tc').map(tc => { const tb = kids(tc, 'txBody')[0]; return tb ? paraText(tb).trim() : ''; }));
      tables.push({ ...b, rows });
    });
    return { texts, pics, tables };
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

    const info = { customer: '', product: '', variant: '', productionArea: '', funkwerkType: '' };
    const steps = []; let labels = 0, skipped = 0, photoCount = 0;
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
      const titleEl = S.texts.filter(t => t.y < 0.6 && t.w > 8).sort((a, b) => a.y - b.y)[0];

      // Titelfolie
      if (!titleEl && S.texts.some(t => /^Montageanleitung$/i.test(t.t))) {
        const val = key => {
          const k = S.texts.find(t => t.t.replace(/\s+/g, '') === key + ':'); if (!k) return '';
          const v = S.texts.filter(t => t !== k && Math.abs(t.y - k.y) < 0.15 && t.x > k.x).sort((a, b) => a.x - b.x)[0];
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
      if (/^Label\b/i.test(titleEl.t)) {
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
      const right = S.texts.filter(t => t !== titleEl && t.x >= 6.2);
      const isHead = t => /^Montageanweisung$/i.test(t.t) || /^⚠\s*Hinweis$/i.test(t.t);
      const isTool = t => /^[🔧⚡]/u.test(t.t);
      const below = head => head && right.filter(t => t !== head && !isHead(t) && !isTool(t) && t.y >= head.y + 0.1 && t.y <= head.y + 1.0).sort((a, b) => a.y - b.y)[0];

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
        const k = Math.round(t.y * 10);
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

      const isScanStep = S.pics.some(p => p.x > 11.5 && p.y > 6.0 && p.w < 1.6);
      const photoPics = S.pics.filter(p => p.x < 6.4 && p.y > 0.75 && p.w > 0.8);
      // Reihenfolge: zeilenweise (nach Bildmitte), innerhalb der Zeile von links nach rechts
      photoPics.sort((a, b) => { const ay = a.y + a.h / 2, by = b.y + b.h / 2; return Math.abs(ay - by) > 0.8 ? ay - by : a.x - b.x; });
      const photos = [];
      for (const p of photoPics) { const u = await photoURL(p.media); if (u) photos.push({ data: u }); }
      photoCount += photos.length;

      if (/^Arbeitsvorgang\s*\d+$/i.test(title) || title === lines[0]) title = '';
      steps.push({ stepNumber: num, title, instructions, warning, tools, cables, materials, isScanStep, photos });
    }

    if (!info.productionArea) info.productionArea = labels ? 'funkwerk' : 'elexon';
    if (!info.customer && !info.product && !info.variant) {
      info.product = file.name.replace(/\.pptx$/i, '').replace(/^Montageanleitung_/i, '').replace(/_\d{4}-\d{2}-\d{2}$/, '').replace(/_/g, ' ').trim();
    }
    const release = () => mediaURL.forEach(u => URL.revokeObjectURL(u));
    return { info, steps, stats: { steps: steps.length, photos: photoCount, labels, skipped }, release };
  }

  return { parse };
})();

window.PptxImport = PptxImport;
