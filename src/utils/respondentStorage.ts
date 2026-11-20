import type {
  PeriodSelection,
  RespondentFrequency,
  RespondentPriceObservation,
  RespondentRHDataset,
} from '../types/inflasi';
import { recalculateRespondentObservation, summarizeRespondentRH } from './excelParser';

const DB_NAME = 'kalbar_ihk_respondent_db';
const STORE_NAME = 'datasets';
const RECORD_KEY = 'all_respondent_datasets_v1';
const ANNOTATIONS_STORAGE_KEY = 'kalbar_ihk_respondent_annotations_v1';

export interface RespondentObservationAnnotation {
  catatan?: string;
  perluPerbaikan?: boolean;
  currPrices?: (number | null)[];
  originalCurrPrices?: (number | null)[];
  hargaDiperbaiki?: boolean;
  updatedAt?: string;
}

type AnnotationStoreMap = Record<string, Record<string, RespondentObservationAnnotation>>;

export function buildDatasetAnnotationScopeKey(
  period: PeriodSelection,
  regionCode: string,
  frequency: RespondentFrequency
): string {
  return `${period.year}-${period.month}_${regionCode}_${frequency}`;
}

export function buildObservationAnnotationKey(
  obs: Pick<RespondentPriceObservation, 'kodeKomoditas' | 'kodeKualitas' | 'namaResponden' | 'pasar'>
): string {
  return `${obs.kodeKomoditas}|${obs.kodeKualitas}|${obs.namaResponden.trim()}|${obs.pasar.trim()}`;
}

function readAllAnnotations(): AnnotationStoreMap {
  try {
    const raw = localStorage.getItem(ANNOTATIONS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as AnnotationStoreMap;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function saveObservationAnnotation(
  period: PeriodSelection,
  regionCode: string,
  frequency: RespondentFrequency,
  obs: RespondentPriceObservation,
  patch: {
    catatan?: string;
    perluPerbaikan?: boolean;
    currPrices?: (number | null)[];
    originalCurrPrices?: (number | null)[];
    hargaDiperbaiki?: boolean;
  }
): void {
  try {
    const all = readAllAnnotations();
    const scopeKey = buildDatasetAnnotationScopeKey(period, regionCode, frequency);
    const obsKey = buildObservationAnnotationKey(obs);
    const currentScope = { ...(all[scopeKey] ?? {}) };
    const existing = currentScope[obsKey];

    const rawCatatan = patch.catatan !== undefined ? patch.catatan : (obs.catatan ?? existing?.catatan ?? '');
    const nextCatatanTrimmed = rawCatatan.trim();
    const nextFlag =
      patch.perluPerbaikan !== undefined
        ? Boolean(patch.perluPerbaikan)
        : Boolean(obs.perluPerbaikan ?? existing?.perluPerbaikan);
    const nextHargaDiperbaiki =
      patch.hargaDiperbaiki !== undefined
        ? Boolean(patch.hargaDiperbaiki)
        : Boolean(obs.hargaDiperbaiki ?? existing?.hargaDiperbaiki);

    if (!nextCatatanTrimmed && !nextFlag && !nextHargaDiperbaiki) {
      delete currentScope[obsKey];
    } else {
      const nextCurrPrices = nextHargaDiperbaiki
        ? (patch.currPrices ?? obs.currPrices ?? existing?.currPrices)
        : undefined;
      const nextOrigPrices = nextHargaDiperbaiki
        ? (patch.originalCurrPrices ?? obs.originalCurrPrices ?? existing?.originalCurrPrices)
        : undefined;
      currentScope[obsKey] = {
        ...(rawCatatan ? { catatan: rawCatatan } : {}),
        ...(nextFlag ? { perluPerbaikan: true } : {}),
        ...(nextHargaDiperbaiki && nextCurrPrices
          ? {
              hargaDiperbaiki: true,
              currPrices: nextCurrPrices,
              originalCurrPrices: nextOrigPrices,
            }
          : {}),
        updatedAt: new Date().toISOString(),
      };
    }

    if (Object.keys(currentScope).length === 0) {
      delete all[scopeKey];
    } else {
      all[scopeKey] = currentScope;
    }
    localStorage.setItem(ANNOTATIONS_STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Ignore storage quota errors
  }
}

export function applyAnnotationsToDataset(
  dataset: RespondentRHDataset
): RespondentRHDataset {
  const all = readAllAnnotations();
  const scopeKey = buildDatasetAnnotationScopeKey(
    dataset.period,
    dataset.regionCode,
    dataset.frequency
  );
  const scopeMap = all[scopeKey];
  if (!scopeMap || Object.keys(scopeMap).length === 0) return dataset;

  let changed = false;
  let pricesChanged = false;
  const nextObs = dataset.observations.map((obs) => {
    const ann = scopeMap[buildObservationAnnotationKey(obs)];
    if (!ann) return obs;
    changed = true;

    let updated: RespondentPriceObservation = {
      ...obs,
      catatan: ann.catatan ?? obs.catatan ?? '',
      perluPerbaikan: ann.perluPerbaikan ?? obs.perluPerbaikan ?? false,
    };

    if (
      ann.hargaDiperbaiki &&
      Array.isArray(ann.currPrices) &&
      ann.currPrices.length === obs.currPrices.length
    ) {
      pricesChanged = true;
      updated = recalculateRespondentObservation(
        {
          ...updated,
          originalCurrPrices:
            ann.originalCurrPrices ?? obs.originalCurrPrices ?? [...obs.currPrices],
        },
        ann.currPrices
      );
    }

    return updated;
  });

  if (!changed) return dataset;
  return {
    ...dataset,
    observations: nextObs,
    commoditySummaries: pricesChanged
      ? summarizeRespondentRH(nextObs, dataset.frequency)
      : dataset.commoditySummaries,
  };
}

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
  try {
    localStorage.removeItem(ANNOTATIONS_STORAGE_KEY);
  } catch {
    // Ignore
  }
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
