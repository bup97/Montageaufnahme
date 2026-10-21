/* Speicher: IndexedDB mit Projekten und Fotos (Fotos als Blob). */
'use strict';

const DB = (() => {
  const NAME = 'FunkwerkRecorderV4', VERSION = 1;
  let db = null;

  function req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
  function tx(stores, mode = 'readonly') { return db.transaction(stores, mode); }
  function done(t) { return new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); }

  async function open() {
    if (db) return db;
    db = await new Promise((res, rej) => {
      const r = indexedDB.open(NAME, VERSION);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('photos')) {
          const s = d.createObjectStore('photos', { keyPath: 'id' });
          s.createIndex('projectId', 'projectId');
        }
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return db;
  }

  const api = {
    open,
    async allProjects() { return req(tx(['projects']).objectStore('projects').getAll()); },
    async getProject(id) { return req(tx(['projects']).objectStore('projects').get(id)); },
    async putProject(p) { const t = tx(['projects'], 'readwrite'); t.objectStore('projects').put(p); return done(t); },
    async deleteProject(id) {
      const t = tx(['projects', 'photos'], 'readwrite');
      t.objectStore('projects').delete(id);
      const idx = t.objectStore('photos').index('projectId');
      idx.openKeyCursor(IDBKeyRange.only(id)).onsuccess = e => {
        const c = e.target.result; if (c) { t.objectStore('photos').delete(c.primaryKey); c.continue(); }
      };
      return done(t);
    },
    async getPhoto(id) { return req(tx(['photos']).objectStore('photos').get(id)); },
    async putPhoto(ph) { const t = tx(['photos'], 'readwrite'); t.objectStore('photos').put(ph); return done(t); },
    async deletePhotos(ids) {
      if (!ids.length) return;
      const t = tx(['photos'], 'readwrite'); const s = t.objectStore('photos');
      ids.forEach(id => s.delete(id)); return done(t);
    },
    async photoIdsOf(projectId) { return req(tx(['photos']).objectStore('photos').index('projectId').getAllKeys(IDBKeyRange.only(projectId))); }
  };

  /* Einmalige Übernahme der Daten aus V3 (gleiche Domain, DB "FunkwerkMontageDB"). */
  api.readLegacy = async function () {
    try {
      if (indexedDB.databases) {
        const list = await indexedDB.databases();
        if (!list.some(d => d.name === 'FunkwerkMontageDB')) return null;
      }
      const old = await new Promise((res) => {
        const r = indexedDB.open('FunkwerkMontageDB');
        // Existiert die alte DB nicht, wird das Anlegen sofort abgebrochen.
        r.onupgradeneeded = () => r.transaction.abort();
        r.onsuccess = () => res(r.result);
        r.onerror = () => res(null);
        r.onblocked = () => res(null);
        setTimeout(() => res(null), 4000);
      });
      if (!old || !old.objectStoreNames.contains('appData')) { if (old) old.close(); return null; }
      const t = old.transaction(['appData', 'photos'], 'readonly');
      const state = await req(t.objectStore('appData').get('appState'));
      const photos = await req(t.objectStore('photos').getAll());
      old.close();
      if (!state || !state.data) return null;
      return { state: state.data, photos };
    } catch (e) { console.warn('Legacy-Import übersprungen', e); return null; }
  };

  return api;
})();

window.DB = DB;
