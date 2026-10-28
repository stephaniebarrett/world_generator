// Autosave of the current world in IndexedDB. Every call swallows failures: storage can be missing or
// blocked (private windows, cleared site data), and the app must work without it.

import { parseWorld, serializeWorld, type WorldFile } from './world-file';

const DB_NAME = 'world-generator';
const STORE = 'worlds';
const KEY = 'current';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveCurrent(file: WorldFile): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(serializeWorld(file), KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Autosave is a convenience; ignore failures.
  }
}

export async function loadCurrent(): Promise<WorldFile | null> {
  try {
    const db = await open();
    const text = await new Promise<unknown>((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return typeof text === 'string' ? parseWorld(text) : null;
  } catch {
    return null;
  }
}
