/* Exporte: PowerPoint, Stückliste (CSV/Druck), JSON für PC-Konverter, Backup. */
'use strict';

const Export = (() => {
  const assetCache = {};
  function blobToDataURL(blob) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
  }
  async function asset(path) {
    if (!assetCache[path]) assetCache[path] = fetch(path).then(r => { if (!r.ok) throw new Error(path); return r.blob(); }).then(blobToDataURL);
    return assetCache[path];
  }
  function safe(s) { return String(s || '').replace(/[^a-zA-Z0-9äöüÄÖÜß-]+/g, '_').replace(/^_+|_+$/g, ''); }
  function fileBase(p, prefix) {
    return [prefix, safe(p.customer), safe(p.product), safe(p.variant), new Date().toISOString().slice(0, 10)].filter(Boolean).join('_');
  }

  async function loadPptx() {
    if (window.PptxGenJS) return;
    await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'lib/pptxgen.bundle.js'; s.onload = res; s.onerror = () => rej(new Error('PowerPoint-Bibliothek konnte nicht geladen werden.')); document.head.appendChild(s); });
  }

  /* Slides aus Layout-Elementen zeichnen */
  function draw(pres, slide, els, imgs) {
    slide.background = { color: 'FFFFFF' };
    els.forEach(e => {
      if (e.type === 'text') {
        const o = { x: e.x, y: e.y, w: e.w, h: e.h, fontSize: e.fontSize, bold: !!e.bold, italic: !!e.italic,
          color: e.color, align: e.align || 'left', valign: e.valign || 'top', fontFace: 'Calibri' };
        if (e.fill) o.fill = { color: e.fill };
        if (e.line) o.line = { color: e.line, width: 1 };
        if (e.shape) o.shape = e.shape === 'roundRect' ? pres.ShapeType.roundRect : pres.ShapeType.rect;
        if (e.shape === 'roundRect') o.rectRadius = 0.08;
        slide.addText(e.text, o);
      } else if (e.type === 'rect') {
        slide.addShape(pres.ShapeType.rect, { x: e.x, y: e.y, w: e.w, h: e.h, fill: { color: e.fill },
          line: e.line ? { color: e.line, width: 1, dashType: e.dash ? 'dash' : 'solid' } : { type: 'none' } });
      } else if (e.type === 'image') {
        const data = e.src === 'photo' ? imgs.photos[e.photoId] : e.src === 'label' ? imgs.labels[e.label] : imgs[e.src];
        if (data) slide.addImage({ data, x: e.x, y: e.y, w: e.w, h: e.h });
      } else if (e.type === 'table') {
        const rows = e.rows.map(r => r.map(c => ({ text: c.text, options: { ...c.o, color: c.o.color, fill: c.o.fill ? { color: c.o.fill } : undefined, fontFace: 'Calibri', valign: 'middle' } })));
        slide.addTable(rows, { x: e.x, y: e.y, w: e.w, colW: e.colW, rowH: e.rowH, border: e.border, margin: e.margin || 0.05, autoPage: false });
      }
    });
  }

  async function buildPptx(project, getPhoto) {
    await loadPptx();
    const pres = new PptxGenJS();
    pres.defineLayout({ name: 'FW_BREIT', width: 13.333, height: 7.5 });
    pres.layout = 'FW_BREIT';
    pres.author = 'Funkwerk Montage-Recorder';
    pres.title = `Montageanleitung ${[project.customer, project.product, project.variant].filter(Boolean).join(' ')}`;

    const imgs = { logo: await asset('img/logo.png'), scan: await asset('img/scan.png'), labels: {}, photos: {} };
    const labels = Layout.labelsFor(project);
    for (const l of [...labels.start, ...labels.end]) if (l.img) imgs.labels[l.key] = await asset(l.img);
    for (const s of project.steps) for (const id of (s.photoIds || []).slice(0, 4)) {
      const ph = await getPhoto(id); if (ph) imgs.photos[id] = await blobToDataURL(ph.blob);
    }
    const metas = {};
    for (const s of project.steps) metas[s.id] = await Promise.all((s.photoIds || []).map(async id => { const ph = await getPhoto(id); return ph ? { id, w: ph.w, h: ph.h } : null; })).then(a => a.filter(Boolean));

    draw(pres, pres.addSlide(), Layout.layoutTitleSlide(project, project.steps.length).els, imgs);
    labels.start.forEach(l => draw(pres, pres.addSlide(), Layout.layoutLabelSlide(l).els, imgs));
    project.steps.forEach((s, i) => draw(pres, pres.addSlide(), Layout.layoutStepSlide(s, i + 1, metas[s.id]).els, imgs));
    labels.end.forEach(l => draw(pres, pres.addSlide(), Layout.layoutLabelSlide(l).els, imgs));

    const blob = await pres.write({ outputType: 'blob' });
    return { blob, name: fileBase(project, 'Montageanleitung') + '.pptx',
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
  }

  /* Stückliste */
  function bom(project) {
    const map = new Map();
    project.steps.forEach((s, i) => (s.materials || []).forEach(m => {
      const key = (m.number || '').toUpperCase().trim(); if (!key) return;
      const e = map.get(key) || { number: m.number.trim(), description: '', quantity: 0, steps: [] };
      e.quantity += Number(m.quantity) || 0;
      if (!e.description && m.description) e.description = m.description;
      if (!e.steps.includes(i + 1)) e.steps.push(i + 1);
      map.set(key, e);
    }));
    return [...map.values()].sort((a, b) => a.number.localeCompare(b.number, 'de', { numeric: true }));
  }
  function bomCSV(project) {
    const rows = bom(project);
    const q = s => `"${String(s ?? '').replace(/"/g, '""')}"`;
    let csv = '﻿' + ['Pos.', 'Artikelnummer', 'Bezeichnung', 'Menge', 'Verwendet in Schritt'].join(';') + '\n';
    rows.forEach((m, i) => { csv += [i + 1, q(m.number), q(m.description), m.quantity, q(m.steps.join(', '))].join(';') + '\n'; });
    csv += `\n${q('Positionen')};${rows.length}\n${q('Teile gesamt')};${rows.reduce((a, m) => a + m.quantity, 0)}\n`;
    csv += `${q('Kunde')};${q(project.customer)}\n${q('Produkt')};${q(project.product)}\n${q('Variante')};${q(project.variant)}\n${q('Erstellt')};${q(new Date().toLocaleString('de-DE'))}\n`;
    return { blob: new Blob([csv], { type: 'text/csv;charset=utf-8' }), name: fileBase(project, 'Stueckliste') + '.csv', type: 'text/csv' };
  }
  function bomPrintHTML(project) {
    const rows = bom(project);
    const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Stückliste</title>
<style>body{font:14px system-ui,sans-serif;margin:24px;color:#1b1b1f}h1{font-size:22px;margin:0 0 4px}p{color:#555;margin:0 0 16px}
table{border-collapse:collapse;width:100%}th,td{padding:7px 8px;border-bottom:1px solid #ddd;text-align:left}th{background:#1b1b1f;color:#fff}td.n{text-align:right}
.bar{margin:16px 0;display:flex;gap:8px}.bar button{font:inherit;padding:10px 16px;border-radius:8px;border:0;background:#952456;color:#fff}
@media print{.bar{display:none}}</style></head><body>
<h1>Stückliste</h1><p>${esc([project.customer, project.product, project.variant].filter(Boolean).join(' · '))} — ${rows.length} Positionen, ${rows.reduce((a, m) => a + m.quantity, 0)} Teile</p>
<div class="bar"><button onclick="print()">Drucken / als PDF sichern</button></div>
<table><thead><tr><th>Pos.</th><th>Artikelnummer</th><th>Bezeichnung</th><th>Menge</th><th>Schritt</th></tr></thead><tbody>
${rows.map((m, i) => `<tr><td>${i + 1}</td><td><b>${esc(m.number)}</b></td><td>${esc(m.description)}</td><td class="n">${m.quantity}</td><td>${m.steps.join(', ')}</td></tr>`).join('')}
</tbody></table></body></html>`;
  }

  /* JSON im bisherigen Format für den PC-Konverter (V3-kompatibel) */
  async function converterJSON(project, getPhoto) {
    const steps = [];
    const labels = Layout.labelsFor(project);
    const labelImg = async l => l.img ? [{ data: await asset(l.img), resolution: '900x1125', timestamp: new Date().toISOString(), source: 'label-image' }] : [{ data: '', resolution: '400x300', source: 'label-image' }];
    for (const l of labels.start) steps.push({ stepNumber: 0, stepType: 'LABEL_VORMONTAGE', instructions: l.title, materials: [], tools: [], cables: [], photos: await labelImg(l), isScanStep: true, isAutoGenerated: true });
    for (const [i, s] of project.steps.entries()) {
      const photos = [];
      for (const id of s.photoIds || []) { const ph = await getPhoto(id); if (ph) photos.push({ data: await blobToDataURL(ph.blob), resolution: `${ph.w}x${ph.h}`, timestamp: ph.createdAt || '' }); }
      const tools = (s.tools || []).filter(t => t.tool || t.torque);
      steps.push({ stepNumber: i + 1, stepType: 'WORK_STEP', title: Layout.stepTitle(s, i + 1), instructions: s.instructions || '',
        materials: (s.materials || []).map(m => ({ number: m.number, quantity: m.quantity, description: m.description || '' })),
        tools, tool: tools[0]?.tool || '', torque: tools[0]?.torque || '', warning: s.warning || '',
        cables: (s.cables || []).filter(c => c.designation || c.from || c.to), photos, isScanStep: !!s.isScanStep, isAutoGenerated: false });
    }
    for (const [i, l] of labels.end.entries()) steps.push({ stepNumber: project.steps.length + i + 1, stepType: 'LABEL_ENDMONTAGE', instructions: l.title, materials: [], tools: [], cables: [], warning: l.warning, photos: await labelImg(l), isScanStep: true, isAutoGenerated: true });
    const data = {
      metadata: { version: '4.0', format: 'funkwerk-montageanleitung-full', title: 'Funkwerk Montageanleitung', exported: new Date().toISOString() },
      projectInfo: { customer: project.customer || '', product: project.product || '', variant: project.variant || '',
        productionArea: project.area, funkwerkType: project.area === 'funkwerk' ? project.type : '', createdAt: project.createdAtText || '' },
      workSteps: steps,
      statistics: { totalSteps: steps.length, manualSteps: project.steps.length, labelSteps: steps.length - project.steps.length,
        totalPhotos: steps.reduce((a, s) => a + s.photos.length, 0), totalMaterials: steps.reduce((a, s) => a + s.materials.length, 0) }
    };
    return { blob: new Blob([JSON.stringify(data)], { type: 'application/json' }), name: fileBase(project, 'Montageanleitung') + '.json', type: 'application/json' };
  }

  /* Vollständige Sicherung eines Projekts (inkl. Originalfotos und Markierungen) */
  async function backup(project, getPhoto) {
    const photos = {};
    for (const s of project.steps) for (const id of s.photoIds || []) {
      const ph = await getPhoto(id); if (!ph) continue;
      photos[id] = { w: ph.w, h: ph.h, createdAt: ph.createdAt, data: await blobToDataURL(ph.blob),
        orig: ph.orig ? await blobToDataURL(ph.orig) : null, marks: ph.marks || null };
    }
    const data = { format: 'funkwerk-recorder-backup', version: 4, exported: new Date().toISOString(), project, photos };
    return { blob: new Blob([JSON.stringify(data)], { type: 'application/json' }), name: fileBase(project, 'Sicherung') + '.json', type: 'application/json' };
  }

  /* Teilen (iPhone/Android) oder herunterladen */
  async function deliver(file) {
    const f = new File([file.blob], file.name, { type: file.type });
    if (navigator.canShare && navigator.canShare({ files: [f] })) {
      try { await navigator.share({ files: [f], title: file.name }); return 'shared'; }
      catch (e) { if (e.name === 'AbortError') return 'aborted'; }
    }
    const url = URL.createObjectURL(file.blob);
    const a = document.createElement('a'); a.href = url; a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return 'downloaded';
  }

  return { buildPptx, bomCSV, bomPrintHTML, bom, converterJSON, backup, deliver, blobToDataURL };
})();

window.Export = Export;
