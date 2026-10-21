/* Foto markieren: Pfeil, Kreis, Rahmen, Stift, Nummern. Markierungen bleiben bearbeitbar. */
'use strict';

const Annotator = (() => {
  const COLORS = ['#e3001b', '#ffd400', '#00a650'];
  function loadImg(blob) {
    return new Promise((res, rej) => { const u = URL.createObjectURL(blob); const i = new Image(); i.onload = () => res({ img: i, url: u }); i.onerror = rej; i.src = u; });
  }

  function drawShapes(ctx, shapes, W, H) {
    const base = Math.max(W, H);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    shapes.forEach(s => {
      const lw = base * 0.007;
      ctx.strokeStyle = s.c; ctx.fillStyle = s.c; ctx.lineWidth = lw;
      const P = s.pts.map(([x, y]) => [x * W, y * H]);
      // dunkler Rand für Kontrast
      const halo = () => { ctx.save(); ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.lineWidth = lw * 1.9; ctx.stroke(); ctx.restore(); ctx.stroke(); };
      if (s.t === 'pen' && P.length > 1) {
        ctx.beginPath(); ctx.moveTo(...P[0]); P.slice(1).forEach(p => ctx.lineTo(...p)); halo();
      } else if (s.t === 'rect' && P.length > 1) {
        const [a, b] = [P[0], P[P.length - 1]];
        ctx.beginPath(); ctx.rect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])); halo();
      } else if (s.t === 'circle' && P.length > 1) {
        const [a, b] = [P[0], P[P.length - 1]];
        ctx.beginPath(); ctx.ellipse((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.abs(b[0] - a[0]) / 2 || 1, Math.abs(b[1] - a[1]) / 2 || 1, 0, 0, Math.PI * 2); halo();
      } else if (s.t === 'arrow' && P.length > 1) {
        const [a, b] = [P[0], P[P.length - 1]];
        const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), hl = lw * 4.5;
        ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(b[0] - Math.cos(ang) * hl * 0.6, b[1] - Math.sin(ang) * hl * 0.6); halo();
        ctx.beginPath(); ctx.moveTo(...b);
        ctx.lineTo(b[0] - hl * Math.cos(ang - 0.45), b[1] - hl * Math.sin(ang - 0.45));
        ctx.lineTo(b[0] - hl * Math.cos(ang + 0.45), b[1] - hl * Math.sin(ang + 0.45)); ctx.closePath();
        ctx.save(); ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.lineWidth = lw * 0.9; ctx.stroke(); ctx.restore(); ctx.fill();
      } else if (s.t === 'num') {
        const r = base * 0.028, [x, y] = P[0];
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
        ctx.lineWidth = r * 0.16; ctx.strokeStyle = '#fff'; ctx.stroke();
        ctx.fillStyle = s.c === '#ffd400' ? '#000' : '#fff';
        ctx.font = `700 ${r * 1.25}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(s.n), x, y + r * 0.05);
      }
    });
  }

  async function render(blob, shapes) {
    const { img, url } = await loadImg(blob);
    const cv = document.createElement('canvas'); cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    const ctx = cv.getContext('2d'); ctx.drawImage(img, 0, 0); drawShapes(ctx, shapes, cv.width, cv.height);
    URL.revokeObjectURL(url);
    return new Promise(res => cv.toBlob(res, 'image/jpeg', 0.88));
  }

  function open(origBlob, marks) {
    return new Promise(async (resolve) => {
      const { img, url } = await loadImg(origBlob);
      let shapes = (marks || []).map(s => ({ ...s, pts: s.pts.map(p => [...p]) }));
      let tool = 'arrow', color = COLORS[0], cur = null;

      const ov = document.createElement('div');
      ov.className = 'ann';
      ov.innerHTML = `
        <div class="ann-top"><button class="btn ghost light" data-a="cancel">Abbrechen</button><b>Foto markieren</b><button class="btn primary" data-a="save">Übernehmen</button></div>
        <div class="ann-stage"><canvas></canvas></div>
        <div class="ann-tools">
          <div class="seg">
            ${[['arrow', '↗', 'Pfeil'], ['circle', '◯', 'Kreis'], ['rect', '▢', 'Rahmen'], ['num', '①', 'Nummer'], ['pen', '✎', 'Stift']]
              .map(([k, i, l]) => `<button data-t="${k}" class="${k === tool ? 'on' : ''}" aria-label="${l}"><span>${i}</span><small>${l}</small></button>`).join('')}
          </div>
          <div class="ann-row">
            ${COLORS.map(c => `<button class="dot ${c === color ? 'on' : ''}" data-c="${c}" style="--dot:${c}" aria-label="Farbe"></button>`).join('')}
            <span class="grow"></span>
            <button class="btn ghost light" data-a="undo">↶ Zurück</button>
            <button class="btn ghost light" data-a="clear">Alle löschen</button>
          </div>
        </div>`;
      document.body.appendChild(ov);
      const cv = ov.querySelector('canvas'), stage = ov.querySelector('.ann-stage');
      const ctx = cv.getContext('2d');
      let dw = 0, dh = 0;

      function fit() {
        const r = stage.getBoundingClientRect();
        const ar = img.naturalWidth / img.naturalHeight;
        dw = r.width; dh = dw / ar; if (dh > r.height) { dh = r.height; dw = dh * ar; }
        const dpr = window.devicePixelRatio || 1;
        cv.style.width = dw + 'px'; cv.style.height = dh + 'px';
        cv.width = Math.round(dw * dpr); cv.height = Math.round(dh * dpr);
        paint();
      }
      function paint() {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(img, 0, 0, cv.width, cv.height);
        drawShapes(ctx, cur ? shapes.concat([cur]) : shapes, cv.width, cv.height);
      }
      function pos(e) { const r = cv.getBoundingClientRect(); return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))]; }

      cv.addEventListener('pointerdown', e => {
        e.preventDefault(); cv.setPointerCapture(e.pointerId);
        const p = pos(e);
        if (tool === 'num') {
          const n = shapes.filter(s => s.t === 'num').reduce((m, s) => Math.max(m, s.n), 0) + 1;
          shapes.push({ t: 'num', c: color, pts: [p], n }); paint(); return;
        }
        cur = { t: tool, c: color, pts: [p, p] };
      });
      cv.addEventListener('pointermove', e => {
        if (!cur) return; const p = pos(e);
        if (cur.t === 'pen') cur.pts.push(p); else cur.pts[1] = p;
        paint();
      });
      const end = () => {
        if (!cur) return;
        const [a, b] = [cur.pts[0], cur.pts[cur.pts.length - 1]];
        if (cur.t === 'pen' ? cur.pts.length > 2 : Math.hypot(b[0] - a[0], b[1] - a[1]) > 0.015) shapes.push(cur);
        cur = null; paint();
      };
      cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);

      ov.addEventListener('click', async e => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.t) { tool = b.dataset.t; ov.querySelectorAll('[data-t]').forEach(x => x.classList.toggle('on', x === b)); }
        if (b.dataset.c) { color = b.dataset.c; ov.querySelectorAll('[data-c]').forEach(x => x.classList.toggle('on', x === b)); }
        const a = b.dataset.a;
        if (a === 'undo') { shapes.pop(); paint(); }
        if (a === 'clear') { shapes = []; paint(); }
        if (a === 'cancel') close(null);
        if (a === 'save') { b.disabled = true; b.textContent = 'Speichere…'; close({ marks: shapes, blob: shapes.length ? await render(origBlob, shapes) : origBlob }); }
      });
      function close(v) { window.removeEventListener('resize', fit); URL.revokeObjectURL(url); ov.remove(); resolve(v); }
      window.addEventListener('resize', fit);
      requestAnimationFrame(fit);
    });
  }

  return { open, render };
})();

window.Annotator = Annotator;
