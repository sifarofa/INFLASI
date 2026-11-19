import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  CommodityInputRow,
  HierarchyNodeMeta,
  KabKotaCode,
  PeriodSelection,
  PersistedInflationState,
  RegionCode,
  RegionLKResult,
  RespondentFrequency,
  RespondentRHDataset,
  TabelJejerRow,
  UpdateHistoryEntry,
  UploadFileKind,
} from '../types/inflasi';
import { buildInitialKabKotaInputs, DEFAULT_PERIOD } from '../data/regions';
import { calculateAllRegions } from '../utils/calculationEngine';

const STORAGE_KEY = 'kalbar_ihk_monitoring_v2';

function createInitialState(): PersistedInflationState {
  return {
    version: 2,
    period: { ...DEFAULT_PERIOD },
    kabKotaInputs: buildInitialKabKotaInputs(),
    customHierarchyNodes: {},
    history: [],
    respondentDatasets: {},
  };
}

function loadPersistedState(): PersistedInflationState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createInitialState();
    const parsed = JSON.parse(raw) as PersistedInflationState;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !parsed.kabKotaInputs ||
      !parsed.kabKotaInputs['6107']
    ) {
      return createInitialState();
    }
    return {
      version: 2,
      period: parsed.period ?? { ...DEFAULT_PERIOD },
      kabKotaInputs: parsed.kabKotaInputs,
      customHierarchyNodes: parsed.customHierarchyNodes ?? {},
      history: Array.isArray(parsed.history) ? parsed.history : [],
      respondentDatasets: (() => {
        const rawDs = (parsed.respondentDatasets ?? {}) as Record<string, RespondentRHDataset>;
        const normalized: Record<string, RespondentRHDataset> = {};
        for (const [key, val] of Object.entries(rawDs)) {
          if (!val) continue;
          const scopedKey = key.includes('_') ? key : `${val.regionCode}_${val.frequency}`;
          normalized[scopedKey] = val;
        }
        return normalized;
      })(),
    };
  } catch {
    return createInitialState();
  }
}

export function useInflationStore() {
  const [state, setState] = useState<PersistedInflationState>(() => loadPersistedState());

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Ignore storage quota errors
    }
  }, [state]);

  const computed: {
    allNodes: HierarchyNodeMeta[];
    results: Record<RegionCode, RegionLKResult>;
    jejerRows: TabelJejerRow[];
  } = useMemo(
    () =>
      calculateAllRegions(
        state.period,
        state.kabKotaInputs,
        state.customHierarchyNodes
      ),
    [state.period, state.kabKotaInputs, state.customHierarchyNodes]
  );

  const setPeriod = useCallback((period: PeriodSelection) => {
    setState((prev) => ({
      ...prev,
      period,
    }));
  }, []);

  const applyMonthlyUpload = useCallback(
    (params: {
      regionCode: KabKotaCode;
      period: PeriodSelection;
      nk0Update?: {
        pakomCodes: string[];
        updatesMap: Record<string, number>;
        newHierarchyNodes?: HierarchyNodeMeta[];
      };
      nkUpdates?: Record<string, number>;
      rhUpdates?: Record<string, number>;
      logs: Array<{
        kind: UploadFileKind;
        fileName: string;
        matchedCount: number;
        unmatchedCount: number;
      }>;
    }) => {
      const { regionCode, period, nk0Update, nkUpdates, rhUpdates, logs } = params;

      setState((prev) => {
        const currentRegionMap = prev.kabKotaInputs[regionCode] ?? {};
        let nextRegionMap: Record<string, CommodityInputRow> = { ...currentRegionMap };
        const nextCustomNodes = { ...prev.customHierarchyNodes };

        // 1. Apply NK0 & Pakom first (if uploaded), so subsequent NK/RH updates in same batch apply cleanly
        if (nk0Update) {
          if (nk0Update.newHierarchyNodes) {
            for (const node of nk0Update.newHierarchyNodes) {
              nextCustomNodes[node.kode] = node;
            }
          }

          const rebuiltMap: Record<string, CommodityInputRow> = {};
          for (const kode of nk0Update.pakomCodes) {
            const newNk0 = nk0Update.updatesMap[kode] ?? 0;
            const prevRow = nextRegionMap[kode];
            rebuiltMap[kode] = prevRow
              ? { ...prevRow, nk0: newNk0 }
              : {
                  kode,
                  nk0: newNk0,
                  nkPrev: newNk0, // Safe neutral baseline until NK (N-1) is uploaded
                  rhCurrent: 100,
                };
          }
          nextRegionMap = rebuiltMap;
        }

        // 2. Apply NK (N-1)
        if (nkUpdates) {
          for (const [kode, nkPrev] of Object.entries(nkUpdates)) {
            if (nextRegionMap[kode]) {
              nextRegionMap[kode] = { ...nextRegionMap[kode], nkPrev };
            }
          }
        }

        // 3. Apply RH (N)
        if (rhUpdates) {
          for (const [kode, rhCurrent] of Object.entries(rhUpdates)) {
            if (nextRegionMap[kode]) {
              nextRegionMap[kode] = { ...nextRegionMap[kode], rhCurrent };
            }
          }
        }

        const newHistoryEntries: UpdateHistoryEntry[] = logs.map((l, idx) => ({
          id: `${Date.now()}-${idx}`,
          timestamp: new Date().toISOString(),
          regionCode,
          period,
          kind: l.kind,
          fileName: l.fileName,
          matchedCount: l.matchedCount,
          unmatchedCount: l.unmatchedCount,
        }));

        return {
          ...prev,
          period,
          customHierarchyNodes: nextCustomNodes,
          kabKotaInputs: {
            ...prev.kabKotaInputs,
            [regionCode]: nextRegionMap,
          },
          history: [...newHistoryEntries, ...prev.history].slice(0, 40),
        };
      });
    },
    []
  );

  const updateCommodityInput = useCallback(
    (
      regionCode: KabKotaCode,
      kode: string,
      field: 'nkPrev' | 'rhCurrent',
      value: number
    ) => {
      if (!Number.isFinite(value) || value < 0) return;
      setState((prev) => {
        const currentRegionMap = prev.kabKotaInputs[regionCode];
        if (!currentRegionMap || !currentRegionMap[kode]) return prev;
        return {
          ...prev,
          kabKotaInputs: {
            ...prev.kabKotaInputs,
            [regionCode]: {
              ...currentRegionMap,
              [kode]: {
                ...currentRegionMap[kode],
                [field]: value,
              },
            },
          },
        };
      });
    },
    []
  );

  const setRespondentDataset = useCallback(
    (frequency: RespondentFrequency, dataset: RespondentRHDataset) => {
      const scopedKey = `${dataset.regionCode}_${frequency}`;
      setState((prev) => ({
        ...prev,
        respondentDatasets: {
          ...prev.respondentDatasets,
          [scopedKey]: dataset,
        },
      }));
    },
    []
  );

  const resetToInitialData = useCallback(() => {
    const fresh = createInitialState();
    setState(fresh);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Ignore
    }
  }, []);

  return {
    period: state.period,
    kabKotaInputs: state.kabKotaInputs,
    allNodes: computed.allNodes,
    results: computed.results,
    jejerRows: computed.jejerRows,
    history: state.history,
    respondentDatasets: state.respondentDatasets,
    setPeriod,
    applyMonthlyUpload,
    updateCommodityInput,
    setRespondentDataset,
    resetToInitialData,
  };
}
