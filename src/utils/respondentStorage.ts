import type { RespondentRHDataset } from '../types/inflasi';

const DB_NAME = 'kalbar_ihk_respondent_db';
const STORE_NAME = 'datasets';
const RECORD_KEY = 'all_respondent_datasets_v1';

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function loadRespondentDatasets(): Promise<Record<string, RespondentRHDataset>> {
  const db = await openDb();
  if (!db) return {};
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(RECORD_KEY);
      req.onsuccess = () => {
        const res = req.result as Record<string, RespondentRHDataset> | undefined;
        resolve(res && typeof res === 'object' ? res : {});
      };
      req.onerror = () => resolve({});
    } catch {
      resolve({});
    }
  });
}

export async function saveRespondentDatasets(
  datasets: Record<string, RespondentRHDataset>
): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(datasets, RECORD_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function clearRespondentDatasets(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.delete(RECORD_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}
