import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CommodityInputRow,
  HierarchyNodeMeta,
  KabKotaCode,
  Nk0RegionMeta,
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
import { buildInitialKabKotaInputs, DEFAULT_PERIOD, KAB_KOTA_CODES } from '../data/regions';
import { calculateAllRegions } from '../utils/calculationEngine';
import {
  applyAnnotationsToDataset,
  clearRespondentDatasets,
  loadRespondentDatasets,
  saveObservationAnnotation,
  saveRespondentDatasets,
} from '../utils/respondentStorage';
import { isSupabaseConfigured, type SupabaseConnectionStatus } from '../lib/supabase';
import {
  buildRegionUpsertRows,
  fetchAvailablePeriodsFromSupabase,
  fetchLatestNk0BaselineForRegions,
  fetchPeriodLKFromSupabase,
  fetchRespondentDatasetsFromSupabase,
  fetchUploadLogsFromSupabase,
  insertUploadLogsToSupabase,
  rolloverPrevMonthFromSupabase,
  saveRespondentDatasetToSupabase,
  upsertLKRowsBatchToSupabase,
} from '../utils/supabaseSync';

const STORAGE_KEY = 'kalbar_ihk_monitoring_v2';

function buildInitialNk0Meta(
  inputs: Record<KabKotaCode, Record<string, CommodityInputRow>>
): Partial<Record<KabKotaCode, Nk0RegionMeta>> {
  return {
    '6107': {
      pakomCount: Object.keys(inputs['6107'] ?? {}).length,
      savedAt: 'Baseline SBH2022',
      fileName: 'nk0_6107.csv',
      isCustom: true,
    },
  };
}

function normalizeRespondentDatasetsMap(
  rawDs: Record<string, RespondentRHDataset> | undefined
): Record<string, RespondentRHDataset> {
  if (!rawDs || typeof rawDs !== 'object') return {};
  const normalized: Record<string, RespondentRHDataset> = {};
  for (const [key, val] of Object.entries(rawDs)) {
    if (!val) continue;
    const scopedKey = key.includes('_') ? key : `${val.regionCode}_${val.frequency}`;
    normalized[scopedKey] = applyAnnotationsToDataset(val);
  }
  return normalized;
}

function createInitialState(): PersistedInflationState {
  const inputs = buildInitialKabKotaInputs();
  return {
    version: 2,
    period: { ...DEFAULT_PERIOD },
    kabKotaInputs: inputs,
    nk0Meta: buildInitialNk0Meta(inputs),
    customHierarchyNodes: {},
    history: [],
    respondentDatasets: {},
  };
}

function loadPersistedState(): {
  state: PersistedInflationState;
  legacyRespondentDatasets: Record<string, RespondentRHDataset>;
  hasSavedPeriod: boolean;
} {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { state: createInitialState(), legacyRespondentDatasets: {}, hasSavedPeriod: false };
    }
    const parsed = JSON.parse(raw) as PersistedInflationState;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !parsed.kabKotaInputs ||
      !parsed.kabKotaInputs['6107']
    ) {
      return { state: createInitialState(), legacyRespondentDatasets: {}, hasSavedPeriod: false };
    }

    const legacyRespondentDatasets = normalizeRespondentDatasetsMap(parsed.respondentDatasets);

    const initialMeta = buildInitialNk0Meta(parsed.kabKotaInputs);
    const savedMeta = parsed.nk0Meta ?? {};
    const mergedMeta: Partial<Record<KabKotaCode, Nk0RegionMeta>> = { ...initialMeta };
    for (const code of KAB_KOTA_CODES) {
      if (savedMeta[code]) {
        mergedMeta[code] = savedMeta[code];
      } else {
        const prevNk0Log = (parsed.history ?? []).find(
          (h) => h.regionCode === code && h.kind === 'NK0'
        );
        if (prevNk0Log) {
          mergedMeta[code] = {
            pakomCount: Object.keys(parsed.kabKotaInputs[code] ?? {}).length,
            savedAt: prevNk0Log.timestamp,
            fileName: prevNk0Log.fileName,
            isCustom: true,
          };
        }
      }
    }

    const hasSavedPeriod = Boolean(
      parsed.period &&
        Number.isFinite(parsed.period.year) &&
        Number.isFinite(parsed.period.month)
    );

    return {
      state: {
        version: 2,
        period: parsed.period ?? { ...DEFAULT_PERIOD },
        kabKotaInputs: parsed.kabKotaInputs,
        nk0Meta: mergedMeta,
        customHierarchyNodes: parsed.customHierarchyNodes ?? {},
        history: Array.isArray(parsed.history) ? parsed.history : [],
        respondentDatasets: {},
      },
      legacyRespondentDatasets,
      hasSavedPeriod,
    };
  } catch {
    return { state: createInitialState(), legacyRespondentDatasets: {}, hasSavedPeriod: false };
  }
}

export function useInflationStore() {
  const initialLoadRef = useRef<{
    state: PersistedInflationState;
    legacyRespondentDatasets: Record<string, RespondentRHDataset>;
    hasSavedPeriod: boolean;
  } | null>(null);
  if (!initialLoadRef.current) {
    initialLoadRef.current = loadPersistedState();
  }

  const [state, setState] = useState<PersistedInflationState>(initialLoadRef.current.state);
  const [respondentDatasets, setRespondentDatasetsState] = useState<
    Record<string, RespondentRHDataset>
  >(initialLoadRef.current.legacyRespondentDatasets);
  const respondentHydratedRef = useRef(false);
  const hasSavedPeriodRef = useRef(initialLoadRef.current.hasSavedPeriod);

  const stateRef = useRef(state);
  stateRef.current = state;

  const [connectionStatus, setConnectionStatus] = useState<SupabaseConnectionStatus>(
    isSupabaseConfigured ? 'syncing' : 'local'
  );
  const [supabaseError, setSupabaseError] = useState<string | null>(null);
  const [availablePeriods, setAvailablePeriods] = useState<PeriodSelection[]>([]);
  const [currentPeriodHasSupabaseData, setCurrentPeriodHasSupabaseData] = useState<boolean | null>(
    null
  );
  const lastFetchedPeriodRef = useRef<string | null>(null);

  // Hydrate respondent datasets from IndexedDB (migrating any legacy localStorage copy)
  useEffect(() => {
    let active = true;
    loadRespondentDatasets().then((idbData) => {
      if (!active) return;
      const normalizedIdb = normalizeRespondentDatasetsMap(idbData);
      const legacy = initialLoadRef.current?.legacyRespondentDatasets ?? {};
      const merged = { ...legacy, ...normalizedIdb };
      setRespondentDatasetsState((current) => ({ ...merged, ...current }));
      respondentHydratedRef.current = true;
      if (Object.keys(legacy).length > 0 && Object.keys(normalizedIdb).length === 0) {
        void saveRespondentDatasets(merged);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  // Persist compact NK0/NK/RH & hierarchy data to localStorage
  useEffect(() => {
    try {
      const compactState: PersistedInflationState = {
        ...state,
        respondentDatasets: {},
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(compactState));
    } catch {
      // Ignore storage quota errors
    }
  }, [state]);

  // Persist respondentDatasets safely in IndexedDB
  useEffect(() => {
    if (!respondentHydratedRef.current && Object.keys(respondentDatasets).length === 0) return;
    void saveRespondentDatasets(respondentDatasets);
  }, [respondentDatasets]);

  // Load data from Supabase when mounted or when active period (tahun/bulan) changes
  const refreshFromSupabase = useCallback(async (targetPeriod: PeriodSelection, isPeriodSwitch: boolean) => {
    if (!isSupabaseConfigured) {
      setConnectionStatus('local');
      return;
    }

    setConnectionStatus('syncing');
    setSupabaseError(null);

    try {
      const [lkResult, logsResult, respResult, periodsResult] = await Promise.all([
        fetchPeriodLKFromSupabase(targetPeriod),
        fetchUploadLogsFromSupabase(targetPeriod).catch(() => null),
        fetchRespondentDatasetsFromSupabase(
          targetPeriod,
          stateRef.current.customHierarchyNodes
        ).catch(() => null),
        fetchAvailablePeriodsFromSupabase().catch(() => [] as PeriodSelection[]),
      ]);

      setAvailablePeriods(periodsResult);

      const regionsFound = KAB_KOTA_CODES.filter(
        (code) => lkResult.byRegion[code] && Object.keys(lkResult.byRegion[code]!).length > 0
      );

      // Jika device baru (belum ada periode tersimpan di localStorage) dan periode default kosong,
      // otomatis lompat ke periode terbaru yang memiliki data di Supabase.
      if (
        regionsFound.length === 0 &&
        !hasSavedPeriodRef.current &&
        periodsResult.length > 0 &&
        (periodsResult[0].year !== targetPeriod.year || periodsResult[0].month !== targetPeriod.month)
      ) {
        hasSavedPeriodRef.current = true;
        setState((prev) => ({
          ...prev,
          period: periodsResult[0],
        }));
        return;
      }

      setCurrentPeriodHasSupabaseData(regionsFound.length > 0);
      const missingRegions = KAB_KOTA_CODES.filter((code) => !regionsFound.includes(code));

      // Carry forward NK0 Pakom from latest stored Supabase period for regions not yet uploaded this month
      const latestNk0Map =
        missingRegions.length > 0
          ? await fetchLatestNk0BaselineForRegions(missingRegions).catch(() => ({} as Partial<Record<KabKotaCode, Record<string, CommodityInputRow>>>))
          : ({} as Partial<Record<KabKotaCode, Record<string, CommodityInputRow>>>);

      setState((prev) => {
        const nextInputs = { ...prev.kabKotaInputs };
        const nextNk0Meta = { ...(prev.nk0Meta ?? {}) };
        const nextCustomNodes = { ...prev.customHierarchyNodes };

        for (const [kode, nama] of Object.entries(lkResult.extraNames)) {
          if (!nextCustomNodes[kode] && kode.length === 7) {
            nextCustomNodes[kode] = {
              kode,
              lkKode: kode.startsWith('0') ? kode.slice(1) : kode,
              nama,
              flag: 3,
              parentCode: kode.slice(0, 3),
              kelompokCode: kode.slice(0, 2),
              subkelompokCode: kode.slice(0, 3),
              kuesioner: 'HK-1.2',
            };
          }
        }

        for (const code of KAB_KOTA_CODES) {
          const sbRegionRows = lkResult.byRegion[code];
          if (sbRegionRows && Object.keys(sbRegionRows).length > 0) {
            nextInputs[code] = sbRegionRows;
            nextNk0Meta[code] = {
              pakomCount: Object.keys(sbRegionRows).length,
              savedAt: new Date().toISOString(),
              fileName: `Supabase (${String(targetPeriod.month).padStart(2, '0')}/${targetPeriod.year})`,
              isCustom: true,
            };
          } else if (latestNk0Map[code] && Object.keys(latestNk0Map[code]!).length > 0) {
            nextInputs[code] = latestNk0Map[code]!;
            nextNk0Meta[code] = {
              pakomCount: Object.keys(latestNk0Map[code]!).length,
              savedAt: new Date().toISOString(),
              fileName: 'Pakom NK0 (Supabase)',
              isCustom: true,
            };
          } else if (isPeriodSwitch && prev.kabKotaInputs[code]) {
            // Preserve permanent NK0 Pakom locally while clearing previous month's RH/NK deltas on new period
            const resetRows: Record<string, CommodityInputRow> = {};
            for (const [k, item] of Object.entries(prev.kabKotaInputs[code])) {
              resetRows[k] = {
                kode: item.kode,
                nk0: item.nk0,
                nkPrev: item.nk0,
                rhCurrent: 100,
              };
            }
            nextInputs[code] = resetRows;
          }
        }

        return {
          ...prev,
          kabKotaInputs: nextInputs,
          nk0Meta: nextNk0Meta,
          customHierarchyNodes: nextCustomNodes,
          history: logsResult !== null ? logsResult : prev.history,
        };
      });

      if (respResult !== null) {
        respondentHydratedRef.current = true;
        const annotatedResp: Record<string, RespondentRHDataset> = {};
        for (const [k, ds] of Object.entries(respResult)) {
          annotatedResp[k] = applyAnnotationsToDataset(ds);
        }
        setRespondentDatasetsState((prev) => {
          if (Object.keys(annotatedResp).length > 0) {
            // Merge active period datasets fetched from Supabase
            return isPeriodSwitch ? annotatedResp : { ...prev, ...annotatedResp };
          }
          return isPeriodSwitch ? {} : prev;
        });
      }

      setConnectionStatus('connected');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Gagal terhubung ke Supabase.';
      setSupabaseError(msg);
      setConnectionStatus('local');
    }
  }, []);

  useEffect(() => {
    const key = `${state.period.year}-${state.period.month}`;
    const isPeriodSwitch =
      lastFetchedPeriodRef.current !== null && lastFetchedPeriodRef.current !== key;
    lastFetchedPeriodRef.current = key;
    void refreshFromSupabase(state.period, isPeriodSwitch);
  }, [state.period.year, state.period.month, refreshFromSupabase]);

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
    hasSavedPeriodRef.current = true;
    setState((prev) => ({
      ...prev,
      period,
    }));
  }, []);

  const applyMonthlyUpload = useCallback(
    async (params: {
      regionCode: KabKotaCode;
      period: PeriodSelection;
      nk0Update?: {
        pakomCodes: string[];
        updatesMap: Record<string, number>;
        newHierarchyNodes?: HierarchyNodeMeta[];
        fileName?: string;
      };
      nkUpdates?: Record<string, number>;
      nkPrevPakomSync?: {
        pakomCodes: string[];
        derivedNk0Map: Record<string, number>;
        newHierarchyNodes?: HierarchyNodeMeta[];
        fileName?: string;
      };
      rhUpdates?: Record<string, number>;
      logs: Array<{
        kind: UpdateHistoryEntry['kind'];
        fileName: string;
        matchedCount: number;
        unmatchedCount: number;
      }>;
    }): Promise<{ syncedToSupabase: boolean; savedRows: number; error?: string }> => {
      const { regionCode, period, nk0Update, nkUpdates, nkPrevPakomSync, rhUpdates, logs } = params;

      // Build next region map synchronously from latest ref so both React state and Supabase get identical rows
      const currentRegionMap = stateRef.current.kabKotaInputs[regionCode] ?? {};
      let nextRegionMap: Record<string, CommodityInputRow> = { ...currentRegionMap };

      if (nk0Update) {
        const rebuiltMap: Record<string, CommodityInputRow> = {};
        for (const kode of nk0Update.pakomCodes) {
          const newNk0 = nk0Update.updatesMap[kode] ?? 0;
          const prevRow = nextRegionMap[kode];
          rebuiltMap[kode] = prevRow
            ? { ...prevRow, nk0: newNk0 }
            : {
                kode,
                nk0: newNk0,
                nkPrev: newNk0,
                rhCurrent: 100,
              };
        }
        nextRegionMap = rebuiltMap;
      } else if (nkPrevPakomSync) {
        const rebuiltMap: Record<string, CommodityInputRow> = {};
        for (const kode of nkPrevPakomSync.pakomCodes) {
          const prevRow = nextRegionMap[kode];
          const nk0Val = prevRow?.nk0 ?? nkPrevPakomSync.derivedNk0Map[kode] ?? 0;
          rebuiltMap[kode] = prevRow
            ? { ...prevRow, nk0: nk0Val }
            : {
                kode,
                nk0: nk0Val,
                nkPrev: nkUpdates?.[kode] ?? nk0Val,
                rhCurrent: 100,
              };
        }
        nextRegionMap = rebuiltMap;
      }

      if (nkUpdates) {
        for (const [kode, nkPrev] of Object.entries(nkUpdates)) {
          if (nextRegionMap[kode]) {
            nextRegionMap[kode] = { ...nextRegionMap[kode], nkPrev };
          }
        }
      }

      if (rhUpdates) {
        for (const [kode, rhCurrent] of Object.entries(rhUpdates)) {
          if (nextRegionMap[kode]) {
            nextRegionMap[kode] = { ...nextRegionMap[kode], rhCurrent };
          }
        }
      }

      setState((prev) => {
        const nextCustomNodes = { ...prev.customHierarchyNodes };
        const nextNk0Meta = { ...(prev.nk0Meta ?? {}) };

        if (nk0Update) {
          if (nk0Update.newHierarchyNodes) {
            for (const node of nk0Update.newHierarchyNodes) {
              nextCustomNodes[node.kode] = node;
            }
          }
          nextNk0Meta[regionCode] = {
            pakomCount: nk0Update.pakomCodes.length,
            savedAt: new Date().toISOString(),
            fileName:
              nk0Update.fileName ??
              logs.find((l) => l.kind === 'NK0')?.fileName ??
              `nk0_${regionCode}.xlsx`,
            isCustom: true,
          };
        } else if (nkPrevPakomSync) {
          if (nkPrevPakomSync.newHierarchyNodes) {
            for (const node of nkPrevPakomSync.newHierarchyNodes) {
              nextCustomNodes[node.kode] = node;
            }
          }
          nextNk0Meta[regionCode] = {
            pakomCount: nkPrevPakomSync.pakomCodes.length,
            savedAt: new Date().toISOString(),
            fileName:
              nkPrevPakomSync.fileName ??
              logs.find((l) => l.kind === 'NK_PREV')?.fileName ??
              `pakom_${regionCode}.xlsx`,
            isCustom: true,
          };
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
          nk0Meta: nextNk0Meta,
          customHierarchyNodes: nextCustomNodes,
          kabKotaInputs: {
            ...prev.kabKotaInputs,
            [regionCode]: nextRegionMap,
          },
          history: [...newHistoryEntries, ...prev.history].slice(0, 60),
        };
      });

      if (!isSupabaseConfigured) {
        return { syncedToSupabase: false, savedRows: Object.keys(nextRegionMap).length };
      }

      setConnectionStatus('syncing');
      setSupabaseError(null);
      try {
        const mergedCustomNodes = { ...stateRef.current.customHierarchyNodes };
        for (const n of nk0Update?.newHierarchyNodes ?? []) mergedCustomNodes[n.kode] = n;
        for (const n of nkPrevPakomSync?.newHierarchyNodes ?? []) mergedCustomNodes[n.kode] = n;

        const upsertRows = buildRegionUpsertRows(
          period,
          regionCode,
          nextRegionMap,
          mergedCustomNodes
        );
        const savedRows = await upsertLKRowsBatchToSupabase(upsertRows);
        await insertUploadLogsToSupabase(
          logs.map((l) => ({
            regionCode,
            period,
            kind: l.kind,
            fileName: l.fileName,
            matchedCount: l.matchedCount,
            unmatchedCount: l.unmatchedCount,
          }))
        );
        setCurrentPeriodHasSupabaseData(true);
        setAvailablePeriods((prev) => {
          const exists = prev.some((p) => p.year === period.year && p.month === period.month);
          if (exists) return prev;
          return [period, ...prev].sort((a, b) => (b.year !== a.year ? b.year - a.year : b.month - a.month));
        });
        setConnectionStatus('connected');
        return { syncedToSupabase: true, savedRows };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Gagal sinkronisasi ke Supabase.';
        setSupabaseError(msg);
        setConnectionStatus('local');
        return { syncedToSupabase: false, savedRows: Object.keys(nextRegionMap).length, error: msg };
      }
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
      const prevRow = stateRef.current.kabKotaInputs[regionCode]?.[kode];
      if (!prevRow) return;
      const updatedRow: CommodityInputRow = { ...prevRow, [field]: value };
      const activePeriod = stateRef.current.period;

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

      if (isSupabaseConfigured) {
        const regionMap = stateRef.current.kabKotaInputs[regionCode] ?? {};
        const totalNk0 = Object.values(regionMap).reduce(
          (acc, it) => acc + (Number.isFinite(it.nk0) ? it.nk0 : 0),
          0
        );
        const [singleRow] = buildRegionUpsertRows(
          activePeriod,
          regionCode,
          { [kode]: updatedRow },
          stateRef.current.customHierarchyNodes
        );
        if (singleRow) {
          singleRow.bobot = totalNk0 > 0 ? (updatedRow.nk0 / totalNk0) * 100 : 0;
          setConnectionStatus('syncing');
          void upsertLKRowsBatchToSupabase([singleRow])
            .then(() => {
              setSupabaseError(null);
              setConnectionStatus('connected');
            })
            .catch((err) => {
              const msg =
                err instanceof Error ? err.message : 'Gagal menyimpan edit inline ke Supabase.';
              setSupabaseError(msg);
              setConnectionStatus('local');
            });
        }
      }
    },
    []
  );

  const rolloverPrevMonthNK = useCallback(
    async (
      targetRegions: KabKotaCode[]
    ): Promise<{
      totalRolledRows: number;
      prevPeriod: PeriodSelection;
      perRegionCounts: Partial<Record<KabKotaCode, number>>;
    }> => {
      const currentPeriod = stateRef.current.period;
      setConnectionStatus('syncing');
      setSupabaseError(null);
      try {
        const res = await rolloverPrevMonthFromSupabase({
          targetPeriod: currentPeriod,
          targetRegions,
          currentInputs: stateRef.current.kabKotaInputs,
          customNodes: stateRef.current.customHierarchyNodes,
        });

        setState((prev) => {
          const nextInputs = { ...prev.kabKotaInputs };
          const nextNk0Meta = { ...(prev.nk0Meta ?? {}) };
          const newLogs: UpdateHistoryEntry[] = [];

          for (const [reg, map] of Object.entries(res.updatedRegions)) {
            const kCode = reg as KabKotaCode;
            if (!map) continue;
            nextInputs[kCode] = map;
            nextNk0Meta[kCode] = {
              pakomCount: Object.keys(map).length,
              savedAt: new Date().toISOString(),
              fileName: `Rollover ${String(res.prevPeriod.month).padStart(2, '0')}/${res.prevPeriod.year}`,
              isCustom: true,
            };
            newLogs.push({
              id: `${Date.now()}-${kCode}-rollover`,
              timestamp: new Date().toISOString(),
              regionCode: kCode,
              period: currentPeriod,
              kind: 'ROLLOVER',
              fileName: `Tarik NK (N) ${String(res.prevPeriod.month).padStart(2, '0')}/${res.prevPeriod.year} → NK (N-1)`,
              matchedCount: res.perRegionCounts[kCode] ?? Object.keys(map).length,
              unmatchedCount: 0,
            });
          }

          return {
            ...prev,
            kabKotaInputs: nextInputs,
            nk0Meta: nextNk0Meta,
            history: [...newLogs, ...prev.history].slice(0, 60),
          };
        });

        setCurrentPeriodHasSupabaseData(true);
        setAvailablePeriods((prev) => {
          const exists = prev.some(
            (p) => p.year === currentPeriod.year && p.month === currentPeriod.month
          );
          if (exists) return prev;
          return [currentPeriod, ...prev].sort((a, b) =>
            b.year !== a.year ? b.year - a.year : b.month - a.month
          );
        });
        setConnectionStatus('connected');
        return {
          totalRolledRows: res.totalRolledRows,
          prevPeriod: res.prevPeriod,
          perRegionCounts: res.perRegionCounts,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Gagal menarik data bulan lalu.';
        setSupabaseError(msg);
        setConnectionStatus(isSupabaseConfigured ? 'connected' : 'local');
        throw err;
      }
    },
    []
  );

  const setRespondentDataset = useCallback(
    async (
      frequency: RespondentFrequency,
      dataset: RespondentRHDataset
    ): Promise<{ syncedToSupabase: boolean; savedRows: number; error?: string }> => {
      const scopedKey = `${dataset.regionCode}_${frequency}`;
      respondentHydratedRef.current = true;
      setRespondentDatasetsState((prev) => ({
        ...prev,
        [scopedKey]: dataset,
      }));

      if (!isSupabaseConfigured) {
        return { syncedToSupabase: false, savedRows: dataset.observations.length };
      }

      setConnectionStatus('syncing');
      setSupabaseError(null);
      try {
        const savedRows = await saveRespondentDatasetToSupabase(dataset);
        setConnectionStatus('connected');
        return { syncedToSupabase: true, savedRows };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Gagal menyimpan harga responden ke Supabase.';
        setSupabaseError(msg);
        setConnectionStatus('local');
        return { syncedToSupabase: false, savedRows: dataset.observations.length, error: msg };
      }
    },
    []
  );

  const updateRespondentAnnotation = useCallback(
    (
      regionCode: KabKotaCode,
      frequency: RespondentFrequency,
      observationId: string,
      patch: { catatan?: string; perluPerbaikan?: boolean }
    ) => {
      const scopedKey = `${regionCode}_${frequency}`;
      respondentHydratedRef.current = true;
      setRespondentDatasetsState((prev) => {
        const ds = prev[scopedKey];
        if (!ds) return prev;
        let updatedTarget: typeof ds.observations[number] | null = null;
        const nextObservations = ds.observations.map((obs) => {
          if (obs.id !== observationId) return obs;
          updatedTarget = {
            ...obs,
            catatan: patch.catatan !== undefined ? patch.catatan : obs.catatan,
            perluPerbaikan:
              patch.perluPerbaikan !== undefined ? patch.perluPerbaikan : obs.perluPerbaikan,
          };
          return updatedTarget;
        });
        if (updatedTarget) {
          saveObservationAnnotation(ds.period, regionCode, frequency, updatedTarget, patch);
        }
        return {
          ...prev,
          [scopedKey]: {
            ...ds,
            observations: nextObservations,
          },
        };
      });
    },
    []
  );

  const resetToInitialData = useCallback(() => {
    const fresh = createInitialState();
    setState(fresh);
    respondentHydratedRef.current = true;
    setRespondentDatasetsState({});
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Ignore
    }
    void clearRespondentDatasets();
  }, []);

  return {
    period: state.period,
    kabKotaInputs: state.kabKotaInputs,
    nk0Meta: state.nk0Meta ?? {},
    allNodes: computed.allNodes,
    results: computed.results,
    jejerRows: computed.jejerRows,
    history: state.history,
    respondentDatasets,
    connectionStatus,
    supabaseError,
    availablePeriods,
    currentPeriodHasSupabaseData,
    setPeriod,
    applyMonthlyUpload,
    updateCommodityInput,
    rolloverPrevMonthNK,
    setRespondentDataset,
    updateRespondentAnnotation,
    resetToInitialData,
    refreshFromSupabase: () => refreshFromSupabase(stateRef.current.period, false),
  };
}
