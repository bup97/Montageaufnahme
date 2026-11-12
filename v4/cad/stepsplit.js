/* STEP-Zerleger für große Baugruppen.
   Der STEP-Leser (OpenCascade im Browser) hat höchstens 2 GB Speicher. Sehr große Dateien füllen den schon
   beim Einlesen – dann entstehen keine Oberflächen mehr. Deshalb: Datei selbst in die einzelnen Bauteile zerlegen,
   jedes Bauteil einzeln lesen (wenig Speicher, Wiederverwendung bei mehrfach verbauten Teilen) und die Baugruppe
   mit den Einbaupositionen aus der Datei wieder zusammensetzen.
   Ergebnis im selben Format wie der Worker es sonst liefert: [{ name, path, pos, nrm, idx }]. */
(function (root) {
  'use strict';

  // ---------- Datei in Einträge zerlegen – direkt auf den Bytes ----------
  // Sehr große Dateien (> ~500 MB) passen nicht als EIN Text in den Browser. Deshalb werden nur die Positionen der
  // Einträge gemerkt und jeder Eintrag erst bei Bedarf in Text umgewandelt.
  function latin1(u8) {
    if (u8.length < 0x8000) return String.fromCharCode.apply(null, u8);
    const parts = [], CH = 0x8000;
    for (let o = 0; o < u8.length; o += CH) parts.push(String.fromCharCode.apply(null, u8.subarray(o, Math.min(u8.length, o + CH))));
    return parts.join('');
  }
  function toBytes(str) {
    const b = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); b[i] = c < 256 ? c : 63; }
    return b;
  }
  class Ents {
    constructor(u8, idA, stA, enA, n) {
      this.u8 = u8; this.n = n; this.idA = idA; this.stA = stA; this.enA = enA;
      let max = 0; for (let i = 0; i < n; i++) if (idA[i] > max) max = idA[i];
      if (max < 60e6) { this.slot = new Int32Array(max + 1).fill(-1); for (let i = 0; i < n; i++) this.slot[idA[i]] = i; }
      else { this.map = new Map(); for (let i = 0; i < n; i++) this.map.set(idA[i], i); }
      this.size = n;
    }
    _i(id) { if (this.slot) return id >= 0 && id < this.slot.length ? this.slot[id] : -1; const v = this.map.get(id); return v === undefined ? -1 : v; }
    has(id) { return this._i(id) >= 0; }
    get(id) { const i = this._i(id); return i < 0 ? undefined : latin1(this.u8.subarray(this.stA[i], this.enA[i])); }
    // Typname ohne den ganzen Eintrag zu lesen; '(COMPLEX)' für zusammengesetzte Einträge
    typeAt(id) {
      const i = this._i(id); if (i < 0) return ''; const u = this.u8; let p = this.stA[i]; const e = this.enA[i];
      if (u[p] === 40) return '(COMPLEX)';
      let t = ''; while (p < e) { const c = u[p]; if ((c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95) { t += String.fromCharCode(c); p++; } else break; }
      return t;
    }
    *ids() { for (let i = 0; i < this.n; i++) yield this.idA[i]; }
    *[Symbol.iterator]() { for (let i = 0; i < this.n; i++) yield [this.idA[i], this.get(this.idA[i])]; }
    values() { const self = this; return (function* () { for (let i = 0; i < self.n; i++) yield latin1(self.u8.subarray(self.stA[i], self.enA[i])); })(); }
  }
  function parseBytes(u8) {
    // DATA-Abschnitt finden (Kopf ist klein)
    const headTxt = latin1(u8.subarray(0, Math.min(u8.length, 4 << 20)));
    const dm = /\bDATA\s*;/.exec(headTxt); if (!dm) throw new Error('Kein DATA-Abschnitt');
    const header = headTxt.slice(0, dm.index);
    let cap = Math.max(1024, Math.min(1 << 26, (u8.length / 40) | 0));
    let idA = new Uint32Array(cap), stA = new Uint32Array(cap), enA = new Uint32Array(cap), n = 0;
    const grow = () => { cap *= 2; const a = new Uint32Array(cap); a.set(idA); idA = a; const b = new Uint32Array(cap); b.set(stA); stA = b; const c = new Uint32Array(cap); c.set(enA); enA = c; };
    const L = u8.length; let i = dm.index + dm[0].length, start = i, inStr = false;
    const isWs = (c) => c === 32 || c === 10 || c === 13 || c === 9;
    for (; i < L; i++) {
      const c = u8[i];
      if (c === 39) { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === 47 && u8[i + 1] === 42) { const e = u8.indexOf(42, i + 2); let j = e; while (j >= 0 && u8[j + 1] !== 47) j = u8.indexOf(42, j + 1); i = j < 0 ? L : j + 1; continue; }  // /* … */
      if (c !== 59) continue;                           // ;
      let a = start; start = i + 1;
      while (a < i && isWs(u8[a])) a++;
      if (u8[a] === 35) {                               // #id = body
        let id = 0, p = a + 1; while (p < i && u8[p] >= 48 && u8[p] <= 57) { id = id * 10 + (u8[p] - 48); p++; }
        while (p < i && u8[p] !== 61) p++; p++;         // '='
        while (p < i && isWs(u8[p])) p++;
        let e = i; while (e > p && isWs(u8[e - 1])) e--;
        if (n >= cap) grow();
        idA[n] = id; stA[n] = p; enA[n] = e; n++;
      } else if (u8[a] === 69 && u8[a + 1] === 78 && u8[a + 2] === 68 && u8[a + 3] === 83) break;   // ENDSEC
    }
    return { header, ents: new Ents(u8, idA, stA, enA, n) };
  }
  function parse(txt) { return parseBytes(toBytes(txt)); }
  const typeOf = (b) => { const m = /^([A-Z0-9_]+)\s*\(/.exec(b); return m ? m[1] : '(COMPLEX)'; };
  // Argumente eines (Teil-)Eintrags: TYP( a, b, (c,d), 'x' )
  function args(body, type) {
    let at = 0;
    if (type) { const m = new RegExp('(^|[\\s()])' + type + '\\s*\\(').exec(body); if (!m) return null; at = m.index + m[0].length; }
    else at = body.indexOf('(') + 1;
    const out = []; let depth = 0, inStr = false, cur = '';
    for (let i = at; i < body.length; i++) {
      const ch = body[i];
      if (ch === "'") { inStr = !inStr; cur += ch; continue; }
      if (inStr) { cur += ch; continue; }
      if (ch === '(') { depth++; cur += ch; continue; }
      if (ch === ')') { if (depth === 0) { out.push(cur.trim()); return out; } depth--; cur += ch; continue; }
      if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    return out;
  }
  const ref = (a) => (a && a[0] === '#') ? +a.slice(1) : null;
  const refs = (s) => { const r = []; const re = /#(\d+)/g; let m; while ((m = re.exec(s))) r.push(+m[1]); return r; };
  function str(a) {
    if (!a || a[0] !== "'") return '';
    let s = a.slice(1, -1).replace(/''/g, "'");
    s = s.replace(/\\X2\\([0-9A-F]+)\\X0\\/gi, (_, h) => h.match(/.{4}/g).map(x => String.fromCharCode(parseInt(x, 16))).join(''));
    s = s.replace(/\\X\\([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
    s = s.replace(/\\S\\(.)/g, (_, c) => String.fromCharCode(c.charCodeAt(0) + 128));
    return s.trim();
  }
  function nums(a) { return (a || '').replace(/[()]/g, '').split(',').map(Number); }

  // ---------- Matrizen (4×4, spaltenweise wie THREE) ----------
  const I = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  function mul(a, b) {
    const o = new Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s;
    }
    return o;
  }
  function inv(m) {   // starre Transformation: R^T, -R^T t
    const o = I();
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[c * 4 + r] = m[r * 4 + c];
    for (let r = 0; r < 3; r++) o[12 + r] = -(o[r] * m[12] + o[4 + r] * m[13] + o[8 + r] * m[14]);
    return o;
  }
  const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

  // ---------- Aufbau der Baugruppe ----------
  function model(ents) {
    const byType = new Map();
    for (const id of ents.ids()) {
      const t = ents.typeAt(id);
      if (t === '(COMPLEX)') { (byType.get(t) || byType.set(t, []).get(t)).push(id); continue; }
      if (/^(PRODUCT_DEFINITION|PRODUCT_DEFINITION_WITH_ASSOCIATED_DOCUMENTS|DOCUMENT_FILE|APPLIED_DOCUMENT_REFERENCE|PRODUCT_DEFINITION_FORMATION|PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE|PRODUCT|PRODUCT_DEFINITION_SHAPE|SHAPE_DEFINITION_REPRESENTATION|NEXT_ASSEMBLY_USAGE_OCCURRENCE|CONTEXT_DEPENDENT_SHAPE_REPRESENTATION|SHAPE_REPRESENTATION_RELATIONSHIP)$/.test(t))
        (byType.get(t) || byType.set(t, []).get(t)).push(id);
    }
    const get = (t) => byType.get(t) || [];
    const pdName = new Map();
    for (const pd of [...get('PRODUCT_DEFINITION'), ...get('PRODUCT_DEFINITION_WITH_ASSOCIATED_DOCUMENTS')]) {
      const f = ref(args(ents.get(pd))[2]); const fa = f && ents.get(f) ? args(ents.get(f)) : null;
      const p = fa ? ref(fa[2]) : null; const pa = p && ents.get(p) ? args(ents.get(p)) : null;
      pdName.set(pd, pa ? (str(pa[1]) || str(pa[0])) : 'Teil');
    }
    const pdsDef = new Map();   // PDS -> PD oder NAUO
    for (const s of get('PRODUCT_DEFINITION_SHAPE')) pdsDef.set(s, ref(args(ents.get(s))[2]));
    const repsOfPd = new Map(), sdrOfPd = new Map();
    for (const s of get('SHAPE_DEFINITION_REPRESENTATION')) {
      const a = args(ents.get(s)); const pd = pdsDef.get(ref(a[0])); const rep = ref(a[1]);
      if (pd && pdName.has(pd)) { (repsOfPd.get(pd) || repsOfPd.set(pd, []).get(pd)).push(rep); (sdrOfPd.get(pd) || sdrOfPd.set(pd, []).get(pd)).push(s); }
    }
    // einfache Verknüpfungen zwischen Darstellungen (SolidWorks: SHAPE_REPRESENTATION ↔ ADVANCED_BREP_SHAPE_REPRESENTATION)
    const srr = new Map();      // rep -> [ [relEntity, otherRep] ]
    for (const s of get('SHAPE_REPRESENTATION_RELATIONSHIP')) {
      const a = args(ents.get(s)); const r1 = ref(a[2]), r2 = ref(a[3]);
      (srr.get(r1) || srr.set(r1, []).get(r1)).push([s, r2]); (srr.get(r2) || srr.set(r2, []).get(r2)).push([s, r1]);
    }
    const children = new Map(), isChild = new Set();
    const nauoInfo = new Map();
    for (const n of get('NEXT_ASSEMBLY_USAGE_OCCURRENCE')) {
      const a = args(ents.get(n)); const parent = ref(a[3]), child = ref(a[4]);
      (children.get(parent) || children.set(parent, []).get(parent)).push(n);
      isChild.add(child); nauoInfo.set(n, { parent, child, name: str(a[1]) });
    }
    // Einbaupositionen
    const placeOf = new Map();  // NAUO -> { rep1, rep2, it1, it2 }
    for (const c of get('CONTEXT_DEPENDENT_SHAPE_REPRESENTATION')) {
      const a = args(ents.get(c)); const rr = ents.get(ref(a[0])); const nauo = pdsDef.get(ref(a[1]));
      if (!rr || !nauoInfo.has(nauo)) continue;
      const ra = args(rr, 'REPRESENTATION_RELATIONSHIP'), ta = args(rr, 'REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION');
      if (!ra || !ta) continue;
      const tr = ents.get(ref(ta[0])); if (!tr || typeOf(tr) !== 'ITEM_DEFINED_TRANSFORMATION') continue;
      const ti = args(tr);
      placeOf.set(nauo, { rep1: ref(ra[2]), rep2: ref(ra[3]), it1: ref(ti[2]), it2: ref(ti[3]) });
    }
    const roots = [...pdName.keys()].filter(pd => !isChild.has(pd));
    // Externe Verweise (Teile in eigenen STEP-Dateien): Dateiname je Bauteil
    const fileOf = (d) => { const a = args(ents.get(d) || ''); if (!a) return ''; const c = [str(a[0]), str(a[1])].find(x => /\.(stp|step|p21)$/i.test(x)) || str(a[0]) || str(a[1]); return c; };
    const docOfPd = new Map();
    for (const r of get('APPLIED_DOCUMENT_REFERENCE')) { const a = args(ents.get(r)); const f = fileOf(ref(a[0])); for (const id of refs(a[2] || '')) if (pdName.has(id) && f) docOfPd.set(id, f); }
    for (const pd of get('PRODUCT_DEFINITION_WITH_ASSOCIATED_DOCUMENTS')) { const a = args(ents.get(pd)); for (const d of refs(a[4] || '')) { const f = fileOf(d); if (f && !docOfPd.has(pd)) docOfPd.set(pd, f); } }
    return { pdName, repsOfPd, sdrOfPd, srr, children, nauoInfo, placeOf, roots, docOfPd, docCount: get('DOCUMENT_FILE').length };
  }

  function lengthScale(ents) {
    for (const id of ents.ids()) {
      const t = ents.typeAt(id); if (t !== '(COMPLEX)' && t !== 'CONVERSION_BASED_UNIT' && t !== 'SI_UNIT') continue;
      const b = ents.get(id); if (b.indexOf('LENGTH_UNIT') < 0) continue;
      const si = /SI_UNIT\s*\(\s*(\.[A-Z]+\.|\$)\s*,\s*\.METRE\./.exec(b);
      if (si) return { '$': 1000, '.MILLI.': 1, '.CENTI.': 10, '.DECI.': 100, '.KILO.': 1e6, '.MICRO.': 0.001 }[si[1]] || 1;
      if (/CONVERSION_BASED_UNIT\s*\(\s*'INCH'/i.test(b)) return 25.4;
      if (/CONVERSION_BASED_UNIT\s*\(\s*'FOOT'/i.test(b)) return 304.8;
    }
    return 1;
  }
  function placement(ents, id, scale) {
    if (ents.typeAt(id) !== 'AXIS2_PLACEMENT_3D') return I(); const b = ents.get(id);
    const a = args(b);
    const pt = nums(args(ents.get(ref(a[1])))[1]).map(v => v * scale);
    const dir = (r) => { const e = r != null ? ents.get(r) : null; return e ? norm(nums(args(e)[1])) : null; };
    const z = dir(ref(a[2])) || [0, 0, 1];
    let x = dir(ref(a[3])) || (Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]);
    const d = x[0] * z[0] + x[1] * z[1] + x[2] * z[2];
    x = norm([x[0] - d * z[0], x[1] - d * z[1], x[2] - d * z[2]]);
    const y = cross(z, x);
    return [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, pt[0], pt[1], pt[2], 1];
  }

  // Alle Darstellungen eines Bauteils (inkl. verknüpfter) + nötige Verknüpfungs-Einträge
  function repGroup(M, pd) {
    const reps = new Set(M.repsOfPd.get(pd) || []), rels = new Set(), stack = [...reps];
    while (stack.length) {
      const r = stack.pop();
      for (const [rel, other] of M.srr.get(r) || []) { rels.add(rel); if (!reps.has(other)) { reps.add(other); stack.push(other); } }
    }
    return { reps, rels };
  }
  // Eigene Datei für ein Bauteil: alles, was von seinen Darstellungen aus erreichbar ist
  // Verweise direkt aus den Bytes lesen (#123) – ohne Text
  function refsAt(ents, id, out) {
    const i = ents._i(id); if (i < 0) return false; const u = ents.u8, e = ents.enA[i]; let p = ents.stA[i], inStr = false;
    for (; p < e; p++) { const c = u[p]; if (c === 39) { inStr = !inStr; continue; } if (inStr || c !== 35) continue;
      let v = 0, q = p + 1; while (q < e && u[q] >= 48 && u[q] <= 57) { v = v * 10 + (u[q] - 48); q++; } if (q > p + 1) out.push(v); p = q - 1; }
    return true;
  }
  function closure(ents, starts) {
    const seen = new Set(), stack = [...starts];
    while (stack.length) {
      const id = stack.pop(); if (seen.has(id)) continue;
      if (!refsAt(ents, id, stack)) continue;
      seen.add(id);
    }
    return seen;
  }
  // Teil-Datei direkt als Bytes zusammensetzen (kein großer Text)
  function stepBytes(ents, header, seen) {
    const ids = [...seen].sort((a, b) => a - b), enc = (t) => toBytes(t);
    const head = enc(header + 'DATA;\n'), tail = enc('ENDSEC;\nEND-ISO-10303-21;\n');
    let len = head.length + tail.length; const pre = [];
    for (const id of ids) { const i = ents._i(id); const p = enc('#' + id + '='); pre.push(p); len += p.length + (ents.enA[i] - ents.stA[i]) + 2; }
    const out = new Uint8Array(len); let o = 0; out.set(head, o); o += head.length;
    ids.forEach((id, k) => { const i = ents._i(id); out.set(pre[k], o); o += pre[k].length; out.set(ents.u8.subarray(ents.stA[i], ents.enA[i]), o); o += ents.enA[i] - ents.stA[i]; out[o++] = 59; out[o++] = 10; });
    out.set(tail, o);
    return out;
  }
  const SOLID_T = new Set(['MANIFOLD_SOLID_BREP', 'BREP_WITH_VOIDS', 'FACETED_BREP', 'SHELL_BASED_SURFACE_MODEL', 'TRIANGULATED_FACE', 'TESSELLATED_SOLID', 'TESSELLATED_SHELL']);
  const SOLID = /\b(MANIFOLD_SOLID_BREP|BREP_WITH_VOIDS|FACETED_BREP|SHELL_BASED_SURFACE_MODEL|TRIANGULATED_FACE|TESSELLATED_SOLID|TESSELLATED_SHELL)\s*\(/;

  // ---------- Hauptfunktion ----------
  // opts.ext(name) → Uint8Array der externen Datei (oder null); opts.cache teilt gelesene Dateien zwischen Ebenen
  // opts.renew() → neuer STEP-Leser (frischer Speicher), wenn der alte voll ist oder abstürzt
  async function read(occt, u8, mesh, post, log, opts) {
    opts = opts || {}; const depth = opts.depth || 0; const cache = opts.cache || (opts.cache = new Map()); const missing = opts.missing || (opts.missing = new Set());
    const cur = opts.cur || (opts.cur = { o: occt, renewed: 0 });
    const t0 = Date.now();
    const { header, ents } = parseBytes(u8);
    if (!depth) log(`Datei zerlegt: ${ents.size.toLocaleString('de-DE')} Einträge (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    const M = model(ents);
    if (!M.pdName.size) throw new Error('Keine Bauteile gefunden');
    const scale = lengthScale(ents);
    // Farben: STYLED_ITEM zeigt auf die Geometrie (nicht umgekehrt) – daher getrennt nachschlagen
    const styled = new Map();
    for (const id of ents.ids()) { const t = ents.typeAt(id); if (t !== 'STYLED_ITEM' && t !== 'OVER_RIDING_STYLED_ITEM') continue; const it = ref(args(ents.get(id))[2]); if (it) (styled.get(it) || styled.set(it, []).get(it)).push(id); }
    const colorOf = (seen) => {
      for (const id of seen) for (const si of styled.get(id) || []) {
        const st = [si], vis = new Set();
        while (st.length) { const x = st.pop(); if (vis.has(x)) continue; vis.add(x); const b = ents.get(x); if (!b) continue;
          if (/^COLOUR_RGB\s*\(/.test(b)) { const a = args(b); const c = [+a[1], +a[2], +a[3]]; if (c.every(v => v >= 0 && v <= 1)) return c; }
          for (const r of refs(b)) st.push(r); }
      }
      return null;
    };
    // Welche Bauteile haben eigene Geometrie?
    const geo = new Map();    // pd -> Startpunkte für die eigene Datei
    for (const pd of M.pdName.keys()) {
      const g = repGroup(M, pd);
      if (!g.reps.size) continue;
      const starts = [...(M.sdrOfPd.get(pd) || []), ...g.rels];
      const seen = closure(ents, starts);
      let has = false; for (const id of seen) if (SOLID_T.has(ents.typeAt(id))) { has = true; break; }
      if (has) geo.set(pd, starts);
    }
    log(`Zerlegt: ${M.pdName.size} Bauteile, davon ${geo.size} mit Geometrie, ${M.nauoInfo.size} Einbauten (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    // Jedes Bauteil einzeln lesen
    const meshOf = new Map(); let k = 0, failed = [];
    for (const [pd, starts] of geo) {
      const seen = closure(ents, starts);
      let r = null;
      const bytes = stepBytes(ents, header, seen);
      const opt = { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: mesh.lin, angularDeflection: mesh.ang };
      for (let attempt = 0; attempt < 2 && !r; attempt++) {
        try { r = cur.o.ReadStepFile(bytes, opt); }
        catch (e) {
          log('Fehler bei ' + M.pdName.get(pd) + ': ' + (e && e.message || e));
          if (opts.renew && attempt === 0) { cur.o = await opts.renew(); cur.renewed++; log('STEP-Leser neu gestartet'); } else break;
        }
      }
      // Speicher des Lesers wächst mit jedem Teil – rechtzeitig frisch starten
      if (opts.renew && cur.o.HEAPU8.buffer.byteLength > 1400 * 1048576) { cur.o = await opts.renew(); cur.renewed++; }
      let nv = 0, ni = 0;
      if (r && r.meshes) for (const m of r.meshes) { nv += m.attributes.position.array.length; ni += m.index ? m.index.array.length : 0; }
      if (!ni) { failed.push(M.pdName.get(pd)); }
      else {
        const pos = new Float32Array(nv), nrm = new Float32Array(nv), idx = new Uint32Array(ni); let vo = 0, io = 0, color = null;
        for (const m of r.meshes) {
          const p = m.attributes.position.array, nn = m.attributes.normal ? m.attributes.normal.array : null, ix = m.index ? m.index.array : [];
          pos.set(p, vo); if (nn) nrm.set(nn, vo); const base = vo / 3;
          for (let q = 0; q < ix.length; q++) idx[io + q] = ix[q] + base;
          vo += p.length; io += ix.length;
          if (!color && m.color) color = m.color;
        }
        meshOf.set(pd, { pos, nrm, idx, color: color || colorOf(seen) });
      }
      r = null;
      if (++k % 3 === 0 || k === geo.size) post({ type: 'progress', phase: 'read', value: k / geo.size });
    }
    if (failed.length) log(`Ohne Oberfläche: ${failed.length} Bauteil(e): ${failed.slice(0, 8).join(', ')}${failed.length > 8 ? ' …' : ''}`);
    // Baugruppe zusammensetzen
    const parts = []; let guard = 0, extDone = 0;
    if (!depth && opts.ext) opts.extTotal = new Set([...M.docOfPd.values()]).size || 0;
    const emit = async (pd, W, path, anc, key) => {   // anc = übergeordnete Baugruppen-Instanzen [{k, n}] (ohne Wurzel)
      if (++guard > 200000) throw new Error('Baugruppenstruktur zu tief verschachtelt');
      const name = M.pdName.get(pd);
      let m = meshOf.get(pd);
      // keine eigene Geometrie, aber Verweis auf eine eigene Datei → diese lesen (einmal je Datei) und hier einsetzen
      const fname = !m && M.docOfPd.get(pd);
      if (fname && opts.ext && depth < 8) {
        const key0 = fname.split(/[\\/]/).pop().toLowerCase();
        if (!cache.has(key0)) {
          const bytes = opts.ext(fname);
          if (!bytes) { cache.set(key0, null); missing.add(fname.split(/[\\/]/).pop()); }
          else { try { cache.set(key0, (await read(cur.o, bytes, mesh, () => {}, log, Object.assign({}, opts, { depth: depth + 1 }))).parts); } catch (e) { log('Fehler in ' + fname + ': ' + (e.message || e)); cache.set(key0, null); } }
          extDone++; if (opts.extTotal) post({ type: 'progress', phase: 'read', value: Math.min(1, extDone / opts.extTotal) });
        }
        const sub = cache.get(key0);
        if (sub && sub.length) {
          const single = sub.length === 1;
          for (const sp of sub) {
            const n = sp.pos.length / 3, pos = new Float32Array(sp.pos.length), nrm = new Float32Array(sp.nrm.length);
            for (let i = 0; i < n; i++) {
              const x = sp.pos[i * 3], y = sp.pos[i * 3 + 1], z = sp.pos[i * 3 + 2];
              pos[i * 3] = W[0] * x + W[4] * y + W[8] * z + W[12]; pos[i * 3 + 1] = W[1] * x + W[5] * y + W[9] * z + W[13]; pos[i * 3 + 2] = W[2] * x + W[6] * y + W[10] * z + W[14];
              const a = sp.nrm[i * 3], b = sp.nrm[i * 3 + 1], c = sp.nrm[i * 3 + 2];
              nrm[i * 3] = W[0] * a + W[4] * b + W[8] * c; nrm[i * 3 + 1] = W[1] * a + W[5] * b + W[9] * c; nrm[i * 3 + 2] = W[2] * a + W[6] * b + W[10] * c;
            }
            const own = key === null ? [] : anc.concat({ k: key, n: name });
            parts.push({ name: single ? name : sp.name, path: single ? path.slice() : path.concat(name, sp.path.slice(1)), asm: single ? anc.slice() : own.concat((sp.asm || []).map(q => ({ k: (key || 'r') + '>' + q.k, n: q.n }))), color: sp.color, pos, nrm, idx: sp.idx.slice() });
          }
        }
      }
      if (m) {
        const n = m.pos.length / 3, pos = new Float32Array(m.pos.length), nrm = new Float32Array(m.nrm.length);
        for (let i = 0; i < n; i++) {
          const x = m.pos[i * 3], y = m.pos[i * 3 + 1], z = m.pos[i * 3 + 2];
          pos[i * 3] = W[0] * x + W[4] * y + W[8] * z + W[12]; pos[i * 3 + 1] = W[1] * x + W[5] * y + W[9] * z + W[13]; pos[i * 3 + 2] = W[2] * x + W[6] * y + W[10] * z + W[14];
          const a = m.nrm[i * 3], b = m.nrm[i * 3 + 1], c = m.nrm[i * 3 + 2];
          nrm[i * 3] = W[0] * a + W[4] * b + W[8] * c; nrm[i * 3 + 1] = W[1] * a + W[5] * b + W[9] * c; nrm[i * 3 + 2] = W[2] * a + W[6] * b + W[10] * c;
        }
        parts.push({ name, path: path.slice(), asm: anc.slice(), color: m.color, pos, nrm, idx: m.idx.slice() });
      }
      const ownReps = repGroup(M, pd).reps;
      for (const nauo of M.children.get(pd) || []) {
        const info = M.nauoInfo.get(nauo), pl = M.placeOf.get(nauo);
        let T = I();
        if (pl) {
          const A1 = placement(ents, pl.it1, scale), A2 = placement(ents, pl.it2, scale);
          // rep1 = Kind → Kind-in-Eltern = A2·A1⁻¹, sonst umgekehrt
          T = ownReps.has(pl.rep1) && !ownReps.has(pl.rep2) ? mul(A1, inv(A2)) : mul(A2, inv(A1));
        }
        await emit(info.child, mul(W, T), path.concat(name), key === null ? [] : anc.concat({ k: key, n: name }), (key || 'r') + '/' + nauo);
      }
    };
    for (const r of M.roots) await emit(r, I(), [], [], null);
    const rootName = M.roots.length === 1 ? M.pdName.get(M.roots[0]) : '';
    log(`Zusammengesetzt: ${parts.length} Teile (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    if (!depth && missing.size) log(`Fehlende Teiledateien (${missing.size}): ${[...missing].slice(0, 12).join(', ')}${missing.size > 12 ? ' …' : ''}`);
    if (!depth && cache.size) log(`Externe Teiledateien gelesen: ${[...cache.values()].filter(Boolean).length} von ${cache.size}`);
    if (!depth && cur.renewed) log(`STEP-Leser ${cur.renewed}× neu gestartet (Speicher)`);
    return { parts, rootName, failed: failed.length, heapMB: Math.round(cur.o.HEAPU8.buffer.byteLength / 1048576), occt: cur.o, products: M.pdName.size, withGeo: geo.size, occurrences: M.nauoInfo.size, docs: M.docCount, missing: [...missing], extRead: [...cache.values()].filter(Boolean).length };
  }

  const api = { read, parse, parseBytes, model };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.StepSplit = api;
})(typeof self !== 'undefined' ? self : this);
