// asmcore.js – Demontage-Analyse ohne Abhaengigkeiten (Browser + Node)
(function (root) {
  'use strict';

  // ---------------- BVH ----------------
  function buildBVH(pos, idx) {
    const nt = idx.length / 3;
    const cx = new Float32Array(nt), cy = new Float32Array(nt), cz = new Float32Array(nt);
    const bmin = new Float32Array(nt * 3), bmax = new Float32Array(nt * 3);
    for (let t = 0; t < nt; t++) {
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (let k = 0; k < 3; k++) {
        const v = idx[t * 3 + k] * 3, x = pos[v], y = pos[v + 1], z = pos[v + 2];
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
      bmin[t * 3] = x0; bmin[t * 3 + 1] = y0; bmin[t * 3 + 2] = z0;
      bmax[t * 3] = x1; bmax[t * 3 + 1] = y1; bmax[t * 3 + 2] = z1;
      cx[t] = (x0 + x1) / 2; cy[t] = (y0 + y1) / 2; cz[t] = (z0 + z1) / 2;
    }
    const order = new Uint32Array(nt); for (let i = 0; i < nt; i++) order[i] = i;
    const nodes = []; // {min:[3],max:[3],l,r,start,count}
    const cent = [cx, cy, cz];
    function rec(start, end) {
      const n = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], l: -1, r: -1, start, count: end - start };
      for (let i = start; i < end; i++) {
        const t = order[i];
        for (let a = 0; a < 3; a++) {
          if (bmin[t * 3 + a] < n.min[a]) n.min[a] = bmin[t * 3 + a];
          if (bmax[t * 3 + a] > n.max[a]) n.max[a] = bmax[t * 3 + a];
        }
      }
      const id = nodes.length; nodes.push(n);
      if (end - start <= 8) return id;
      let ax = 0, ext = -1;
      for (let a = 0; a < 3; a++) { const e = n.max[a] - n.min[a]; if (e > ext) { ext = e; ax = a; } }
      const c = cent[ax];
      const sub = Array.from(order.subarray(start, end)).sort((p, q) => c[p] - c[q]);
      for (let i = 0; i < sub.length; i++) order[start + i] = sub[i];
      const mid = (start + end) >> 1;
      n.l = rec(start, mid); n.r = rec(mid, end); n.count = 0;
      return id;
    }
    if (nt) rec(0, nt);
    return { nodes, order, pos, idx };
  }

  // Ray vs AABB (slab), returns entry t or Infinity
  function rayBox(o, invd, mn, mx, tmax) {
    let t0 = 0, t1 = tmax;
    for (let a = 0; a < 3; a++) {
      let ta = (mn[a] - o[a]) * invd[a], tb = (mx[a] - o[a]) * invd[a];
      if (ta > tb) { const s = ta; ta = tb; tb = s; }
      if (ta > t0) t0 = ta; if (tb < t1) t1 = tb;
      if (t0 > t1) return false;
    }
    return true;
  }

  // Moeller-Trumbore, beidseitig
  function rayTri(o, d, pos, i0, i1, i2) {
    const ax = pos[i0], ay = pos[i0 + 1], az = pos[i0 + 2];
    const e1x = pos[i1] - ax, e1y = pos[i1 + 1] - ay, e1z = pos[i1 + 2] - az;
    const e2x = pos[i2] - ax, e2y = pos[i2 + 1] - ay, e2z = pos[i2 + 2] - az;
    const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det > -1e-12 && det < 1e-12) return Infinity;
    const inv = 1 / det;
    const tx = o[0] - ax, ty = o[1] - ay, tz = o[2] - az;
    const u = (tx * px + ty * py + tz * pz) * inv; if (u < 0 || u > 1) return Infinity;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv; if (v < 0 || u + v > 1) return Infinity;
    return (e2x * qx + e2y * qy + e2z * qz) * inv;
  }

  // Strahltest: liefert 0 = frei, 1 = blockiert, 2 = Ursprung liegt in B (Durchdringung -> ignorieren)
  function rayTest(bvh, o, d, tol, tmax) {
    if (!bvh.nodes.length) return 0;
    const invd = [1 / d[0], 1 / d[1], 1 / d[2]];
    const stack = [0];
    const { nodes, order, pos, idx } = bvh;
    let cnt = 0, blocked = false;
    const ts = [];
    while (stack.length) {
      const n = nodes[stack.pop()];
      if (!rayBox(o, invd, n.min, n.max, 1e7)) continue;
      if (n.l < 0) {
        for (let i = n.start; i < n.start + n.count; i++) {
          const t = order[i];
          const h = rayTri(o, d, pos, idx[t * 3] * 3, idx[t * 3 + 1] * 3, idx[t * 3 + 2] * 3);
          if (h > 1e-5 && h < 1e7) ts.push(h);
        }
      } else { stack.push(n.l, n.r); }
    }
    if (!ts.length) return 0;
    // doppelte Treffer an Dreieckskanten zusammenfassen
    ts.sort((a, b) => a - b);
    let prev = -1;
    for (const h of ts) { if (h - prev > 1e-4) { cnt++; if (h > tol && h < tmax) blocked = true; } prev = h; }
    if (cnt % 2 === 1) return 2;
    return blocked ? 1 : 0;
  }

  function rayHits(bvh, o, d, tmin, tmax) { return rayTest(bvh, o, d, tmin, tmax) === 1; }

  // ---------------- Teile vorbereiten ----------------
  const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

  function preparePart(p, maxSamples) {
    const pos = p.pos, nrm = p.nrm, nv = pos.length / 3;
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < nv; i++) for (let a = 0; a < 3; a++) {
      const v = pos[i * 3 + a]; if (v < mn[a]) mn[a] = v; if (v > mx[a]) mx[a] = v;
    }
    // Stichproben: alle Vertices dedupliziert auf 0.2mm-Raster, dann ausgeduennt
    const seen = new Map(); const cand = [];
    for (let i = 0; i < nv; i++) {
      const k = Math.round(pos[i * 3] * 5) + ',' + Math.round(pos[i * 3 + 1] * 5) + ',' + Math.round(pos[i * 3 + 2] * 5);
      if (!seen.has(k)) { seen.set(k, cand.length); cand.push([i]); } else cand[seen.get(k)].push(i);
    }
    const step = Math.max(1, Math.ceil(cand.length / maxSamples));
    const samples = [];
    for (let c = 0; c < cand.length; c += step) {
      // pro Position alle Normalen (Kanten haben mehrere) -> gemittelte Normale
      let nx = 0, ny = 0, nz = 0; const g = cand[c];
      for (const i of g) { nx += nrm[i * 3]; ny += nrm[i * 3 + 1]; nz += nrm[i * 3 + 2]; }
      const l = Math.hypot(nx, ny, nz) || 1; const i0 = g[0];
      samples.push([pos[i0 * 3], pos[i0 * 3 + 1], pos[i0 * 3 + 2], nx / l, ny / l, nz / l]);
    }
    const vol = (mx[0] - mn[0]) * (mx[1] - mn[1]) * (mx[2] - mn[2]);
    return { min: mn, max: mx, vol, samples, bvh: buildBVH(pos, p.idx) };
  }

  // Ist A in Richtung d durch B blockiert?
  function blockedBy(A, B, d, opt) {
    const eps = opt.eps, tol = opt.tol;
    // Swept-Box-Vorfilter: B muss in der Projektion ueberlappen und vor A liegen
    for (let a = 0; a < 3; a++) {
      if (d[a] === 0) { if (B.max[a] < A.min[a] - tol || B.min[a] > A.max[a] + tol) return false; }
      else if (d[a] > 0) { if (B.max[a] < A.min[a]) return false; }
      else { if (B.min[a] > A.max[a]) return false; }
    }
    const need = Math.max(opt.minHits, Math.ceil(opt.hitFrac * Math.min(A.samples.length, B.samples.length)));
    let hits = 0; const o = [0, 0, 0];
    const BIG = opt.maxDist || 1e7;
    // Strahlen von A in Richtung d gegen B
    for (const s of A.samples) {
      o[0] = s[0] - s[3] * eps; o[1] = s[1] - s[4] * eps; o[2] = s[2] - s[5] * eps;
      if (rayTest(B.bvh, o, d, tol, BIG) === 1) { if (++hits >= need) return true; }
    }
    // Strahlen von B in Richtung -d gegen A
    const nd = [-d[0], -d[1], -d[2]];
    for (const s of B.samples) {
      o[0] = s[0] - s[3] * eps; o[1] = s[1] - s[4] * eps; o[2] = s[2] - s[5] * eps;
      if (rayTest(A.bvh, o, nd, tol, BIG) === 1) { if (++hits >= need) return true; }
    }
    return false;
  }

  // ---------------- Kontakt (Abstand Punkt-Flaeche) ----------------
  function closestPtTri(p, a, b, c) {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]], ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    const d1 = dot(ab, ap), d2 = dot(ac, ap);
    if (d1 <= 0 && d2 <= 0) return a;
    const bp = [p[0] - b[0], p[1] - b[1], p[2] - b[2]]; const d3 = dot(ab, bp), d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) return b;
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return [a[0] + v * ab[0], a[1] + v * ab[1], a[2] + v * ab[2]]; }
    const cp = [p[0] - c[0], p[1] - c[1], p[2] - c[2]]; const d5 = dot(ab, cp), d6 = dot(ac, cp);
    if (d6 >= 0 && d5 <= d6) return c;
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return [a[0] + w * ac[0], a[1] + w * ac[1], a[2] + w * ac[2]]; }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return [b[0] + w * (c[0] - b[0]), b[1] + w * (c[1] - b[1]), b[2] + w * (c[2] - b[2])]; }
    const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
    return [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
  }
  // true, wenn Punkt p naeher als r an der Flaeche liegt
  function nearSurface(bvh, p, r) {
    if (!bvh.nodes.length) return false;
    const { nodes, order, pos, idx } = bvh; const r2 = r * r; const stack = [0];
    while (stack.length) {
      const n = nodes[stack.pop()];
      let d2 = 0;
      for (let a = 0; a < 3; a++) { const v = p[a] < n.min[a] ? n.min[a] - p[a] : (p[a] > n.max[a] ? p[a] - n.max[a] : 0); d2 += v * v; }
      if (d2 > r2) continue;
      if (n.l < 0) {
        for (let i = n.start; i < n.start + n.count; i++) {
          const t = order[i], i0 = idx[t * 3] * 3, i1 = idx[t * 3 + 1] * 3, i2 = idx[t * 3 + 2] * 3;
          const q = closestPtTri(p, [pos[i0], pos[i0 + 1], pos[i0 + 2]], [pos[i1], pos[i1 + 1], pos[i1 + 2]], [pos[i2], pos[i2 + 1], pos[i2 + 2]]);
          const dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2];
          if (dx * dx + dy * dy + dz * dz <= r2) return true;
        }
      } else stack.push(n.l, n.r);
    }
    return false;
  }
  // Kontakt: Stichprobe von A nahe an B (oder in B), bzw. umgekehrt
  function inContact(A, B, r) {
    if (!touching(A, B, r)) return false;
    const test = (X, Y) => {
      const n = X.samples.length, step = Math.max(1, Math.floor(n / 400));
      for (let i = 0; i < n; i += step) {
        const s = X.samples[i];
        if (s[0] < Y.min[0] - r || s[0] > Y.max[0] + r || s[1] < Y.min[1] - r || s[1] > Y.max[1] + r || s[2] < Y.min[2] - r || s[2] > Y.max[2] + r) continue;
        if (nearSurface(Y.bvh, s, r)) return true;
        if (rayTest(Y.bvh, s, [0.5773, 0.5774, 0.5775], 0, 1e7) === 2) return true;
      }
      return false;
    };
    return test(A, B) || test(B, A);
  }

  // ---------------- Montagereihenfolge ----------------
  // units: [{id, group, label, fastener, prep}]
  // Ergebnis: steps (Montage-Reihenfolge), je {parts, removeDir, base?, sub? (Vormontage)}
  function computeSequence(units, opt, onProgress) {
    opt = Object.assign({ eps: 0.5, tol: 0.5, minHits: 3, hitFrac: 0.015, hitFracElastic: 0.06, upAxis: 'z' }, opt || {});
    const optE = Object.assign({}, opt, { hitFrac: opt.hitFracElastic });
    const byId = new Map(units.map(u => [u.id, u]));
    const core = units.filter(u => !u.fastener);
    const fast = units.filter(u => u.fastener);
    const remaining = new Set(core.map(u => u.id));
    const cache = new Map();
    const blk = (a, b, di) => {
      const k = a + '|' + b + '|' + di;
      if (!cache.has(k)) {
        const A = byId.get(a), B = byId.get(b);
        cache.set(k, blockedBy(A.prep, B.prep, DIRS[di], (A.elastic || B.elastic) ? optE : opt));
      }
      return cache.get(k);
    };
    const blockers = (a, di, ignore) => {
      const res = [];
      for (const b of remaining) if (b !== a && !(ignore && ignore.has(b)) && blk(a, b, di)) res.push(b);
      return res;
    };
    const tcache = new Map();
    const touch = (a, b) => {
      const k = a < b ? a + '|' + b : b + '|' + a;
      if (!tcache.has(k)) tcache.set(k, inContact(byId.get(a).prep, byId.get(b).prep, 1.0));
      return tcache.get(k);
    };
    // Richtung waehlen: bevorzugt weg von der Auflage (Gegenrichtung durch beruehrendes Teil blockiert)
    const chooseDir = (a, list) => {
      const sup = list.filter(di => blockers(a, di ^ 1).some(b => touch(a, b)));
      return pickDir(sup.length ? sup : list, opt.upAxis);
    };
    // Eingeklemmte Teile (auf beiden Seiten einer Achse beruehrt und blockiert) duerfen nicht seitlich herausgleiten
    const freeDirs = (a, ignore) => {
      const bl = []; for (let di = 0; di < 6; di++) bl.push(blockers(a, di, ignore));
      const clampedAx = [0, 1, 2].filter(ax => bl[ax * 2].some(b => touch(a, b) && bl[ax * 2 + 1].some(c => c !== b && touch(a, c))));
      const r = [];
      for (let di = 0; di < 6; di++) {
        if (bl[di].length) continue;
        const ax = di >> 1;
        if (clampedAx.some(c => c !== ax)) continue;
        r.push(di);
      }
      return r;
    };

    const dis = []; const warnings = [];
    let last = [];
    const total = core.length; let done = 0;
    while (remaining.size > 1) {
      const ids = [...remaining];
      const biggest = ids.reduce((p, q) => byId.get(p).prep.vol >= byId.get(q).prep.vol ? p : q);
      const free = new Map();
      for (const a of ids) { if (a === biggest) continue; const f = freeDirs(a); if (f.length) free.set(a, f); }
      let chosen = null, sub = false;
      if (free.size) {
        const near = a => last.some(l => touch(a, l)) ? 0 : 1;
        const cands = [...free.keys()].sort((p, q) => (near(p) - near(q)) || (byId.get(p).prep.vol - byId.get(q).prep.vol));
        const first = byId.get(cands[0]);
        const dir = chooseDir(cands[0], free.get(cands[0]));
        chosen = cands.filter(a => byId.get(a).group === first.group && free.get(a).includes(dir)).map(a => [a, dir]);
      } else {
        // Verklemmung: Paar suchen, das sich nur gegenseitig blockiert -> Vormontage
        let best = null;
        for (const a of ids) for (const b of ids) {
          if (a >= b || a === biggest || b === biggest || !touch(a, b)) continue;
          const ig = new Set([a, b]);
          const fa = freeDirs(a, ig), fb = freeDirs(b, ig);
          const common = fa.filter(d => fb.includes(d));
          if (common.length) {
            const v = byId.get(a).prep.vol + byId.get(b).prep.vol;
            if (!best || v < best.v) best = { a, b, d: chooseDir(a, common), v };
          }
        }
        if (best) { chosen = [[best.a, best.d], [best.b, best.d]]; sub = true; }
        else {
          const a = ids.filter(x => x !== biggest).sort((p, q) => byId.get(p).prep.vol - byId.get(q).prep.vol)[0];
          warnings.push('Keine kollisionsfreie Richtung für „' + byId.get(a).label + '“ gefunden – Reihenfolge bitte prüfen.');
          chosen = [[a, -1]];
        }
      }
      dis.push({ items: chosen, sub });
      last = chosen.map(c => c[0]);
      for (const [a] of chosen) remaining.delete(a);
      done += chosen.length; if (onProgress) onProgress(done / total);
    }
    const base = [...remaining];
    const steps = [{ parts: base, removeDir: -1, base: true }];
    for (let i = dis.length - 1; i >= 0; i--) {
      steps.push({ parts: dis[i].items.map(x => x[0]), removeDir: dis[i].items[0][1], sub: dis[i].sub });
    }

    // Verbindungselemente nach dem letzten beruehrten Teil einfuegen
    const stepOf = new Map(); steps.forEach((s, i) => s.parts.forEach(p => stepOf.set(p, i)));
    const inserts = new Map(); // stepIndex -> Map(group+dir -> [ids])
    for (const f of fast) {
      let at = 0;
      for (const c of core) if (touch(f.id, c.id)) at = Math.max(at, stepOf.get(c.id));
      f.contacts = core.filter(c => touch(f.id, c.id)).map(c => c.id);
      const dir = fastenerDir(f.prep, byId, core, f, Object.assign({}, opt, { _stepDir: steps[at].removeDir }), stepOf, at);
      const key = f.group + '|' + dir;
      if (!inserts.has(at)) inserts.set(at, new Map());
      const m = inserts.get(at); if (!m.has(key)) m.set(key, []); m.get(key).push(f.id);
    }
    const out = [];
    steps.forEach((s, i) => {
      out.push(s);
      if (inserts.has(i)) for (const [key, ids] of inserts.get(i)) out.push({ parts: ids, removeDir: +key.split('|')[1], fastener: true });
    });
    return { steps: out, warnings, dirs: DIRS };
  }

  // Richtung eines Verbindungselements: Schrauben entlang der Laengsachse Richtung Kopf
  function fastenerDir(P, byId, core, f, opt, stepOf, at) {
    const ext = [0, 1, 2].map(a => P.max[a] - P.min[a]);
    const sorted = [0, 1, 2].sort((a, b) => ext[b] - ext[a]);
    const isScrew = /schraube|bolzen|stift|niet/i.test(f.label);
    if (isScrew && ext[sorted[0]] > 1.3 * ext[sorted[1]]) {
      const ax = sorted[0];
      const o1 = (ax + 1) % 3, o2 = (ax + 2) % 3;
      const c1 = (P.min[o1] + P.max[o1]) / 2, c2 = (P.min[o2] + P.max[o2]) / 2;
      const len = ext[ax];
      let rLo = 0, rHi = 0;
      for (const s of P.samples) {
        const r = Math.hypot(s[o1] - c1, s[o2] - c2);
        if (s[ax] < P.min[ax] + 0.2 * len) rLo = Math.max(rLo, r);
        else if (s[ax] > P.max[ax] - 0.2 * len) rHi = Math.max(rHi, r);
      }
      const posDir = rHi >= rLo; // Kopf am positiven Ende -> Demontage in +ax
      return ax * 2 + (posDir ? 0 : 1);
    }
    // sonst: freie Richtung gegen bereits montierte Teile (begrenzte Distanz), bevorzugt kleinste Ausdehnung
    const placed = core.filter(c => stepOf.get(c.id) <= at).map(c => c.prep);
    const o2 = Object.assign({}, opt, { maxDist: Math.max(...ext) * 2 });
    let pref = [sorted[2] * 2, sorted[2] * 2 + 1, sorted[1] * 2, sorted[1] * 2 + 1, sorted[0] * 2, sorted[0] * 2 + 1];
    if (opt._stepDir >= 0 && (opt._stepDir >> 1) === sorted[2]) return opt._stepDir;
    for (const di of pref) if (!placed.some(B => blockedBy(P, B, DIRS[di], o2))) return di;
    return sorted[2] * 2;
  }

  // Bevorzugt "von oben", dann horizontale Richtungen, zuletzt von unten
  function pickDir(list, upAxis) {
    const up = upAxis === 'y' ? 2 : 4; // Index von +Up in DIRS
    const down = up + 1;
    const pref = [up].concat([0, 1, 2, 3, 4, 5].filter(d => d !== up && d !== down), [down]);
    for (const d of pref) if (list.includes(d)) return d;
    return list[0];
  }

  // Kontaktnachbarn (Box-Ueberlappung mit Toleranz)
  function touching(A, B, tol) {
    for (let a = 0; a < 3; a++) if (A.max[a] < B.min[a] - tol || A.min[a] > B.max[a] + tol) return false;
    return true;
  }

  const api = { inContact, buildBVH, rayHits, rayTest, preparePart, blockedBy, computeSequence, touching, DIRS, pickDir };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.AsmCore = api;
})(typeof self !== 'undefined' ? self : this);

// ---------------- Worker-Schnittstelle ----------------
(function (root) {
  'use strict';
  const C = root.AsmCore;
  let occtPromise = null, parts = null, preps = null;

  function getOcct(base) {
    if (!occtPromise) {
      if (typeof root.occtimportjs !== 'function') {
        if (typeof importScripts === 'function') importScripts(base + 'occt-import-js.js');
      }
      occtPromise = root.occtimportjs({ locateFile: (n) => base + n });
    }
    return occtPromise;
  }

  async function handle(msg, post) {
    if (msg.type === 'parse') {
      post({ type: 'progress', phase: 'wasm', value: 0 });
      const occt = await getOcct(msg.base || '');
      post({ type: 'progress', phase: 'read', value: 0 });
      const res = occt.ReadStepFile(new Uint8Array(msg.buffer), {
        linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio',
        linearDeflection: 0.001, angularDeflection: 0.2
      });
      if (!res || !res.success) throw new Error('Die STEP-Datei konnte nicht gelesen werden.');
      parts = []; preps = null;
      const walk = (n, path) => {
        const here = n.name ? path.concat(n.name) : path;
        if (n.meshes && n.meshes.length) {
          let nv = 0, ni = 0;
          for (const mi of n.meshes) { const m = res.meshes[mi]; nv += m.attributes.position.array.length; ni += m.index.array.length; }
          const pos = new Float32Array(nv), nrm = new Float32Array(nv), idx = new Uint32Array(ni);
          let vo = 0, io = 0; let color = null;
          for (const mi of n.meshes) {
            const m = res.meshes[mi]; const p = m.attributes.position.array;
            const nn = m.attributes.normal ? m.attributes.normal.array : null;
            pos.set(p, vo); if (nn) nrm.set(nn, vo);
            const base = vo / 3; const ix = m.index.array;
            for (let k = 0; k < ix.length; k++) idx[io + k] = ix[k] + base;
            vo += p.length; io += ix.length;
            if (!color && m.color) color = m.color;
          }
          parts.push({ id: parts.length, name: n.name || ('Teil ' + (parts.length + 1)), path: here.slice(0, -1), color, pos, nrm, idx });
        }
        (n.children || []).forEach(c => walk(c, here));
      };
      walk(res.root, []);
      const rootName = res.root && (res.root.name || (res.root.children && res.root.children.length === 1 ? res.root.children[0].name : '')) || '';
      // Kopien senden, Originale fuer die Analyse behalten
      const out = parts.map(p => ({ id: p.id, name: p.name, path: p.path, color: p.color, pos: p.pos.slice(), nrm: p.nrm.slice(), idx: p.idx.slice() }));
      const transfer = [];
      out.forEach(p => transfer.push(p.pos.buffer, p.nrm.buffer, p.idx.buffer));
      return { result: { parts: out, rootName }, transfer };
    }
    if (msg.type === 'sequence') {
      if (!parts) throw new Error('Keine Geometrie geladen.');
      if (!preps) {
        preps = [];
        for (let i = 0; i < parts.length; i++) {
          preps.push(C.preparePart(parts[i], 1500));
          if (i % 3 === 0) post({ type: 'progress', phase: 'prep', value: i / parts.length });
        }
      }
      const units = msg.units.map(u => Object.assign({}, u, { prep: preps[u.id] }));
      post({ type: 'progress', phase: 'seq', value: 0 });
      const seq = C.computeSequence(units, { upAxis: msg.upAxis || 'z' }, v => post({ type: 'progress', phase: 'seq', value: v }));
      // Kontakte fuer Textbausteine (welches Teil an welchem)
      const contacts = [];
      for (let a = 0; a < units.length; a++) for (let b = a + 1; b < units.length; b++) {
        const A = units[a].prep, B = units[b].prep;
        if (C.touching(A, B, 1.0) && C.inContact(A, B, 1.0)) contacts.push([units[a].id, units[b].id]);
      }
      const boxes = preps.map(p => ({ min: p.min, max: p.max, vol: p.vol }));
      return { result: { steps: seq.steps, warnings: seq.warnings, contacts, boxes } };
    }
    throw new Error('Unbekannte Anfrage');
  }

  root.AsmWorker = { handle };

  if (typeof WorkerGlobalScope !== 'undefined' && root instanceof WorkerGlobalScope) {
    root.onmessage = async (e) => {
      const msg = e.data;
      try {
        const { result, transfer } = await handle(msg, (m) => root.postMessage(Object.assign({ id: msg.id }, m)));
        root.postMessage({ id: msg.id, type: 'done', result }, transfer || []);
      } catch (err) {
        root.postMessage({ id: msg.id, type: 'error', message: String(err && err.message || err) });
      }
    };
  }
})(typeof self !== 'undefined' ? self : this);
