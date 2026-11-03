/* Kleiner ZIP-Leser/-Schreiber ohne Fremdbibliothek.
   Lesen: gespeichert oder Deflate (über DecompressionStream). Schreiben: unkomprimiert (Fotos sind ohnehin JPEG). */
'use strict';

const Zip = (() => {
  /* ---------- Lesen ---------- */
  async function read(buf) {
    const dv = new DataView(buf), u8 = new Uint8Array(buf);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 66000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('Keine gültige Datei (ZIP-Struktur fehlt).');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const dec = new TextDecoder();
    const entries = new Map();
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const lho = dv.getUint32(p + 42, true);
      entries.set(dec.decode(u8.subarray(p + 46, p + 46 + nlen)), { method, csize, lho });
      p += 46 + nlen + xlen + clen;
    }
    async function bytes(name) {
      const e = entries.get(name); if (!e) return null;
      const start = e.lho + 30 + dv.getUint16(e.lho + 26, true) + dv.getUint16(e.lho + 28, true);
      const raw = u8.subarray(start, start + e.csize);
      if (e.method === 0) return raw.slice();
      if (e.method !== 8) throw new Error('Nicht unterstütztes Packformat');
      if (typeof DecompressionStream === 'undefined') throw new Error('Dieser Browser kann die Datei nicht entpacken – bitte iOS/Browser aktualisieren.');
      const ds = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(ds).arrayBuffer());
    }
    return {
      names: () => [...entries.keys()],
      has: n => entries.has(n),
      bytes,
      text: async n => { const b = await bytes(n); return b ? new TextDecoder().decode(b) : null; },
      blob: async (n, type) => { const b = await bytes(n); return b ? new Blob([b], { type: type || 'application/octet-stream' }) : null; }
    };
  }

  /* ---------- Schreiben ---------- */
  const TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(u8) { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
  function dosTime(d) {
    return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
  }

  /* files: [{ name, data: Blob | Uint8Array | string }] → Blob (application/zip) */
  async function write(files, onProgress) {
    const enc = new TextEncoder(), parts = [], central = [];
    const { time, date } = dosTime(new Date());
    let offset = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const isBlob = f.data instanceof Blob;
      const bytes = isBlob ? new Uint8Array(await f.data.arrayBuffer()) : typeof f.data === 'string' ? enc.encode(f.data) : f.data;
      const name = enc.encode(f.name), crc = crc32(bytes), size = bytes.length;
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, time, true); lh.setUint16(12, date, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, size, true); lh.setUint32(22, size, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(lh.buffer, name, isBlob ? f.data : bytes); // Blob selbst weiterreichen spart Speicher
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
      ch.setUint16(12, time, true); ch.setUint16(14, date, true); ch.setUint32(16, crc, true); ch.setUint32(20, size, true); ch.setUint32(24, size, true);
      ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
      central.push(ch.buffer, name);
      offset += 30 + name.length + size;
      if (onProgress) onProgress(i + 1, files.length);
    }
    const cdSize = central.reduce((a, b) => a + b.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
  }

  return { read, write };
})();

window.Zip = Zip;
