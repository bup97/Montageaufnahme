/* Funkwerk Montage-Recorder V4 – Oberfläche und Abläufe */
'use strict';

const VERSION = '5.2.0';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const isTouch = matchMedia('(pointer: coarse)').matches;

const S = {
  projects: [], P: null, route: { view: 'home' },
  thumbs: new Map(), meta: new Map(),       // Foto-ID → Objekt-URL / {id,w,h,marked}
  saveTimer: null, previewTimer: null, dict: null, legacy: null, pending: new Set()
};

/* ================= Hilfen ================= */
function emptyStep() { return { id: uid(), title: '', materials: [], instructions: '', tools: [], cables: [], warning: '', isScanStep: false, photoIds: [] }; }
function stepIsEmpty(s) {
  return !s.title && !s.instructions.trim() && !s.warning.trim() && !s.materials.length && !s.photoIds.length && !s.isScanStep &&
    !s.tools.some(t => t.tool || t.torque) && !s.cables.some(c => c.designation || c.from || c.to);
}
function pTitle(p) { return p.product || p.customer || p.variant || 'Ohne Titel'; }
function pSub(p) { return [p.product ? p.customer : '', p.variant && (p.product || p.customer) ? p.variant : ''].filter(Boolean).join(' · '); }
function relTime(ts) {
  const d = new Date(ts), now = new Date();
  const hm = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const day = 864e5, sd = new Date(d).setHours(0, 0, 0, 0), sn = new Date(now).setHours(0, 0, 0, 0);
  if (sd === sn) return 'heute ' + hm;
  if (sn - sd === day) return 'gestern ' + hm;
  return d.toLocaleDateString('de-DE');
}
function stepIndex(id) { return S.P.steps.findIndex(s => s.id === id); }
function curStep() { return S.P && S.route.stepId ? S.P.steps.find(s => s.id === S.route.stepId) : null; }
function metasOf(step) { return step.photoIds.map(id => S.meta.get(id)).filter(Boolean); }
function warningsOf(step, n) { return Layout.layoutStepSlide(step, n, metasOf(step)).warnings; }

function toast(msg, action, ms = 3500) {
  $$('.toast').forEach(t => t.remove());
  const t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status');
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(action.label)}</button>` : ''}`;
  document.body.appendChild(t);
  let done = false;
  const close = () => { if (!done) { done = true; t.remove(); action && action.onTimeout && action.onTimeout(); } };
  if (action) t.querySelector('button').onclick = () => { done = true; t.remove(); action.run(); };
  setTimeout(close, action ? 6000 : ms);
}
function busy(text) {
  const b = document.createElement('div'); b.className = 'busy';
  b.innerHTML = `<div><span class="spin"></span><span>${esc(text)}</span></div>`;
  document.body.appendChild(b); return () => b.remove();
}
function sheet(html, { onClose } = {}) {
  const back = document.createElement('div'); back.className = 'sheet-back';
  back.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div>`;
  const close = () => { back.remove(); onClose && onClose(); };
  back.addEventListener('click', e => { if (e.target === back || e.target.closest('[data-close]')) close(); });
  document.body.appendChild(back);
  return { el: back.querySelector('.sheet'), close };
}
function menu(items) {
  return new Promise(res => {
    const sh = sheet(`<div class="menu">${items.map((it, i) => `<button data-i="${i}" class="${it.danger ? 'danger' : ''}"><span class="ic">${it.icon}</span>${esc(it.label)}</button>`).join('')}</div>
      <button class="btn block" data-close style="margin-top:10px">Abbrechen</button>`, { onClose: () => res(null) });
    sh.el.addEventListener('click', e => { const b = e.target.closest('[data-i]'); if (b) { sh.close(); items[+b.dataset.i].run(); } });
  });
}

/* ================= Speichern ================= */
function touch() { if (!S.P) return; S.P.updatedAt = Date.now(); clearTimeout(S.saveTimer); S.saveTimer = setTimeout(flush, 300); }
async function flush() {
  clearTimeout(S.saveTimer); S.saveTimer = null;
  if (!S.P) return;
  try { await DB.putProject(S.P); } catch (e) { console.error(e); toast('Speichern fehlgeschlagen – Speicher voll?'); }
}
addEventListener('pagehide', flush);
document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });

/* ================= Fotos ================= */
function loadImage(file) {
  return new Promise((res, rej) => { const u = URL.createObjectURL(file); const i = new Image(); i.onload = () => res({ img: i, url: u }); i.onerror = () => { URL.revokeObjectURL(u); rej(new Error('Bild konnte nicht gelesen werden')); }; i.src = u; });
}
function scaleTo(img, maxEdge, q) {
  let w = img.naturalWidth, h = img.naturalHeight; const k = Math.min(1, maxEdge / Math.max(w, h));
  w = Math.round(w * k); h = Math.round(h * k);
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d'); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(img, 0, 0, w, h);
  return new Promise(res => cv.toBlob(b => res({ blob: b, w, h }), 'image/jpeg', q));
}
async function makePhoto(file) {
  const { img, url } = await loadImage(file);
  const full = await scaleTo(img, 1920, 0.86);   // lange Kante max. 1920 px – auch bei Hochformat
  const th = await scaleTo(img, 560, 0.78);
  URL.revokeObjectURL(url);
  return { id: uid(), projectId: S.P.id, blob: full.blob, thumb: th.blob, w: full.w, h: full.h, createdAt: new Date().toISOString() };
}
async function thumbURL(id) {
  if (S.thumbs.has(id)) return S.thumbs.get(id);
  const ph = await DB.getPhoto(id); if (!ph) return '';
  const u = URL.createObjectURL(ph.thumb || ph.blob);
  S.thumbs.set(id, u); S.meta.set(id, { id, w: ph.w, h: ph.h, marked: !!(ph.marks && ph.marks.length) });
  return u;
}
async function loadProjectPhotos(p) {
  for (const s of p.steps) for (const id of s.photoIds) await thumbURL(id);
}
function dropThumbs() { S.thumbs.forEach(u => URL.revokeObjectURL(u)); S.thumbs.clear(); S.meta.clear(); }

async function addFiles(files, step) {
  files = [...files].filter(f => !f.type || f.type.startsWith('image/'));
  if (!files.length || !step) return;
  const stop = files.length > 1 ? busy(`${files.length} Fotos werden verarbeitet…`) : () => {};
  let ok = 0;
  try {
    for (const f of files) {
      try {
        const ph = await makePhoto(f);
        await DB.putPhoto(ph);
        S.thumbs.set(ph.id, URL.createObjectURL(ph.thumb)); S.meta.set(ph.id, { id: ph.id, w: ph.w, h: ph.h });
        step.photoIds.push(ph.id); ok++;
      } catch (e) { console.warn(e); }
    }
  } finally { stop(); }
  if (ok < files.length) toast(`${files.length - ok} Datei(en) konnten nicht gelesen werden.`);
  touch(); await flush();
  if (S.route.view === 'step') renderStep();
}

/* ================= Navigation ================= */
function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }
addEventListener('hashchange', route);

async function openProject(id) {
  if (S.P && S.P.id === id) return S.P;
  await flush(); dropThumbs();
  const p = await DB.getProject(id);
  if (!p) return null;
  S.P = p; await loadProjectPhotos(p);
  return p;
}

async function route() {
  const h = location.hash.replace(/^#\/?/, '').split('/');
  if (S.dict) S.dict.stop();
  try {
    if (h[0] === 'p' && h[1]) {
      const p = await openProject(h[1]);
      if (!p) return go('#/');
      // leeren Schritt beim Verlassen entfernen
      if (S.route.view === 'step' && S.route.stepId && (h[2] !== 's' || h[3] !== S.route.stepId)) {
        const old = p.steps.find(s => s.id === S.route.stepId);
        if (old && stepIsEmpty(old)) { p.steps.splice(p.steps.indexOf(old), 1); touch(); }
      }
      if (h[2] === 's' && h[3] && p.steps.some(s => s.id === h[3])) {
        S.route = { view: 'step', id: p.id, stepId: h[3], tab: h[4] || 'material' };
        if (S.route.tab === 'vorschau' && matchMedia('(min-width:1040px)').matches) S.route.tab = 'fotos';
        renderStep();
      } else if (h[2] === 'folien') { S.route = { view: 'slides', id: p.id }; renderSlides(); }
      else { S.route = { view: 'project', id: p.id }; renderProject(); }
    } else if (h[0] === 'cad') {
      await flush(); S.P = null; dropThumbs();
      S.route = { view: 'cad' }; await renderCad();
    } else {
      await flush(); S.P = null; dropThumbs();
      S.route = { view: 'home' }; await renderHome();
    }
    localStorage.setItem('fw4.route', location.hash);
  } catch (e) { console.error(e); toast('Fehler: ' + e.message); }
}

/* ================= Startseite ================= */
function homeTabs(active) {
  return `<div class="seg" role="tablist" style="margin-bottom:14px">
    <button role="tab" class="${active === 'home' ? 'on' : ''}" data-act="nav-home">📋 Meine Anleitungen</button>
    <button role="tab" class="${active === 'cad' ? 'on' : ''}" data-act="nav-cad">🧊 Aus CAD erstellen</button></div>`;
}

/* ================= Reiter „Aus CAD erstellen“ ================= */
let cadModule = null;
async function renderCad() {
  $('#app').innerHTML = `
  <header class="top"><div class="top-in"><div class="brandbar"><img src="img/logo.png" alt="funkwerk"><span>Montage-Recorder</span></div></div></header>
  <main class="wrap cad-wrap">
    ${homeTabs('cad')}
    <div id="cad-root"><div class="empty"><span class="spin" style="display:inline-block"></span><br>Wird geladen…</div></div>
  </main>`;
  try {
    if (!cadModule) cadModule = await import('./cad.js');
    if (S.route.view !== 'cad') return;
    cadModule.mount($('#cad-root'), { toast, busy, projectForm: async (v, title, cta) => { S.projects = await DB.allProjects(); return projectForm(v, title, cta); }, createFromCad });
  } catch (e) {
    console.error(e);
    $('#cad-root').innerHTML = `<div class="banner">Der CAD-Reiter konnte nicht geladen werden (${esc(e.message)}). Beim ersten Öffnen wird eine Internetverbindung benötigt.</div>`;
  }
}
/* Ergebnis aus dem CAD-Reiter als normale Anleitung anlegen */
async function createFromCad(info, cadSteps) {
  const now = Date.now();
  const p = { id: uid(), ...info, createdAt: now, updatedAt: now, createdAtText: new Date(now).toLocaleString('de-DE'), steps: [], v: 4, source: 'cad' };
  for (const c of cadSteps) {
    const s = emptyStep();
    s.title = c.title || '';
    s.instructions = c.instructions || '';
    s.warning = c.warning || '';
    s.materials = (c.materials || []).map(m => ({ number: m.number, description: m.description || '', quantity: m.quantity || 1 }));
    s.tools = c.tools || [];
    s.cables = c.cables || [];
    if (c.image) {
      const { img, url } = await loadImage(c.image.blob);
      const th = await scaleTo(img, 560, 0.78); URL.revokeObjectURL(url);
      const rec = { id: uid(), projectId: p.id, blob: c.image.blob, thumb: th.blob, w: c.image.w, h: c.image.h, createdAt: new Date().toISOString() };
      await DB.putPhoto(rec); s.photoIds.push(rec.id);
    }
    p.steps.push(s);
  }
  await DB.putProject(p);
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  toast('Anleitung angelegt: ' + p.steps.length + ' Schritte');
  go(`#/p/${p.id}`);
}
async function renderHome() {
  S.projects = (await DB.allProjects()).filter(p => !p.hidden && !S.pending.has(p.id)).sort((a, b) => b.updatedAt - a.updatedAt);
  const firstThumb = async p => { const s = p.steps.find(s => s.photoIds.length); if (!s) return ''; const ph = await DB.getPhoto(s.photoIds[0]); return ph ? URL.createObjectURL(ph.thumb || ph.blob) : ''; };
  const thumbs = await Promise.all(S.projects.map(firstThumb));
  S.homeThumbs && S.homeThumbs.forEach(u => u && URL.revokeObjectURL(u)); S.homeThumbs = thumbs;

  const leg = S.legacy;
  $('#app').innerHTML = `
  <header class="top"><div class="top-in"><div class="brandbar"><img src="img/logo.png" alt="funkwerk"><span>Montage-Recorder</span></div></div></header>
  <main class="wrap">
    ${homeTabs('home')}
    ${leg ? `<div class="banner info" style="margin-bottom:14px"><b>Aufnahme aus der alten Version gefunden</b><br>
      <span class="small">${esc([leg.state.projectInfo?.customer, leg.state.projectInfo?.product, leg.state.projectInfo?.variant].filter(Boolean).join(' · ') || 'Ohne Angaben')} – ${leg.count} Schritt(e). Sie bleibt in der alten Version erhalten.</span>
      <div class="row" style="margin-top:10px"><button class="btn primary sm" data-act="legacy-import">Übernehmen</button><button class="btn ghost sm" data-act="legacy-hide">Ausblenden</button></div></div>` : ''}
    <div class="home-actions"><button class="hero" data-act="new"><span class="plus">+</span><span><b>Neue Montageanleitung</b><span class="muted small">Schritte mit Material, Anweisung und Fotos erfassen</span></span></button>
    <button class="btn block" data-act="import-pptx" style="margin-top:10px;min-height:54px">📊 Bestehende PowerPoint importieren</button></div>
    <div class="sect">Meine Anleitungen</div>
    ${S.projects.length ? `<div class="plist">${S.projects.map((p, i) => {
      const photos = p.steps.reduce((a, s) => a + s.photoIds.length, 0);
      return `<div class="pcard" data-act="open" data-id="${p.id}" role="button" tabindex="0">
        <div class="thumb" style="${thumbs[i] ? `background-image:url('${thumbs[i]}')` : ''}">${thumbs[i] ? '' : '📋'}</div>
        <div class="grow" style="min-width:0"><div class="t">${esc(pTitle(p))}</div>
          <div class="m">${esc(pSub(p)) || '&nbsp;'}</div>
          <div class="chips"><span class="chip brand">${esc(Layout.areaLabel(p))}</span><span class="chip">${p.steps.length} Schritt${p.steps.length !== 1 ? 'e' : ''}</span><span class="chip">📷 ${photos}</span><span class="chip">${relTime(p.updatedAt)}</span></div></div>
        <button class="icon-btn" data-act="pmenu" data-id="${p.id}" aria-label="Mehr">⋯</button></div>`;
    }).join('')}</div>` : `<div class="empty">Noch keine Anleitungen.<br>Tippe oben auf „Neue Montageanleitung“.</div>`}
    <div class="sect">Handy ↔ PC übertragen</div>
    <div class="card stack home-more">
      <div class="sync-row">
        <button class="btn primary" data-act="sync-out" ${S.projects.length ? '' : 'disabled'}>⤴ Anleitungen übertragen</button>
        <button class="btn" data-act="import">⤵ Übertragung einlesen</button>
      </div>
      <div class="small muted">Am Handy <b>„Anleitungen übertragen“</b> → in OneDrive sichern (oder per Mail/AirDrop senden). Am PC <b>„Übertragung einlesen“</b> → dieselbe Datei wählen. Vorhandene Anleitungen werden aktualisiert, nicht verdoppelt.${lastSync() ? ` · Zuletzt übertragen: ${relTime(lastSync())}` : ''}</div>
      <div class="tiny" id="storage">Speicher wird ermittelt…</div>
      <div class="tiny">Version ${VERSION} · Daten bleiben auf diesem Gerät · <a href="../" style="color:inherit">alte Version öffnen</a> · Created by P. Busch</div>
    </div>
  </main>`;
  storageInfo();
}
async function storageInfo() {
  try {
    const e = await navigator.storage.estimate();
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    const el = $('#storage'); if (el) el.textContent = `Belegt: ${(e.usage / 1048576).toFixed(1)} MB von ${(e.quota / 1048576 / 1024).toFixed(1)} GB${persisted ? ' · dauerhaft gespeichert' : ''}`;
  } catch (e) { const el = $('#storage'); if (el) el.textContent = ''; }
}

function projectForm(p, title, cta, note) {
  const v = p || { area: 'funkwerk', type: 'endmontage', customer: '', product: '', variant: '' };
  const areas = [
    ['funkwerk', 'endmontage', '🔧', 'Funkwerk Endmontage', '3 Label-Folien (EOL, VP, FA) am Ende'],
    ['funkwerk', 'vormontage', '🔩', 'Funkwerk Vormontage', 'Baugruppenlabel-Folie am Anfang'],
    ['elexon', '', '⚡', 'Elexon', 'ohne Label-Folien']];
  const hist = k => [...new Set(S.projects.map(x => x[k]).filter(Boolean))].map(x => `<option value="${esc(x)}">`).join('');
  return new Promise(res => {
    const sh = sheet(`<h2>${title}</h2>${note ? `<div class="okbox" style="margin:-4px 0 14px">${note}</div>` : ''}
      <div class="opts">${areas.map(([a, t, ic, l, d]) => `<button class="opt ${v.area === a && (a === 'elexon' || v.type === t) ? 'on' : ''}" data-a="${a}" data-t="${t}"><span class="ic">${ic}</span><span><b>${l}</b><span class="small muted">${d}</span></span></button>`).join('')}</div>
      <div class="stack" style="margin-top:16px">
        <div><label class="f" for="f-c">Kunde</label><input id="f-c" list="h-c" value="${esc(v.customer)}" placeholder="z. B. Deutsche Bahn" autocomplete="off"><datalist id="h-c">${hist('customer')}</datalist></div>
        <div><label class="f" for="f-p">Produkt</label><input id="f-p" list="h-p" value="${esc(v.product)}" placeholder="z. B. DB ZIM4 Vitrine 43q" autocomplete="off"><datalist id="h-p">${hist('product')}</datalist></div>
        <div><label class="f" for="f-v">Variante</label><input id="f-v" list="h-v" value="${esc(v.variant)}" placeholder="z. B. ES geschl. Ad1" autocomplete="off"><datalist id="h-v">${hist('variant')}</datalist></div>
      </div>
      <p class="tiny" id="f-msg" style="min-height:18px;margin:8px 2px"></p>
      <div class="row"><button class="btn grow" data-close>Abbrechen</button><button class="btn primary grow" data-ok>${cta}</button></div>`, { onClose: () => res(null) });
    let area = v.area, type = v.type;
    sh.el.addEventListener('click', e => {
      const o = e.target.closest('.opt');
      if (o) { area = o.dataset.a; type = o.dataset.t; $$('.opt', sh.el).forEach(x => x.classList.toggle('on', x === o)); }
      if (e.target.closest('[data-ok]')) {
        const r = { area, type: area === 'funkwerk' ? type : '', customer: $('#f-c', sh.el).value.trim(), product: $('#f-p', sh.el).value.trim(), variant: $('#f-v', sh.el).value.trim() };
        if (!r.customer && !r.product && !r.variant) { $('#f-msg', sh.el).textContent = 'Bitte mindestens Kunde, Produkt oder Variante angeben.'; $('#f-msg', sh.el).style.color = 'var(--bad)'; return; }
        res(r); sh.el.closest('.sheet-back').remove();
      }
    });
    if (!isTouch) setTimeout(() => $('#f-p', sh.el).focus(), 50);
  });
}

async function newProject() {
  const r = await projectForm(null, 'Neue Montageanleitung', 'Anlegen & los');
  if (!r) return;
  const now = Date.now();
  const p = { id: uid(), ...r, createdAt: now, updatedAt: now, createdAtText: new Date(now).toLocaleString('de-DE'), steps: [emptyStep()], v: 4 };
  await DB.putProject(p);
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  go(`#/p/${p.id}/s/${p.steps[0].id}/material`);
}

async function projectMenu(id) {
  const p = S.projects.find(x => x.id === id) || (S.P && S.P.id === id ? S.P : await DB.getProject(id));
  menu([
    { icon: '✎', label: 'Angaben bearbeiten', run: () => editInfo(p) },
    { icon: '⧉', label: 'Duplizieren (z. B. für neue Variante)', run: () => duplicateProject(p) },
    { icon: '⤴', label: 'Übertragen / sichern', run: () => runExport(p, 'backup') },
    { icon: '🗑', label: 'Löschen', danger: true, run: () => deleteProject(p) }
  ]);
}
async function editInfo(p) {
  const r = await projectForm(p, 'Angaben bearbeiten', 'Speichern');
  if (!r) return;
  Object.assign(p, r, { updatedAt: Date.now() });
  await DB.putProject(p);
  if (S.P && S.P.id === p.id) Object.assign(S.P, r);
  route();
}
async function duplicateProject(p) {
  const stop = busy('Wird dupliziert…');
  try {
    const now = Date.now();
    const np = JSON.parse(JSON.stringify(p));
    Object.assign(np, { id: uid(), createdAt: now, updatedAt: now, createdAtText: new Date(now).toLocaleString('de-DE'), variant: p.variant ? p.variant + ' (Kopie)' : 'Kopie' });
    for (const s of np.steps) {
      s.id = uid();
      s.photoIds = await Promise.all(s.photoIds.map(async id => { const ph = await DB.getPhoto(id); if (!ph) return null; const n = { ...ph, id: uid(), projectId: np.id }; await DB.putPhoto(n); return n.id; })).then(a => a.filter(Boolean));
    }
    await DB.putProject(np);
    toast('Kopie angelegt');
    go(`#/p/${np.id}`);
  } finally { stop(); }
}
async function deleteProject(p) {
  if (S.P && S.P.id === p.id) { S.P = null; }
  S.pending.add(p.id);
  const backup = JSON.parse(JSON.stringify(p));
  const t = await DB.getProject(p.id);
  if (t) { await DB.putProject({ ...t, hidden: true }); }
  const finalize = async () => { if (S.pending.has(p.id)) { S.pending.delete(p.id); await DB.deleteProject(p.id); } };
  toast(`„${pTitle(p)}“ gelöscht`, { label: 'Rückgängig', run: async () => { S.pending.delete(p.id); await DB.putProject(backup); route(); }, onTimeout: finalize });
  if (S.route.view === 'home') renderHome(); else go('#/');
}

/* ================= Projekt-Übersicht ================= */
function renderProject() {
  const p = S.P;
  const labels = Layout.labelsFor(p);
  const labelCard = l => `<div class="scard label"><span class="num">🏷</span><div class="body" style="cursor:default"><div class="t">${esc(l.title)}</div><div class="tiny">automatische Label-Folie</div></div></div>`;
  const totalWarn = p.steps.reduce((a, s, i) => a + (warningsOf(s, i + 1).length ? 1 : 0), 0);
  $('#app').innerHTML = `
  <header class="top"><div class="top-in">
    <button class="icon-btn" data-act="home" aria-label="Zurück">‹</button>
    <div class="grow" style="min-width:0"><h1>${esc(pTitle(p))}</h1><div class="sub">${esc([pSub(p), Layout.areaLabel(p)].filter(Boolean).join(' · '))}</div></div>
    <button class="icon-btn" data-act="pmenu" data-id="${p.id}" aria-label="Mehr">⋯</button>
  </div></header>
  <main class="wrap">
    ${totalWarn ? `<div class="warnbox" style="margin-bottom:12px">⚠ ${totalWarn} Folie${totalWarn > 1 ? 'n' : ''} bitte prüfen – Schritt öffnen oder „Folien ansehen“.</div>` : ''}
    ${isDesk() ? projectGrid(p, labels) : `
    <div class="steps">
      ${labels.start.map(labelCard).join('')}
      ${p.steps.map((s, i) => {
        const w = warningsOf(s, i + 1).length;
        const tid = s.photoIds[0];
        return `<div class="scard">
          <span class="num">${i + 1}</span>
          <div class="thumb" style="${tid && S.thumbs.get(tid) ? `background-image:url('${S.thumbs.get(tid)}')` : ''}" data-act="step" data-id="${s.id}">${tid ? '' : '📷'}</div>
          <div class="body" data-act="step" data-id="${s.id}">
            <div class="t">${esc(Layout.stepTitle(s, i + 1))}</div>
            <div class="chips">
              <span class="chip">📷 ${s.photoIds.length}</span><span class="chip">📦 ${s.materials.length}</span>
              ${Layout.stepTools(s).length ? '<span class="chip">🔧</span>' : ''}${s.cables.some(c => c.designation || c.from || c.to) ? '<span class="chip">🔌</span>' : ''}
              ${s.isScanStep ? '<span class="chip scan">Scan</span>' : ''}${w ? '<span class="chip warn">⚠ Folie prüfen</span>' : ''}
            </div>
          </div>
          <div class="mv"><button data-act="up" data-id="${s.id}" ${i === 0 ? 'disabled' : ''} aria-label="Nach oben">▲</button><button data-act="down" data-id="${s.id}" ${i === p.steps.length - 1 ? 'disabled' : ''} aria-label="Nach unten">▼</button></div>
        </div>`;
      }).join('')}
      ${labels.end.map(labelCard).join('')}
    </div>
    ${p.steps.length ? '' : '<div class="empty">Noch keine Schritte.</div>'}
    <div class="row" style="margin-top:14px"><button class="btn block" data-act="add-step">+ Schritt hinzufügen</button></div>`}
  </main>
  <div class="bottom"><div class="bottom-in">
    <button class="btn" data-act="slides">Folien ansehen</button>
    <button class="btn primary" data-act="export">Exportieren</button>
  </div></div>`;
  requestAnimationFrame(() => fitSlides());
}

/* PC: jeder Schritt als große Folienvorschau */
const isDesk = () => matchMedia('(min-width:1040px)').matches;
function projectGrid(p, labels) {
  const lab = l => `<div class="pslide label">${slideHTML(Layout.layoutLabelSlide(l))}<div class="cap"><span class="chip">🏷 Label-Folie</span><span class="tiny">wird automatisch erzeugt</span></div></div>`;
  return `<div class="pgrid">
    ${labels.start.map(lab).join('')}
    ${p.steps.map((s, i) => {
      const lay = Layout.layoutStepSlide(s, i + 1, metasOf(s));
      return `<div class="pslide">
        <div data-act="step" data-id="${s.id}" class="pslide-click" title="Schritt bearbeiten">${slideHTML(lay)}</div>
        <div class="cap"><b class="n">${i + 1}</b><span class="t">${esc(Layout.stepTitle(s, i + 1))}</span>
          ${s.isScanStep ? '<span class="chip scan">Scan</span>' : ''}${lay.warnings.length ? `<span class="chip warn" title="${esc(lay.warnings.join(' '))}">⚠ prüfen</span>` : ''}
          <span class="grow"></span>
          <button class="icon-btn sm" data-act="up" data-id="${s.id}" ${i === 0 ? 'disabled' : ''} title="Nach vorne">◀</button>
          <button class="icon-btn sm" data-act="down" data-id="${s.id}" ${i === p.steps.length - 1 ? 'disabled' : ''} title="Nach hinten">▶</button>
          <button class="icon-btn sm" data-act="step" data-id="${s.id}" title="Bearbeiten">✎</button></div>
      </div>`;
    }).join('')}
    <button class="pslide add" data-act="add-step"><span>+</span>Schritt hinzufügen</button>
    ${labels.end.map(lab).join('')}
  </div>`;
}

function moveStep(id, d) {
  const i = stepIndex(id), j = i + d; const st = S.P.steps;
  if (i < 0 || j < 0 || j >= st.length) return;
  [st[i], st[j]] = [st[j], st[i]]; touch(); renderProject();
}
function addStep(afterId) {
  const s = emptyStep();
  const i = afterId ? stepIndex(afterId) + 1 : S.P.steps.length;
  S.P.steps.splice(i, 0, s); touch();
  go(`#/p/${S.P.id}/s/${s.id}/material`);
}

/* ================= Folien-Vorschau ================= */
function slideHTML(lay, { highlight } = {}) {
  const px = v => (v * 96).toFixed(1) + 'px', pt = v => (v * 96 / 72).toFixed(1) + 'px';
  const box = e => `left:${px(e.x)};top:${px(e.y)};width:${px(e.w)};height:${px(e.h)}`;
  const parts = lay.els.map(e => {
    if (e.type === 'text') {
      const st = [box(e), `font-size:${pt(e.fontSize)}`, `color:#${e.color || '000'}`, e.bold ? 'font-weight:700' : '', e.italic ? 'font-style:italic' : '',
        e.fill ? `background:#${e.fill}` : '', e.line ? `border:1.33px solid #${e.line}` : '', e.shape === 'roundRect' ? 'border-radius:8px' : '',
        `align-items:${e.valign === 'middle' ? 'center' : 'flex-start'}`, `justify-content:${e.align === 'center' ? 'center' : e.align === 'right' ? 'flex-end' : 'flex-start'}`,
        `text-align:${e.align || 'left'}`, e.valign !== 'middle' ? 'padding-top:5px' : ''].filter(Boolean).join(';');
      return `<div class="sl-t ${e.placeholder ? 'ph-text' : ''} ${highlight && e.kind === highlight ? 'sl-hl' : ''}" style="${st}">${esc(e.text)}</div>`;
    }
    if (e.type === 'rect') return `<div style="${box(e)};background:#${e.fill};${e.line ? `border:1.33px ${e.dash ? 'dashed' : 'solid'} #${e.line}` : ''}"></div>`;
    if (e.type === 'image') {
      const src = e.src === 'photo' ? S.thumbs.get(e.photoId) : e.src === 'label' ? `img/label-${e.label}.jpg` : `img/${e.src}.png`;
      return src ? `<img src="${src}" alt="" style="${box(e)};object-fit:fill">` : '';
    }
    if (e.type === 'table') {
      return `<table class="sl-tab" style="left:${px(e.x)};top:${px(e.y)};width:${px(e.w)};border:0">
        <colgroup>${e.colW.map(w => `<col style="width:${px(w)}">`).join('')}</colgroup>
        ${e.rows.map((r, ri) => `<tr style="height:${px(e.rowH[ri])}">${r.map(c => `<td style="font-size:${pt(c.o.fontSize)};${c.o.bold ? 'font-weight:700;' : ''}color:#${c.o.color};background:#${c.o.fill};text-align:${c.o.align || 'left'};border:${(e.border.pt * 1.33).toFixed(1)}px solid #${e.border.color}">${esc(c.text)}</td>`).join('')}</tr>`).join('')}
      </table>`;
    }
    return '';
  });
  return `<div class="slide"><div class="slide-in">${parts.join('')}</div></div>`;
}
function fitSlides(root = document) { $$('.slide', root).forEach(s => s.style.setProperty('--s', (s.clientWidth / 1280).toFixed(4))); }
let lastDesk = matchMedia('(min-width:1040px)').matches;
addEventListener('resize', () => {
  fitSlides();
  const d = matchMedia('(min-width:1040px)').matches;
  if (d !== lastDesk) { lastDesk = d; if (S.route.view === 'project') renderProject(); if (S.route.view === 'step') renderStep(); }
});

function renderSlides() {
  const p = S.P, labels = Layout.labelsFor(p);
  const items = [
    { name: 'Titelfolie', lay: Layout.layoutTitleSlide(p, p.steps.length) },
    ...labels.start.map(l => ({ name: 'Label', lay: Layout.layoutLabelSlide(l) })),
    ...p.steps.map((s, i) => ({ name: `Schritt ${i + 1}`, lay: Layout.layoutStepSlide(s, i + 1, metasOf(s)), id: s.id })),
    ...labels.end.map(l => ({ name: 'Label', lay: Layout.layoutLabelSlide(l) }))];
  $('#app').innerHTML = `
  <header class="top"><div class="top-in"><button class="icon-btn" data-act="back-project" aria-label="Zurück">‹</button>
    <div class="grow"><h1>Folien</h1><div class="sub">${items.length} Folien · so wird die PowerPoint aussehen</div></div></div></header>
  <main class="wrap wide"><div class="slides-strip">
    ${items.map(it => `<div ${it.id ? `data-act="step" data-id="${it.id}" style="cursor:pointer"` : ''}>${slideHTML(it.lay)}
      <div class="small" style="margin:6px 2px"><b>${esc(it.name)}</b>${it.lay.warnings.map(w => `<div class="warnbox" style="margin-top:6px">⚠ ${esc(w)}</div>`).join('')}</div></div>`).join('')}
  </div></main>
  <div class="bottom"><div class="bottom-in"><button class="btn primary" data-act="export">Exportieren</button></div></div>`;
  requestAnimationFrame(() => fitSlides());
}

/* ================= Schritt-Editor ================= */
const TABS = [['material', 'Material'], ['anweisung', 'Anweisung'], ['fotos', 'Fotos'], ['vorschau', 'Vorschau']];

function renderStep() {
  const p = S.P, s = curStep(); if (!s) return go(`#/p/${p.id}`);
  const i = stepIndex(s.id), n = i + 1, tab = S.route.tab;
  const counts = { material: s.materials.length, anweisung: (s.instructions.trim() ? 1 : 0), fotos: s.photoIds.length, vorschau: warningsOf(s, n).length };
  const wide = matchMedia('(min-width:1040px)').matches;
  const tabIdx = TABS.findIndex(t => t[0] === tab);
  let secondary = ['Fertig', 'done'], primary;
  if (tab === 'material') primary = ['Weiter: Anweisung →', 'tab:anweisung'];
  else if (tab === 'anweisung') primary = ['Weiter: Fotos →', 'tab:fotos'];
  else if (tab === 'fotos' && !wide) { secondary = ['Vorschau', 'tab:vorschau']; primary = ['+ Nächster Schritt', 'next']; }
  else primary = ['+ Nächster Schritt', 'next'];

  $('#app').innerHTML = `
  <header class="top"><div class="top-in">
    <button class="icon-btn" data-act="back-project" aria-label="Zur Übersicht">‹</button>
    <div class="grow" style="min-width:0"><h1>Schritt ${n} <span class="muted" style="font-weight:500">von ${p.steps.length}</span></h1><div class="sub">${esc(pTitle(p))}</div></div>
    <button class="icon-btn" data-act="smenu" aria-label="Mehr">⋯</button>
  </div></header>
  <main class="wrap wide">
    <div class="tabs"><div class="seg" role="tablist">${TABS.map(([k, l]) => `<button role="tab" class="${k === tab ? 'on' : ''} ${k === 'vorschau' ? 'tab-prev' : ''}" data-act="tab:${k}">${l}${k === 'vorschau' ? (counts[k] ? ' <span class="n" style="background:var(--warn)">!</span>' : '') : ` <span class="n ${counts[k] ? '' : 'z'}">${k === 'anweisung' ? (counts[k] ? '✓' : '–') : counts[k]}</span>`}</button>`).join('')}</div></div>
    <div class="editor">
      <div class="main" id="tab-body">${tabBody(tab, s, n)}</div>
      <div class="side"><div id="side-prev">${slideHTML(Layout.layoutStepSlide(s, n, metasOf(s)))}</div><div id="side-warn" style="margin-top:10px">${warnHTML(s, n)}</div></div>
    </div>
  </main>
  <div class="bottom"><div class="bottom-in">
    <button class="btn" data-act="${secondary[1]}">${secondary[0]}</button>
    <button class="btn primary" data-act="${primary[1]}">${primary[0]}</button>
  </div></div>`;
  requestAnimationFrame(() => fitSlides());
  if (tab === 'material' && !isTouch && !s.materials.length) $('#m-no') && $('#m-no').focus();
}

function warnHTML(s, n) {
  const w = warningsOf(s, n);
  return w.length ? w.map(x => `<div class="warnbox">⚠ ${esc(x)}</div>`).join('') : `<div class="okbox">✓ Passt auf die Folie</div>`;
}

function matHistory() { try { return JSON.parse(localStorage.getItem('fw4.mat') || '{}'); } catch (e) { return {}; } }
function rememberMat(m) { const h = matHistory(); h[m.number.toUpperCase()] = { number: m.number, description: m.description || h[m.number.toUpperCase()]?.description || '' }; const k = Object.keys(h); if (k.length > 800) delete h[k[0]]; localStorage.setItem('fw4.mat', JSON.stringify(h)); }

function tabBody(tab, s, n) {
  if (tab === 'material') {
    const h = matHistory();
    return `<div class="card stack">
      <button class="btn block" data-act="scan" style="min-height:56px">▦ Barcode / QR scannen</button>
      <div><label class="f" for="m-no">Artikelnummer</label><input id="m-no" list="mat-h" inputmode="text" autocomplete="off" autocapitalize="characters" placeholder="z. B. 3602-010-00011">
        <datalist id="mat-h">${Object.values(h).map(m => `<option value="${esc(m.number)}">${esc(m.description)}</option>`).join('')}</datalist></div>
      <div class="row" style="align-items:flex-end">
        <div class="grow"><label class="f" for="m-de">Bezeichnung <span class="tiny">(optional)</span></label><input id="m-de" autocomplete="off" placeholder="z. B. Schraube M6×20"></div>
        <div><label class="f">Menge</label><div class="qty"><button data-act="mq:-1" aria-label="weniger">−</button><input id="m-q" type="number" inputmode="numeric" min="1" value="1"><button data-act="mq:1" aria-label="mehr">+</button></div></div>
      </div>
      <button class="btn primary block" data-act="mat-add">Material hinzufügen</button>
    </div>
    <div class="sect">Material in diesem Schritt (${s.materials.length})</div>
    <div class="stack">${s.materials.length ? s.materials.map((m, i) => `
      <div class="mat"><div class="grow" style="min-width:0"><div class="no">${esc(m.number)}</div>
        <input data-f="materials.${i}.description" value="${esc(m.description)}" placeholder="Bezeichnung" style="border:0;padding:2px 0;min-height:30px;font-size:14px;color:var(--ink2)"></div>
        <div class="qty sm"><button data-act="mi:${i}:-1">−</button><input data-f="materials.${i}.quantity" type="number" inputmode="numeric" min="1" value="${m.quantity}"><button data-act="mi:${i}:1">+</button></div>
        <button class="x" data-act="mat-del:${i}" aria-label="Entfernen">×</button></div>`).join('') : '<div class="empty" style="padding:18px">Kein Material – Schritt geht auch ohne.</div>'}
      ${s.materials.length > 5 ? '<div class="warnbox">Viele Positionen: die Tabelle schiebt die Anweisung auf der Folie nach unten.</div>' : ''}
    </div>`;
  }
  if (tab === 'anweisung') {
    const canDict = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    return `<div class="card stack">
      <div><label class="f" for="a-ti">Überschrift auf der Folie <span class="tiny">(optional)</span></label>
        <input id="a-ti" data-f="title" value="${esc(s.title)}" placeholder="${esc(Layout.stepTitle({ ...s, title: '' }, n))}" maxlength="70"></div>
      <div><div class="row" style="justify-content:space-between;margin-bottom:6px"><label class="f" for="a-in" style="margin:0">Montageanweisung</label>
        ${canDict ? `<button class="btn sm mic" data-act="dict" id="mic">🎙 Diktieren</button>` : ''}</div>
        <textarea id="a-in" data-f="instructions" rows="5" placeholder="Jede Zeile wird ein Aufzählungspunkt, z. B.&#10;Gehäuse auf Vorrichtung legen&#10;4 Schrauben über Kreuz anziehen">${esc(s.instructions)}</textarea></div>
      <label class="toggle"><input type="checkbox" data-f="isScanStep" ${s.isScanStep ? 'checked' : ''}><span class="grow"><b>Scanschritt</b><br><span class="small muted">Scan-Logo unten rechts auf der Folie</span></span></label>
    </div>
    <div class="sect">Werkzeug & Drehmoment</div>
    <div class="card rowlist">
      ${s.tools.map((t, i) => `<div class="r tools"><input data-f="tools.${i}.tool" value="${esc(t.tool)}" placeholder="Werkzeug, z. B. TX20"><input data-f="tools.${i}.torque" value="${esc(t.torque)}" placeholder="Drehmoment, z. B. 4 Nm"><button class="x" data-act="tool-del:${i}" aria-label="Entfernen">×</button></div>`).join('')}
      <button class="btn sm" data-act="tool-add" style="margin-top:${s.tools.length ? 10 : 0}px">+ Werkzeug</button>
      ${!s.tools.length && Layout.stepTools(s).length ? `<div class="tiny" style="margin-top:8px">Aus dem Text erkannt: ${esc(Layout.stepTools(s).map(t => [t.tool, t.torque].filter(Boolean).join(' ')).join(', '))}</div>` : ''}
    </div>
    <div class="sect">Verkabelung</div>
    <div class="card rowlist">
      ${s.cables.map((c, i) => `<div class="r cables"><input data-f="cables.${i}.designation" value="${esc(c.designation)}" placeholder="Kabel"><input data-f="cables.${i}.from" value="${esc(c.from)}" placeholder="Von (X1-3)"><input data-f="cables.${i}.to" value="${esc(c.to)}" placeholder="Nach (X2-5)"><button class="x" data-act="cable-del:${i}" aria-label="Entfernen">×</button></div>`).join('')}
      <button class="btn sm" data-act="cable-add" style="margin-top:${s.cables.length ? 10 : 0}px">+ Kabel</button>
    </div>
    <div class="sect">Wichtiger Hinweis</div>
    <div class="card"><textarea data-f="warning" rows="2" placeholder="z. B. Quetschgefahr, Reihenfolge beachten">${esc(s.warning)}</textarea></div>`;
  }
  if (tab === 'fotos') {
    const cam = 'mediaDevices' in navigator && !isTouch;
    return `<div class="shoot">
      ${isTouch ? `<button class="btn primary" data-act="pick:camera"><span>📷</span>Foto aufnehmen</button>` : cam ? `<button class="btn primary" data-act="webcam"><span>📷</span>Webcam</button>` : ''}
      <button class="btn" data-act="pick:gallery" ${!isTouch && !cam ? 'style="grid-column:1/-1"' : ''}><span>🖼</span>${isTouch ? 'Aus Galerie' : 'Dateien wählen'}</button>
    </div>
    ${!isTouch ? '<p class="tiny" style="margin:8px 2px">Tipp: Fotos hierher ziehen oder mit Strg+V einfügen.</p>' : ''}
    <div class="sect">Fotos (${s.photoIds.length}) <span style="text-transform:none;letter-spacing:0;font-weight:500">– max. 4 auf der Folie</span></div>
    ${s.photoIds.length ? `<div class="photos">${s.photoIds.map((id, i) => `
      <div class="ph"><img src="${S.thumbs.get(id) || ''}" alt="Foto ${i + 1}">
        <span class="badge ${i >= 4 ? 'off' : ''}">${i >= 4 ? 'nicht auf Folie' : i + 1}</span>
        ${S.meta.get(id)?.marked ? '<span class="marked">markiert</span>' : ''}
        <div class="acts"><button data-act="ph-mark:${i}" aria-label="Markieren">✎</button><button data-act="ph-mv:${i}:-1" ${i === 0 ? 'disabled' : ''} aria-label="Nach vorne">◀</button><button data-act="ph-mv:${i}:1" ${i === s.photoIds.length - 1 ? 'disabled' : ''} aria-label="Nach hinten">▶</button><button data-act="ph-del:${i}" aria-label="Löschen">🗑</button></div>
      </div>`).join('')}</div>` : '<div class="empty card">Noch keine Fotos.<br><span class="small">Mit ✎ kannst du später Pfeile, Kreise und Nummern einzeichnen.</span></div>'}`;
  }
  if (tab === 'vorschau') {
    return `<div id="tab-prev">${slideHTML(Layout.layoutStepSlide(s, n, metasOf(s)))}</div><div id="tab-warn" style="margin-top:12px">${warnHTML(s, n)}</div>
      <p class="tiny" style="margin-top:12px">So erscheint der Schritt in der PowerPoint. Tippe auf einen Reiter oben, um etwas zu ändern.</p>`;
  }
  return '';
}

function refreshPreview() {
  clearTimeout(S.previewTimer);
  S.previewTimer = setTimeout(() => {
    const s = curStep(); if (!s) return; const n = stepIndex(s.id) + 1;
    const lay = Layout.layoutStepSlide(s, n, metasOf(s));
    ['side', 'tab'].forEach(k => {
      const pv = $(`#${k}-prev`); if (pv) { pv.innerHTML = slideHTML(lay); fitSlides(pv); }
      const w = $(`#${k}-warn`); if (w) w.innerHTML = warnHTML(s, n);
    });
    const tb = $('[data-act="tab:anweisung"] .n'); if (tb) { tb.textContent = s.instructions.trim() ? '✓' : '–'; tb.classList.toggle('z', !s.instructions.trim()); }
  }, 180);
}

function setPath(obj, path, val) {
  const k = path.split('.'); let o = obj;
  for (let i = 0; i < k.length - 1; i++) o = o[k[i]];
  const last = k[k.length - 1];
  if (last === 'quantity') val = Math.max(1, parseInt(val, 10) || 1);
  o[last] = val;
}

async function addMaterial() {
  const s = curStep(); const no = $('#m-no').value.trim();
  if (!no) { $('#m-no').focus(); toast('Bitte Artikelnummer eingeben oder scannen.'); return; }
  const q = Math.max(1, parseInt($('#m-q').value, 10) || 1);
  const de = $('#m-de').value.trim();
  const ex = s.materials.find(m => m.number.toUpperCase() === no.toUpperCase());
  if (ex) { ex.quantity += q; if (!ex.description && de) ex.description = de; toast(`Menge von ${ex.number} erhöht auf ${ex.quantity}`); }
  else s.materials.push({ number: no, description: de, quantity: q });
  rememberMat({ number: no, description: de });
  touch(); renderStep();
  if (!isTouch) $('#m-no') && $('#m-no').focus();
}

async function stepMenu() {
  const s = curStep(), p = S.P;
  menu([
    { icon: '⧉', label: 'Schritt duplizieren', run: async () => {
      const c = JSON.parse(JSON.stringify(s)); c.id = uid();
      c.photoIds = await Promise.all(s.photoIds.map(async id => { const ph = await DB.getPhoto(id); const nph = { ...ph, id: uid() }; await DB.putPhoto(nph); S.thumbs.set(nph.id, URL.createObjectURL(nph.thumb || nph.blob)); S.meta.set(nph.id, S.meta.get(id)); return nph.id; }));
      p.steps.splice(stepIndex(s.id) + 1, 0, c); touch(); toast('Schritt dupliziert'); go(`#/p/${p.id}/s/${c.id}/${S.route.tab}`);
    } },
    { icon: '＋', label: 'Neuen Schritt danach einfügen', run: () => addStep(s.id) },
    { icon: '🗑', label: 'Schritt löschen', danger: true, run: () => deleteStep(s) }
  ]);
}
function deleteStep(s) {
  const p = S.P, i = stepIndex(s.id);
  p.steps.splice(i, 1); touch();
  const ids = [...s.photoIds];
  toast(`Schritt ${i + 1} gelöscht`, {
    label: 'Rückgängig', run: () => { if (S.P && S.P.id === p.id) { p.steps.splice(i, 0, s); touch(); route(); } },
    onTimeout: () => { if (!(S.P && S.P.steps.includes(s))) DB.deletePhotos(ids); }
  });
  S.route.stepId = null; go(`#/p/${p.id}`);
}

/* ================= Export ================= */
async function runExport(p, kind) {
  const project = p.id === S.P?.id ? S.P : p;
  if (S.P && project === S.P) await flush();
  const getPhoto = id => DB.getPhoto(id);
  const stop = busy({ pptx: 'PowerPoint wird erstellt…', json: 'Datei wird erstellt…', backup: 'Sicherung wird erstellt…', csv: 'Stückliste…' }[kind] || 'Bitte warten…');
  let file;
  try {
    if (kind === 'pptx') file = await Export.buildPptx(project, getPhoto);
    if (kind === 'csv') { if (!Export.bom(project).length) { stop(); return toast('Keine Materialien erfasst.'); } file = Export.bomCSV(project); }
    if (kind === 'json') file = await Export.converterJSON(project, getPhoto);
    if (kind === 'backup') { file = await Sync.build([project], { getPhoto, appVersion: VERSION }); markSynced(); }
  } catch (e) { console.error(e); stop(); return toast('Export fehlgeschlagen: ' + e.message); }
  stop();
  deliverSheet(file, kind === 'backup' ? syncHint() : '');
}
function deliverSheet(file, hint) {
  const mb = (file.blob.size / 1048576).toFixed(1);
  const canShare = !!(navigator.canShare && navigator.canShare({ files: [new File([file.blob], file.name, { type: file.type })] }));
  const sh = sheet(`<h2>Fertig ✓</h2><p class="muted" style="word-break:break-all;margin-top:-6px">${esc(file.name)} · ${mb} MB</p>
    ${hint ? `<div class="banner info small" style="margin-bottom:12px">${hint}</div>` : ''}
    <button class="btn primary block" data-go style="min-height:56px">${canShare ? 'Teilen / In Dateien sichern' : 'Herunterladen'}</button>
    <button class="btn block" data-close style="margin-top:10px">Schließen</button>`);
  $('[data-go]', sh.el).onclick = async () => { const r = await Export.deliver(file); if (r !== 'aborted') sh.close(); };
}

/* ================= Übertragen Handy ↔ PC ================= */
const lastSync = () => { try { return +localStorage.getItem('fw.lastSync') || 0; } catch (e) { return 0; } };
const markSynced = () => { try { localStorage.setItem('fw.lastSync', String(Date.now())); } catch (e) {} };
const syncHint = () => isTouch
  ? '<b>Weiter am PC:</b> Hier „Teilen“ → <b>OneDrive</b> (oder Mail an dich). Am PC in der App „Übertragung einlesen“ → Datei aus OneDrive/Downloads wählen.'
  : '<b>Weiter am Handy:</b> Datei in OneDrive speichern. Am Handy in der App „Übertragung einlesen“ → Datei aus der Dateien-App wählen.';

async function syncOut() {
  const all = (await DB.allProjects()).filter(p => !p.hidden).sort((a, b) => b.updatedAt - a.updatedAt);
  if (!all.length) return toast('Noch keine Anleitungen vorhanden.');
  const since = lastSync();
  const photosOf = p => p.steps.reduce((a, s) => a + s.photoIds.length, 0);
  const sh = sheet(`<h2>Anleitungen übertragen</h2>
    <div class="row small" style="margin:-6px 0 10px;gap:14px"><button class="btn ghost sm" data-sel="all">Alle</button>${since ? '<button class="btn ghost sm" data-sel="changed">Nur seit letzter Übertragung geändert</button>' : ''}<button class="btn ghost sm" data-sel="none">Keine</button></div>
    <div class="opts sync-list">${all.map(p => `<label class="opt"><input type="checkbox" value="${p.id}" checked style="width:22px;height:22px;min-height:0;flex:none">
      <span class="grow" style="min-width:0"><b style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(pTitle(p))}</b><span class="small muted">${esc(pSub(p)) ? esc(pSub(p)) + ' · ' : ''}${p.steps.length} Schritte · 📷 ${photosOf(p)} · ${relTime(p.updatedAt)}${since && p.updatedAt > since ? ' · <b style="color:var(--brand)">geändert</b>' : ''}</span></span></label>`).join('')}</div>
    <p class="tiny" id="sync-sum" style="margin:10px 2px"></p>
    <div class="row"><button class="btn grow" data-close>Abbrechen</button><button class="btn primary grow" data-go>Datei erstellen</button></div>`);
  const boxes = () => $$('input[type=checkbox]', sh.el);
  const sum = () => { const sel = boxes().filter(b => b.checked).map(b => all.find(p => p.id === b.value));
    $('#sync-sum', sh.el).textContent = `${sel.length} Anleitung${sel.length !== 1 ? 'en' : ''} · ${sel.reduce((a, p) => a + photosOf(p), 0)} Fotos`;
    $('[data-go]', sh.el).disabled = !sel.length; };
  sum();
  sh.el.addEventListener('change', sum);
  sh.el.addEventListener('click', async e => {
    const s = e.target.closest('[data-sel]');
    if (s) { boxes().forEach(b => { const p = all.find(x => x.id === b.value); b.checked = s.dataset.sel === 'all' || (s.dataset.sel === 'changed' && p.updatedAt > since); }); sum(); }
    if (e.target.closest('[data-go]')) {
      const sel = boxes().filter(b => b.checked).map(b => all.find(p => p.id === b.value));
      sh.close();
      const b = busy('Datei wird erstellt…');
      try {
        const file = await Sync.build(sel, { getPhoto: id => DB.getPhoto(id), appVersion: VERSION,
          onProgress: (i, n) => { const t = $('.busy span:last-child'); if (t) t.textContent = `Datei wird erstellt… ${Math.round(i / n * 100)} %`; } });
        markSynced(); b(); deliverSheet(file, syncHint());
      } catch (err) { b(); console.error(err); toast('Fehler: ' + err.message); }
    }
  });
}

async function syncIn(bundle) {
  const items = await Sync.plan(bundle);
  const label = { new: ['neu', 'brand'], newer: ['neuere Fassung', 'brand'], same: ['schon aktuell', ''], older: ['hier neuer', 'warn'] };
  const sh = sheet(`<h2>Übertragung einlesen</h2>
    <p class="small muted" style="margin:-6px 0 12px">Datei vom ${bundle.exported ? new Date(bundle.exported).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '–'} · ${items.length} Anleitung${items.length !== 1 ? 'en' : ''}</p>
    <div class="opts">${items.map((it, i) => { const p = it.project, [l, c] = label[it.status];
      return `<label class="opt"><input type="checkbox" data-i="${i}" ${it.status === 'new' || it.status === 'newer' ? 'checked' : ''} ${it.status === 'same' ? 'disabled' : ''} style="width:22px;height:22px;min-height:0;flex:none">
        <span class="grow" style="min-width:0"><b style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(pTitle(p))}</b>
        <span class="small muted">${p.steps.length} Schritte · Stand ${relTime(p.updatedAt)}${it.status === 'older' ? ` – hier bearbeitet ${relTime(it.local.updatedAt)}, würde überschrieben` : ''}</span></span>
        <span class="chip ${c}">${l}</span></label>`; }).join('')}</div>
    <div class="row" style="margin-top:14px"><button class="btn grow" data-close>Abbrechen</button><button class="btn primary grow" data-go>Übernehmen</button></div>`);
  const upd = () => { const n = $$('input[data-i]:checked', sh.el).length; const g = $('[data-go]', sh.el); g.disabled = !n; g.textContent = n ? `${n} übernehmen` : 'Nichts zu übernehmen'; };
  upd(); sh.el.addEventListener('change', upd);
  $('[data-go]', sh.el).onclick = async () => {
    const sel = $$('input[data-i]:checked', sh.el).map(b => items[+b.dataset.i]);
    sh.close();
    const b = busy('Wird übernommen…');
    try {
      const n = await Sync.apply(bundle, sel, { makeThumb: async blob => (await thumbFrom(blob)).blob,
        onProgress: (i, k) => { const t = $('.busy span:last-child'); if (t) t.textContent = `Wird übernommen… ${i}/${k}`; } });
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      const neu = sel.filter(x => x.status === 'new').length;
      toast(`✓ ${n} übernommen (${neu} neu, ${n - neu} aktualisiert)`);
      S.projects = []; if (S.route.view === 'home') renderHome(); else go('#/');
    } catch (err) { console.error(err); toast('Übernahme fehlgeschlagen: ' + err.message); }
    finally { b(); }
  };
}
function exportSheet() {
  const p = S.P;
  const bomN = Export.bom(p).length;
  const sh = sheet(`<h2>Exportieren</h2>
    <div class="opts">
      <button class="opt" data-k="pptx"><span class="ic">📊</span><span><b>PowerPoint (.pptx)</b><span class="small muted">${p.steps.length + 1 + Layout.labelsFor(p).start.length + Layout.labelsFor(p).end.length} Folien – direkt am Handy oder PC</span></span></button>
      <button class="opt" data-k="csv" ${bomN ? '' : 'disabled'}><span class="ic">📋</span><span><b>Stückliste (Excel/CSV)</b><span class="small muted">${bomN} Positionen, gleiche Artikel zusammengefasst</span></span></button>
      <button class="opt" data-k="print" ${bomN ? '' : 'disabled'}><span class="ic">🖨</span><span><b>Stückliste drucken / PDF</b><span class="small muted">Druckansicht im Browser</span></span></button>
      <button class="opt" data-k="json"><span class="ic">💾</span><span><b>JSON für PC-Konverter</b><span class="small muted">Format wie bisher</span></span></button>
      <button class="opt" data-k="backup"><span class="ic">⤴</span><span><b>Übertragen / Sicherung</b><span class="small muted">Inkl. Fotos – am PC oder Handy mit „Übertragung einlesen“ öffnen</span></span></button>
    </div>
    <button class="btn block" data-close style="margin-top:12px">Abbrechen</button>`);
  sh.el.addEventListener('click', e => {
    const o = e.target.closest('[data-k]'); if (!o) return; sh.close();
    if (o.dataset.k === 'print') {
      const u = URL.createObjectURL(new Blob([Export.bomPrintHTML(p)], { type: 'text/html' }));
      window.open(u, '_blank'); setTimeout(() => URL.revokeObjectURL(u), 60000);
    } else runExport(p, o.dataset.k);
  });
}

/* ================= Import ================= */
function dataURLtoBlob(d) { return fetch(d).then(r => r.blob()); }
async function thumbFrom(blob) { const { img, url } = await loadImage(blob); const t = await scaleTo(img, 560, 0.78); URL.revokeObjectURL(url); return t; }

/* Bestehende Anleitung aus PowerPoint (Funkwerk-Layout) übernehmen */
async function importPptx(file) {
  if (!/\.pptx$/i.test(file.name) && !/presentationml/.test(file.type)) return toast('Bitte eine PowerPoint-Datei (.pptx) wählen. Alte .ppt-Dateien vorher in PowerPoint als .pptx speichern.');
  let res; const stop = busy('PowerPoint wird gelesen…');
  try { res = await PptxImport.parse(file); }
  catch (e) { console.error(e); stop(); return toast('Import fehlgeschlagen: ' + e.message); }
  stop();
  try {
    if (!res.stats.steps) return toast('Keine Arbeitsschritte im Funkwerk-Layout gefunden.');
    const i = res.info;
    const pre = { area: i.productionArea, type: i.funkwerkType || 'endmontage', customer: i.customer, product: i.product, variant: i.variant };
    const st = res.stats;
    const note = `✓ Erkannt: ${st.steps} Schritt${st.steps !== 1 ? 'e' : ''}, ${st.photos} Foto${st.photos !== 1 ? 's' : ''}` +
      (st.labels ? `, ${st.labels} Label-Folie${st.labels !== 1 ? 'n' : ''} (erzeugt die App selbst)` : '') + (st.skipped ? ` · ${st.skipped} Folie(n) ohne passendes Layout übersprungen` : '');
    await renderHomeData();
    const r = await projectForm(pre, 'PowerPoint importieren', 'Importieren', note);
    if (!r) return;
    const stop2 = busy('Schritte und Fotos werden übernommen…');
    try {
      const p = await fromLegacy({ customer: r.customer, product: r.product, variant: r.variant, productionArea: r.area, funkwerkType: r.type }, res.steps, async ph => ph.data);
      await DB.putProject(p);
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      toast('Importiert: ' + pTitle(p));
      go(`#/p/${p.id}`);
    } finally { stop2(); }
  } catch (e) { console.error(e); toast('Import fehlgeschlagen: ' + e.message); }
  finally { res.release(); }
}
async function renderHomeData() { if (!S.projects.length) S.projects = (await DB.allProjects()).filter(p => !p.hidden); }

async function importFile(file) {
  if (/\.pptx$/i.test(file.name)) return importPptx(file);
  const stop = busy('Datei wird gelesen…');
  try {
    const bundle = await Sync.read(file);
    if (bundle) { stop(); return syncIn(bundle); }
    const data = JSON.parse(await file.text());
    let p;
    if (Array.isArray(data.workSteps)) {
      p = await fromLegacy(data.projectInfo || {}, data.workSteps.filter(s => !s.stepType || s.stepType === 'WORK_STEP'), async ph => ph.data);
    } else throw new Error('Unbekanntes Dateiformat');
    await DB.putProject(p);
    toast('Importiert: ' + pTitle(p));
    go(`#/p/${p.id}`);
  } catch (e) { console.error(e); toast('Import fehlgeschlagen: ' + e.message); }
  finally { stop(); }
}

/* V3-Schritte → V4-Projekt (aus alter IndexedDB oder aus altem JSON-Export) */
async function fromLegacy(info, steps, photoData) {
  const now = Date.now();
  const area = String(info.productionArea || 'funkwerk').toLowerCase() === 'elexon' ? 'elexon' : 'funkwerk';
  const p = { id: uid(), v: 4, area, type: area === 'funkwerk' ? (String(info.funkwerkType || 'endmontage').toLowerCase() === 'vormontage' ? 'vormontage' : 'endmontage') : '',
    customer: info.customer || '', product: info.product || '', variant: info.variant || '', createdAt: now, updatedAt: now,
    createdAtText: info.createdAt || new Date(now).toLocaleString('de-DE'), steps: [] };
  for (const o of steps) {
    const s = emptyStep();
    s.instructions = String(o.instructions || '').replace(/\n*📋 Verkabelungsplan:[\s\S]*$/, '').trim();
    s.title = o.title || '';
    s.warning = o.warning || o.importantNotes || '';
    s.isScanStep = !!o.isScanStep;
    s.materials = (o.materials || []).filter(m => m.number).map(m => ({ number: String(m.number), description: m.description && m.description !== m.number ? m.description : '', quantity: parseInt(m.quantity, 10) || 1 }));
    s.tools = (o.tools && o.tools.length ? o.tools : (o.tool || o.torque ? [{ tool: o.tool, torque: o.torque }] : [])).map(t => ({ tool: t.tool || '', torque: t.torque || '' })).filter(t => t.tool || t.torque);
    s.cables = (o.cables || []).map(c => ({ designation: c.designation || '', from: c.from || '', to: c.to || '' }));
    for (const ph of o.photos || []) {
      const d = await photoData(ph); if (!d) continue;
      try {
        const { img, url } = await loadImage(await dataURLtoBlob(d));
        const full = await scaleTo(img, 1920, 0.88), th = await scaleTo(img, 560, 0.78); URL.revokeObjectURL(url);
        const rec = { id: uid(), projectId: p.id, blob: full.blob, thumb: th.blob, w: full.w, h: full.h, createdAt: new Date().toISOString() };
        await DB.putPhoto(rec); s.photoIds.push(rec.id);
      } catch (e) { console.warn('Foto übersprungen', e); }
    }
    if (!stepIsEmpty(s)) p.steps.push(s);
  }
  if (!p.steps.length) p.steps.push(emptyStep());
  return p;
}

async function checkLegacy() {
  if (localStorage.getItem('fw4.legacyDone')) return;
  const L = await DB.readLegacy(); if (!L) return;
  const st = L.state;
  const extra = (st.currentMaterials || []).length || (st.currentPhotos || []).length;
  const count = (st.workSteps || []).length + (extra ? 1 : 0);
  if (!count) return;
  S.legacy = { ...L, count };
}
async function importLegacy() {
  const L = S.legacy; if (!L) return;
  const stop = busy('Alte Aufnahme wird übernommen…');
  try {
    const byId = new Map(L.photos.map(ph => [ph.id, ph]));
    const steps = [...(L.state.workSteps || [])];
    if ((L.state.currentMaterials || []).length || (L.state.currentPhotos || []).length) steps.push({ materials: L.state.currentMaterials, photos: L.state.currentPhotos, instructions: '' });
    const p = await fromLegacy(L.state.projectInfo || {}, steps, async ph => (byId.get(ph.id) || ph).data);
    await DB.putProject(p);
    localStorage.setItem('fw4.legacyDone', '1'); S.legacy = null;
    toast('Übernommen ✓'); go(`#/p/${p.id}`);
  } catch (e) { console.error(e); toast('Übernahme fehlgeschlagen: ' + e.message); }
  finally { stop(); }
}

/* ================= Ereignisse ================= */
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const act = el.dataset.act, id = el.dataset.id;
  const s = curStep();
  const [a, x, y] = act.split(':');
  switch (a) {
    case 'new': return newProject();
    case 'open': if (e.target.closest('[data-act="pmenu"]')) return; return go(`#/p/${id}`);
    case 'pmenu': e.stopPropagation(); return projectMenu(id);
    case 'import': return $('#pick-backup').click();
    case 'sync-out': return syncOut();
    case 'import-pptx': return $('#pick-pptx').click();
    case 'fullscreen': return toggleFullscreen();
    case 'legacy-import': return importLegacy();
    case 'legacy-hide': localStorage.setItem('fw4.legacyDone', '1'); S.legacy = null; return renderHome();
    case 'home': return go('#/');
    case 'nav-home': return go('#/');
    case 'nav-cad': return go('#/cad');
    case 'back-project': case 'done': return go(`#/p/${S.P.id}`);
    case 'step': return go(`#/p/${S.P.id}/s/${id}/material`);
    case 'up': return moveStep(id, -1);
    case 'down': return moveStep(id, 1);
    case 'add-step': return addStep();
    case 'slides': return go(`#/p/${S.P.id}/folien`);
    case 'export': await flush(); return exportSheet();
    case 'tab': return go(`#/p/${S.P.id}/s/${s.id}/${x}`);
    case 'next': return addStep(s.id);
    case 'smenu': return stepMenu();
    case 'scan': {
      const code = await Media.scan(); if (!code) return;
      $('#m-no').value = code; const h = matHistory()[code.toUpperCase()]; if (h && !$('#m-de').value) $('#m-de').value = h.description;
      toast('Gescannt: ' + code); $('#m-q').focus(); $('#m-q').select(); return;
    }
    case 'mq': { const q = $('#m-q'); q.value = Math.max(1, (parseInt(q.value, 10) || 1) + +x); return; }
    case 'mat-add': return addMaterial();
    case 'mi': { const m = s.materials[+x]; m.quantity = Math.max(1, m.quantity + +y); el.parentElement.querySelector('input').value = m.quantity; touch(); return refreshPreview(); }
    case 'mat-del': { const m = s.materials.splice(+x, 1)[0]; touch(); renderStep(); return toast(`${m.number} entfernt`, { label: 'Rückgängig', run: () => { s.materials.splice(+x, 0, m); touch(); renderStep(); } }); }
    case 'tool-add': s.tools.push({ tool: '', torque: '' }); touch(); renderStep(); return $$('[data-f^="tools."]').slice(-2)[0].focus();
    case 'tool-del': s.tools.splice(+x, 1); touch(); return renderStep();
    case 'cable-add': s.cables.push({ designation: '', from: '', to: '' }); touch(); renderStep(); return $$('[data-f^="cables."]').slice(-3)[0].focus();
    case 'cable-del': s.cables.splice(+x, 1); touch(); return renderStep();
    case 'dict': {
      if (!S.dict) S.dict = Media.dictation(t => {
        const st = curStep(); if (!st) return;
        st.instructions = (st.instructions.trim() ? st.instructions.replace(/\s+$/, '') + '\n' : '') + t.charAt(0).toUpperCase() + t.slice(1);
        const ta = $('#a-in'); if (ta) ta.value = st.instructions; touch(); refreshPreview();
      }, (on, err) => { const b = $('#mic'); if (b) { b.classList.toggle('on', on); b.textContent = on ? '⏹ Stopp' : '🎙 Diktieren'; } if (err && err !== 'aborted' && err !== 'no-speech') toast('Diktat: ' + err); });
      return S.dict && S.dict.toggle();
    }
    case 'pick': return $(x === 'camera' ? '#pick-camera' : '#pick-gallery').click();
    case 'webcam': { const st = s; await Media.webcam(b => addFiles([new File([b], 'webcam.jpg', { type: 'image/jpeg' })], st)); return; }
    case 'ph-mv': { const i = +x, j = i + +y; [s.photoIds[i], s.photoIds[j]] = [s.photoIds[j], s.photoIds[i]]; touch(); return renderStep(); }
    case 'ph-del': {
      const i = +x, pid = s.photoIds.splice(i, 1)[0]; touch(); renderStep();
      return toast('Foto gelöscht', { label: 'Rückgängig', run: () => { s.photoIds.splice(i, 0, pid); touch(); renderStep(); }, onTimeout: () => { if (!S.P || !S.P.steps.some(t => t.photoIds.includes(pid))) DB.deletePhotos([pid]); } });
    }
    case 'ph-mark': {
      const pid = s.photoIds[+x]; const ph = await DB.getPhoto(pid);
      const r = await Annotator.open(ph.orig || ph.blob, ph.marks); if (!r) return;
      const orig = ph.orig || ph.blob;
      const upd = { ...ph, orig: r.marks.length ? orig : null, marks: r.marks.length ? r.marks : null, blob: r.blob };
      upd.thumb = (await thumbFrom(r.blob)).blob;
      await DB.putPhoto(upd);
      URL.revokeObjectURL(S.thumbs.get(pid)); S.thumbs.set(pid, URL.createObjectURL(upd.thumb)); S.meta.set(pid, { id: pid, w: upd.w, h: upd.h, marked: !!upd.marks });
      touch(); return renderStep();
    }
  }
});

document.addEventListener('input', e => {
  const f = e.target.dataset.f; if (!f) return;
  const s = curStep(); if (!s) return;
  setPath(s, f, e.target.type === 'checkbox' ? e.target.checked : e.target.value);
  touch(); refreshPreview();
});
document.addEventListener('change', e => {
  if (e.target.dataset.f && e.target.dataset.f.startsWith('materials.') && e.target.dataset.f.endsWith('description')) {
    const s = curStep(); const i = +e.target.dataset.f.split('.')[1]; rememberMat(s.materials[i]);
  }
  if (e.target.id === 'm-no') { const h = matHistory()[e.target.value.trim().toUpperCase()]; if (h && h.description && !$('#m-de').value) $('#m-de').value = h.description; }
  if (e.target.dataset.f === 'isScanStep') renderStep();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && ['m-no', 'm-de', 'm-q'].includes(e.target.id)) { e.preventDefault(); addMaterial(); }
  if (e.key === 'Enter' && e.target.closest('.pcard') && e.target.classList.contains('pcard')) go(`#/p/${e.target.dataset.id}`);
});
['#pick-camera', '#pick-gallery'].forEach(sel => $(sel).addEventListener('change', e => { const st = curStep(); const f = [...e.target.files]; e.target.value = ''; addFiles(f, st); }));
$('#pick-backup').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) importFile(f); });
$('#pick-pptx').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) importPptx(f); });
document.addEventListener('dragover', e => { if (S.route.view === 'step') e.preventDefault(); });
document.addEventListener('drop', e => { if (S.route.view !== 'step') return; e.preventDefault(); const st = curStep(); addFiles(e.dataTransfer.files, st); if (S.route.tab !== 'fotos') go(`#/p/${S.P.id}/s/${st.id}/fotos`); });
document.addEventListener('paste', e => { if (S.route.view !== 'step') return; const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/')); if (files.length) { e.preventDefault(); addFiles(files, curStep()); } });

/* ================= Vollbild (PC) ================= */
const fsOK = () => !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
function fsIcon() { return document.fullscreenElement || document.webkitFullscreenElement ? '🗗' : '⛶'; }
function addFsButton() {
  const bar = $('.top-in'); if (!bar || !fsOK() || $('.fs-btn', bar)) return;
  const b = document.createElement('button');
  b.className = 'icon-btn fs-btn'; b.dataset.act = 'fullscreen'; b.title = 'Vollbild ein/aus (F11)'; b.setAttribute('aria-label', 'Vollbild');
  b.textContent = fsIcon(); bar.appendChild(b);
}
function toggleFullscreen() {
  const d = document, el = d.documentElement;
  if (d.fullscreenElement || d.webkitFullscreenElement) (d.exitFullscreen || d.webkitExitFullscreen).call(d);
  else { const r = (el.requestFullscreen || el.webkitRequestFullscreen).call(el); if (r && r.catch) r.catch(() => toast('Vollbild nicht möglich – F11 drücken.')); }
}
['fullscreenchange', 'webkitfullscreenchange'].forEach(ev => document.addEventListener(ev, () => { $$('.fs-btn').forEach(b => b.textContent = fsIcon()); fitSlides(); }));
new MutationObserver(addFsButton).observe($('#app'), { childList: true });

/* ================= Start ================= */
(async function init() {
  try { await DB.open(); }
  catch (e) { $('#app').innerHTML = `<div class="wrap"><div class="banner">Speicher nicht verfügbar (privater Modus?). ${esc(e.message)}</div></div>`; return; }
  // als gelöscht markierte Projekte (Undo nicht abgeschlossen) endgültig entfernen
  for (const p of await DB.allProjects()) if (p.hidden) await DB.deleteProject(p.id);
  await checkLegacy();
  if (!location.hash || location.hash === '#') {
    const last = localStorage.getItem('fw4.route');
    if (last && last.startsWith('#/p/')) { history.replaceState(null, '', last); }
  }
  route();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
