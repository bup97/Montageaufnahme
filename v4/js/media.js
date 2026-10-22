/* Barcode-/QR-Scanner (ZXing, fest auf Version gepinnt) und Webcam-Aufnahme am PC. */
'use strict';

const Media = (() => {
  const ZXING = 'https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js';
  let zxingLoading = null;
  function loadZXing() {
    if (window.ZXing) return Promise.resolve();
    if (!zxingLoading) zxingLoading = new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = ZXING; s.onload = res;
      s.onerror = () => { zxingLoading = null; rej(new Error('Scanner konnte nicht geladen werden (offline?). Artikelnummer bitte eintippen.')); };
      document.head.appendChild(s);
    });
    return zxingLoading;
  }

  function pickBack(devices) {
    const pats = [/back ultra wide|ultraweitwinkel/i, /back wide|weitwinkel/i, /back camera$|rückkamera$/i, /back|rear|environment|rück|haupt/i];
    for (const p of pats) { const d = devices.find(x => p.test(x.label)); if (d) return d.deviceId; }
    return devices.length ? devices[devices.length - 1].deviceId : undefined;
  }

  function modal(title, body) {
    const ov = document.createElement('div');
    ov.className = 'sheet-back cam';
    ov.innerHTML = `<div class="cam-box"><div class="cam-head"><b>${title}</b><button class="btn ghost light" data-x>Schließen</button></div>${body}</div>`;
    document.body.appendChild(ov);
    return ov;
  }

  /* Kamera für den Scanner: die normale Hauptkamera (1×).
     Virtuelle Mehrfach-Kameras (Dual/Triple) springen auf dem iPhone bei kurzem Abstand
     selbstständig in den Ultraweitwinkel – die werden darum gemieden. */
  const SCAN_MAIN = /^(back camera|rear camera|rückseitige kamera|rückkamera|kamera auf der rückseite)$/i;
  const SCAN_BACK = /back|rear|environment|rück|haupt|facing back/i;
  const SCAN_AVOID = /ultra|dual|triple|tele|weitwinkel|wide|makro|macro|depth|tiefe/i;
  function pickScanCam(devs) {
    let saved = null; try { saved = localStorage.getItem('fw4.scanCam'); } catch (e) {}
    return (saved && devs.find(d => d.label === saved)) ||
      devs.find(d => SCAN_MAIN.test(d.label.trim())) ||
      devs.find(d => SCAN_BACK.test(d.label) && !SCAN_AVOID.test(d.label)) ||
      devs.find(d => SCAN_BACK.test(d.label)) || devs[devs.length - 1] || null;
  }
  const videoInputs = async () => (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
  const RES = { width: { ideal: 1920 }, height: { ideal: 1080 } };

  /* Scannt einen Code und liefert den Text (oder null bei Abbruch) */
  function scan() {
    return new Promise(async (resolve) => {
      const ov = modal('Code scannen', `
        <div class="cam-view"><video playsinline muted></video><div class="scan-frame"></div></div>
        <p class="cam-msg">Kamera wird gestartet…</p>
        <div class="cam-actions"><button class="btn ghost light" data-switch hidden>Kamera wechseln</button></div>`);
      const video = ov.querySelector('video'), msg = ov.querySelector('.cam-msg');
      let reader = null, stream = null, finished = false, cams = [], cur = null;
      const stopStream = () => { if (stream) stream.getTracks().forEach(t => t.stop()); stream = null; };
      const finish = (v) => { if (finished) return; finished = true; try { reader && reader.reset(); } catch (e) {} stopStream(); ov.remove(); resolve(v); };
      ov.querySelector('[data-x]').onclick = () => finish(null);

      async function open(constraints) {
        stopStream();
        stream = await navigator.mediaDevices.getUserMedia({ video: constraints, audio: false });
        const track = stream.getVideoTracks()[0];
        try {
          const cap = track.getCapabilities ? track.getCapabilities() : {};
          const adv = [];
          if (cap.focusMode && cap.focusMode.includes('continuous')) adv.push({ focusMode: 'continuous' });
          // Zoom auf 1× – nicht auf das Minimum (das wäre bei Mehrfach-Kameras 0,5× = Weitwinkel)
          if (cap.zoom && cap.zoom.min <= 1 && cap.zoom.max >= 1) adv.push({ zoom: 1 });
          if (adv.length) await track.applyConstraints({ advanced: adv });
        } catch (e) {}
        return track;
      }
      async function decode() {
        try { reader.reset(); } catch (e) {}
        if (finished) return stopStream();
        reader.decodeFromStream(stream, video, (res) => {
          if (res && !finished) { if (navigator.vibrate) navigator.vibrate(80); finish(res.getText()); }
        }).catch(() => {});
      }

      try {
        await loadZXing();
        reader = new ZXing.BrowserMultiFormatReader();
        // 1. Rückkamera öffnen (holt die Erlaubnis, danach sind die Kameranamen lesbar)
        let track = await open({ facingMode: { ideal: 'environment' }, ...RES });
        // 2. Hauptkamera suchen und ggf. umschalten
        cams = await videoInputs();
        cur = pickScanCam(cams);
        const active = track.getSettings ? track.getSettings().deviceId : null;
        if (cur && cur.deviceId && cur.deviceId !== active) track = await open({ deviceId: { exact: cur.deviceId }, ...RES });
        else if (!cur) cur = cams.find(d => d.deviceId === active) || null;
        await decode();
        msg.textContent = 'Code mittig in den Rahmen halten (ca. 15–25 cm Abstand)';
        const back = cams.filter(d => SCAN_BACK.test(d.label));
        const list = back.length > 1 ? back : cams;
        if (list.length > 1) {
          const sw = ov.querySelector('[data-switch]'); sw.hidden = false;
          sw.onclick = async () => {
            const i = list.findIndex(d => cur && d.deviceId === cur.deviceId);
            cur = list[(i + 1) % list.length];
            try { localStorage.setItem('fw4.scanCam', cur.label); } catch (e) {}
            try { await open({ deviceId: { exact: cur.deviceId }, ...RES }); await decode(); msg.textContent = cur.label || 'Kamera gewechselt'; }
            catch (e) { msg.textContent = 'Diese Kamera lässt sich nicht öffnen.'; }
          };
        }
      } catch (e) {
        msg.textContent = e.name === 'NotAllowedError' ? 'Kamerazugriff wurde verweigert. In den Einstellungen erlauben.' : (e.message || 'Kamera nicht verfügbar.');
        msg.classList.add('err');
      }
    });
  }

  /* Webcam am PC: liefert Blobs (mehrere Aufnahmen möglich) */
  function webcam(onShot) {
    return new Promise(async (resolve) => {
      const ov = modal('Webcam', `
        <div class="cam-view"><video playsinline muted autoplay></video></div>
        <p class="cam-msg">Kamera wird gestartet…</p>
        <div class="cam-actions"><button class="shutter" data-shot aria-label="Foto aufnehmen" disabled></button></div>`);
      const video = ov.querySelector('video'), msg = ov.querySelector('.cam-msg');
      let stream = null, count = 0;
      const close = () => { stream && stream.getTracks().forEach(t => t.stop()); ov.remove(); resolve(count); };
      ov.querySelector('[data-x]').onclick = close;
      try {
        const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
        const id = pickBack(devs);
        stream = await navigator.mediaDevices.getUserMedia({ video: id ? { deviceId: { ideal: id }, width: { ideal: 1920 }, height: { ideal: 1080 } } : { facingMode: 'environment', width: { ideal: 1920 } } });
        video.srcObject = stream; await video.play();
        msg.textContent = 'Auslöser tippen – mehrere Fotos möglich';
        const btn = ov.querySelector('[data-shot]'); btn.disabled = false;
        btn.onclick = () => {
          const cv = document.createElement('canvas'); cv.width = video.videoWidth; cv.height = video.videoHeight;
          cv.getContext('2d').drawImage(video, 0, 0);
          ov.querySelector('.cam-view').animate([{ opacity: .2 }, { opacity: 1 }], 220);
          cv.toBlob(b => { count++; onShot(b); msg.textContent = `${count} Foto${count > 1 ? 's' : ''} aufgenommen`; }, 'image/jpeg', 0.92);
        };
      } catch (e) {
        msg.textContent = e.name === 'NotAllowedError' ? 'Kamerazugriff wurde verweigert.' : 'Keine Kamera gefunden – bitte Fotos hochladen.';
        msg.classList.add('err');
      }
    });
  }

  /* Diktat (Web Speech API) */
  function dictation(onText, onState) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    const r = new SR(); r.lang = 'de-DE'; r.continuous = true; r.interimResults = false;
    let on = false;
    r.onresult = e => { for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) onText(e.results[i][0].transcript.trim()); };
    r.onstart = () => { on = true; onState(true); };
    r.onend = () => { on = false; onState(false); };
    r.onerror = e => { on = false; onState(false, e.error); };
    return { toggle() { on ? r.stop() : r.start(); }, stop() { if (on) r.stop(); } };
  }

  return { scan, webcam, dictation };
})();

window.Media = Media;
