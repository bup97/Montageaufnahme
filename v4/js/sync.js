/* Übertragung zwischen Geräten (Handy ↔ PC) über eine Datei.
   Die Kennungen von Anleitungen, Schritten und Fotos bleiben erhalten – so erkennt das andere Gerät
   eine Anleitung wieder und aktualisiert sie, statt eine Kopie anzulegen. */
'use strict';

const Sync = (() => {
  const FORMAT = 'funkwerk-recorder-sync';

  function stamp() {
    const d = new Date(), z = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}`;
  }
  const safe = s => String(s || '').replace(/[^a-zA-Z0-9äöüÄÖÜß-]+/g, '_').replace(/^_+|_+$/g, '');

  /* ---------- Datei erstellen ---------- */
  async function build(projects, { getPhoto, appVersion, onProgress } = {}) {
    const files = [], photos = {};
    for (const p of projects) {
      for (const s of p.steps) for (const id of s.photoIds || []) {
        const ph = await getPhoto(id); if (!ph) continue;
        photos[id] = { projectId: p.id, w: ph.w, h: ph.h, createdAt: ph.createdAt || '', marks: ph.marks || null, orig: !!ph.orig, thumb: !!ph.thumb };
        files.push({ name: `photos/${id}.jpg`, data: ph.blob });
        if (ph.orig) files.push({ name: `orig/${id}.jpg`, data: ph.orig });
        if (ph.thumb) files.push({ name: `thumbs/${id}.jpg`, data: ph.thumb });
      }
    }
    const manifest = { format: FORMAT, version: 1, exported: new Date().toISOString(), appVersion: appVersion || '',
      projects: projects.map(p => { const c = JSON.parse(JSON.stringify(p)); delete c.hidden; return c; }), photos };
    files.unshift({ name: 'manifest.json', data: JSON.stringify(manifest) });
    const blob = await Zip.write(files, onProgress);
    const name = projects.length === 1
      ? ['Sicherung', safe(projects[0].product || projects[0].customer || 'Anleitung'), safe(projects[0].variant), stamp()].filter(Boolean).join('_') + '.zip'
      : `Montage-Recorder_Uebertragung_${projects.length}_Anleitungen_${stamp()}.zip`;
    return { blob, name, type: 'application/zip', count: projects.length, photos: Object.keys(photos).length };
  }

  /* ---------- Datei lesen ---------- */
  const dataURLtoBlob = d => fetch(d).then(r => r.blob());

  async function read(file) {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if (head[0] === 0x50 && head[1] === 0x4b) {           // ZIP
      const zip = await Zip.read(await file.arrayBuffer());
      const m = JSON.parse(await zip.text('manifest.json') || 'null');
      if (!m || m.format !== FORMAT) throw new Error('Das ist keine Übertragungsdatei des Montage-Recorders.');
      return {
        exported: m.exported, projects: m.projects,
        async photo(id) {
          const meta = m.photos[id]; if (!meta) return null;
          return { id, projectId: meta.projectId, w: meta.w, h: meta.h, createdAt: meta.createdAt, marks: meta.marks || null,
            blob: await zip.blob(`photos/${id}.jpg`, 'image/jpeg'),
            orig: meta.orig ? await zip.blob(`orig/${id}.jpg`, 'image/jpeg') : null,
            thumb: meta.thumb ? await zip.blob(`thumbs/${id}.jpg`, 'image/jpeg') : null };
        }
      };
    }
    // Ältere Sicherung (eine Anleitung als JSON)
    const data = JSON.parse(await file.text());
    if (data.format === 'funkwerk-recorder-backup' && data.project) {
      return {
        exported: data.exported, projects: [data.project],
        async photo(id) {
          const ph = data.photos[id]; if (!ph) return null;
          return { id, projectId: data.project.id, w: ph.w, h: ph.h, createdAt: ph.createdAt, marks: ph.marks || null,
            blob: await dataURLtoBlob(ph.data), orig: ph.orig ? await dataURLtoBlob(ph.orig) : null, thumb: null };
        }
      };
    }
    return null; // anderes JSON (z. B. PC-Konverter-Format) – macht der Aufrufer
  }

  /* ---------- Vergleich mit diesem Gerät ---------- */
  async function plan(bundle) {
    const out = [];
    for (const p of bundle.projects) {
      const local = await DB.getProject(p.id);
      let status = 'new';
      if (local && !local.hidden) status = p.updatedAt > local.updatedAt ? 'newer' : p.updatedAt === local.updatedAt ? 'same' : 'older';
      out.push({ project: p, local: local && !local.hidden ? local : null, status });
    }
    return out;
  }

  /* ---------- Übernehmen ---------- */
  async function apply(bundle, items, { makeThumb, onProgress } = {}) {
    let n = 0;
    for (const it of items) {
      const p = JSON.parse(JSON.stringify(it.project)); delete p.hidden;
      const want = new Set(p.steps.flatMap(s => s.photoIds || []));
      for (const id of want) {
        const ph = await bundle.photo(id);
        if (!ph || !ph.blob) { p.steps.forEach(s => { s.photoIds = s.photoIds.filter(x => x !== id); }); continue; }
        ph.projectId = p.id;
        if (!ph.thumb && makeThumb) ph.thumb = await makeThumb(ph.blob);
        await DB.putPhoto(ph);
      }
      // Fotos, die es in der neueren Fassung nicht mehr gibt, auf diesem Gerät entfernen
      const old = (await DB.photoIdsOf(p.id)).filter(id => !want.has(id));
      if (old.length) await DB.deletePhotos(old);
      await DB.putProject(p);
      if (onProgress) onProgress(++n, items.length);
    }
    return n;
  }

  return { build, read, plan, apply };
})();

window.Sync = Sync;
