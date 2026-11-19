import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Download,
  FileSpreadsheet,
  History,
  Layers,
  Loader2,
  Lock,
  RefreshCw,
  Save,
  Upload,
} from 'lucide-react';
import type {
  AdminRole,
  CommodityInputRow,
  HierarchyNodeMeta,
  KabKotaCode,
  Nk0RegionMeta,
  PeriodSelection,
  RegionCode,
  RegionLKResult,
  UpdateHistoryEntry,
  UploadFileKind,
  UploadMappingResult,
} from '../types/inflasi';
import type { SupabaseConnectionStatus } from '../lib/supabase';
import {
  formatPeriodLabel,
  getCurrentMonthLabel,
  getPrevMonthLabel,
  getRegionInfo,
  KAB_KOTA_CODES,
  REGIONS,
} from '../data/regions';
import {
  fillMissingPakomRhWith100,
  mapUploadedRowsToRegion,
  readSpreadsheetRows,
} from '../utils/excelParser';
import { formatNKCompact, formatNumber, formatSignedPct } from '../utils/formatters';
import { exportUploadTemplateWorkbook } from '../utils/excelExporter';

interface UpdateDataViewProps {
  period: PeriodSelection;
  selectedRegion: KabKotaCode;
  kabKotaInputs: Record<KabKotaCode, Record<string, CommodityInputRow>>;
  nk0Meta: Partial<Record<KabKotaCode, Nk0RegionMeta>>;
  allNodes: HierarchyNodeMeta[];
  results: Record<RegionCode, RegionLKResult>;
  history: UpdateHistoryEntry[];
  userRole: AdminRole;
  connectionStatus: SupabaseConnectionStatus;
  onSelectRegion: (code: RegionCode) => void;
  onApplyMonthlyUpload: (params: {
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
  }) => Promise<{ syncedToSupabase: boolean; savedRows: number; error?: string }>;
  onRolloverPrevMonth: (targetRegions: KabKotaCode[]) => Promise<{
    totalRolledRows: number;
    prevPeriod: PeriodSelection;
    perRegionCounts: Partial<Record<KabKotaCode, number>>;
  }>;
  onNavigateToLK: (code: RegionCode) => void;
}

type PreviewSortKey = 'KODE' | 'NAMA' | 'STATUS' | 'OLD' | 'NEW' | 'DIFF';

export const UpdateDataView: React.FC<UpdateDataViewProps> = ({
  period,
  selectedRegion,
  kabKotaInputs,
  nk0Meta,
  allNodes,
  results,
  history,
  userRole,
  connectionStatus,
  onSelectRegion,
  onApplyMonthlyUpload,
  onRolloverPrevMonth,
  onNavigateToLK,
}) => {
  const isProvinsi = userRole === 'PROVINSI';
  const targetRegion = selectedRegion;
  const targetMeta = getRegionInfo(targetRegion);
  const currentNk0Meta = nk0Meta[targetRegion];

  const [nk0Mapping, setNk0Mapping] = useState<UploadMappingResult | null>(null);
  const [nkMapping, setNkMapping] = useState<UploadMappingResult | null>(null);
  const [rhMapping, setRhMapping] = useState<UploadMappingResult | null>(null);

  const [nk0Error, setNk0Error] = useState<string | null>(null);
  const [nkError, setNkError] = useState<string | null>(null);
  const [rhError, setRhError] = useState<string | null>(null);

  const [activePreviewTab, setActivePreviewTab] = useState<UploadFileKind>('NK_PREV');
  const [showOnlyChanged, setShowOnlyChanged] = useState<boolean>(true);
  const [showUnmatched, setShowUnmatched] = useState<boolean>(false);
  const [fillEmptyRhWith100, setFillEmptyRhWith100] = useState<boolean>(true);
  const [resetUnlistedRhTo100, setResetUnlistedRhTo100] = useState<boolean>(true);
  const [syncPakomFromNk, setSyncPakomFromNk] = useState<boolean>(!currentNk0Meta?.isCustom);
  const [saveSuccessMsg, setSaveSuccessMsg] = useState<string | null>(null);
  const [saveErrorMsg, setSaveErrorMsg] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [isRollingOver, setIsRollingOver] = useState<boolean>(false);
  const [previewSortKey, setPreviewSortKey] = useState<PreviewSortKey>('DIFF');
  const [previewSortDir, setPreviewSortDir] = useState<'asc' | 'desc'>('desc');

  // Keep staged previews clean when top-bar region changes
  useEffect(() => {
    setNk0Mapping(null);
    setNkMapping(null);
    setRhMapping(null);
    setNk0Error(null);
    setNkError(null);
    setRhError(null);
    setSaveSuccessMsg(null);
    setSaveErrorMsg(null);
    setSyncPakomFromNk(!nk0Meta[targetRegion]?.isCustom);
  }, [targetRegion, nk0Meta]);

  if (!isProvinsi) {
    return (
      <section className="rounded-lg border border-slate-200 bg-white p-8 text-center">
        <Lock className="h-7 w-7 text-slate-400 mx-auto mb-2.5" />
        <h3 className="text-sm font-bold text-slate-900">
          Akses Unggah Data Khusus Admin Provinsi
        </h3>
        <p className="mt-1 text-xs text-slate-500 max-w-md mx-auto">
          Pembaruan database NK0 (Pakom), NK (N-1), dan RH (N) dikelola secara terpusat oleh Admin Provinsi (6100).
        </p>
      </section>
    );
  }

  const kabKotaList = REGIONS.filter((r) => !r.isAggregated);
  const currentPakomCount = Object.keys(kabKotaInputs[targetRegion] ?? {}).length;
  const prevMonthLabel = getPrevMonthLabel(period);
  const currMonthLabel = getCurrentMonthLabel(period);

  // Build effective inputs & nodes considering staged NK0 upload or NK Pakom sync in same batch
  const getEffectiveInputsAndNodes = (stagedNk0?: UploadMappingResult | null, stagedNk?: UploadMappingResult | null) => {
    const baseInputs = kabKotaInputs[targetRegion] ?? {};
    const activeNk0 = stagedNk0 !== undefined ? stagedNk0 : nk0Mapping;
    const activeNk = stagedNk !== undefined ? stagedNk : nkMapping;

    if (activeNk0?.pakomCodes) {
      const stagedInputs: Record<string, CommodityInputRow> = {};
      for (const kode of activeNk0.pakomCodes) {
        const val = activeNk0.updatesMap[kode] ?? 0;
        stagedInputs[kode] = baseInputs[kode]
          ? { ...baseInputs[kode], nk0: val }
          : { kode, nk0: val, nkPrev: val, rhCurrent: 100 };
      }
      return {
        effectiveInputs: stagedInputs,
        effectiveNodes: [...allNodes, ...(activeNk0.newHierarchyNodes ?? [])],
      };
    }

    if (activeNk?.pakomCodes && activeNk?.derivedNk0Map) {
      const stagedInputs: Record<string, CommodityInputRow> = {};
      for (const kode of activeNk.pakomCodes) {
        const prevRow = baseInputs[kode];
        const nk0Val = prevRow?.nk0 ?? activeNk.derivedNk0Map[kode] ?? 0;
        const nkPrevVal = activeNk.updatesMap[kode] ?? prevRow?.nkPrev ?? nk0Val;
        stagedInputs[kode] = prevRow
          ? { ...prevRow, nk0: nk0Val, nkPrev: nkPrevVal }
          : { kode, nk0: nk0Val, nkPrev: nkPrevVal, rhCurrent: 100 };
      }
      return {
        effectiveInputs: stagedInputs,
        effectiveNodes: [...allNodes, ...(activeNk.newHierarchyNodes ?? [])],
      };
    }

    return { effectiveInputs: baseInputs, effectiveNodes: allNodes };
  };

  const processUpload = async (
    fileOrText: File | string,
    fileName: string,
    kind: UploadFileKind
  ) => {
    setSaveSuccessMsg(null);
    if (kind === 'NK0') setNk0Error(null);
    else if (kind === 'NK_PREV') setNkError(null);
    else setRhError(null);

    try {
      const rows = await readSpreadsheetRows(fileOrText, fileName);
      const { effectiveInputs, effectiveNodes } =
        kind === 'NK0'
          ? { effectiveInputs: kabKotaInputs[targetRegion] ?? {}, effectiveNodes: allNodes }
          : kind === 'NK_PREV'
          ? getEffectiveInputsAndNodes(nk0Mapping, null)
          : getEffectiveInputsAndNodes();

      let mapped = mapUploadedRowsToRegion(
        rows,
        kind,
        fileName,
        effectiveInputs,
        effectiveNodes,
        {
          fillEmptyRhWith100,
          targetRegion,
          syncPakomFromNk: kind === 'NK_PREV' && !nk0Mapping ? syncPakomFromNk : false,
        }
      );

      if (kind === 'RH_CURRENT' && resetUnlistedRhTo100) {
        mapped = fillMissingPakomRhWith100(mapped, effectiveInputs, effectiveNodes);
      }

      if (kind === 'NK0') {
        setNk0Mapping(mapped);
        setActivePreviewTab('NK0');
      } else if (kind === 'NK_PREV') {
        setNkMapping(mapped);
        setActivePreviewTab('NK_PREV');
      } else {
        setRhMapping(mapped);
        setActivePreviewTab('RH_CURRENT');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Gagal membaca file Excel/CSV.';
      if (kind === 'NK0') setNk0Error(msg);
      else if (kind === 'NK_PREV') setNkError(msg);
      else setRhError(msg);
    }
  };

  const handleLoadSample = async (kind: UploadFileKind) => {
    const url =
      kind === 'NK0'
        ? '/assets/aistudio/nk0_6107_c95990e8.csv'
        : kind === 'NK_PREV'
        ? '/assets/aistudio/contoh_NK_bulan_sebelumnya_376b5d01.csv'
        : '/assets/aistudio/contoh_RH_bulan_berjalan_7b2b23d8.csv';
    const label =
      kind === 'NK0'
        ? 'nk0_6107.csv'
        : kind === 'NK_PREV'
        ? 'contoh_NK_bulan_sebelumnya.csv'
        : 'contoh_RH_bulan_berjalan.csv';

    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('File contoh tidak ditemukan.');
      const text = await res.text();
      await processUpload(text, label, kind);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Gagal memuat file contoh.';
      if (kind === 'NK0') setNk0Error(msg);
      else if (kind === 'NK_PREV') setNkError(msg);
      else setRhError(msg);
    }
  };

  const handleSaveUpdates = async () => {
    if (!nk0Mapping && !nkMapping && !rhMapping) return;

    const logs: Array<{
      kind: UpdateHistoryEntry['kind'];
      fileName: string;
      matchedCount: number;
      unmatchedCount: number;
    }> = [];

    if (nk0Mapping) {
      logs.push({
        kind: 'NK0',
        fileName: nk0Mapping.fileName,
        matchedCount: nk0Mapping.matchedCount,
        unmatchedCount: nk0Mapping.unmatchedCount,
      });
    }
    if (nkMapping) {
      logs.push({
        kind: 'NK_PREV',
        fileName: nkMapping.fileName,
        matchedCount: nkMapping.matchedCount,
        unmatchedCount: nkMapping.unmatchedCount,
      });
    }
    if (rhMapping) {
      logs.push({
        kind: 'RH_CURRENT',
        fileName: rhMapping.fileName,
        matchedCount: rhMapping.matchedCount,
        unmatchedCount: rhMapping.unmatchedCount,
      });
    }

    setIsSaving(true);
    setSaveErrorMsg(null);
    setSaveSuccessMsg(null);
    try {
      const syncResult = await onApplyMonthlyUpload({
        regionCode: targetRegion,
        period,
        nk0Update:
          nk0Mapping && nk0Mapping.pakomCodes
            ? {
                pakomCodes: nk0Mapping.pakomCodes,
                updatesMap: nk0Mapping.updatesMap,
                newHierarchyNodes: nk0Mapping.newHierarchyNodes,
                fileName: nk0Mapping.fileName,
              }
            : undefined,
        nkUpdates: nkMapping?.updatesMap,
        nkPrevPakomSync:
          !nk0Mapping && nkMapping?.pakomCodes && nkMapping?.derivedNk0Map
            ? {
                pakomCodes: nkMapping.pakomCodes,
                derivedNk0Map: nkMapping.derivedNk0Map,
                newHierarchyNodes: nkMapping.newHierarchyNodes,
                fileName: nkMapping.fileName,
              }
            : undefined,
        rhUpdates: rhMapping?.updatesMap,
        logs,
      });

      const syncSuffix = syncResult.syncedToSupabase
        ? ` Tersinkron ke Supabase (${syncResult.savedRows} baris inflasi_lk_data & inflasi_upload_logs).`
        : syncResult.error
        ? ` Tersimpan lokal (Supabase gagal: ${syncResult.error}).`
        : ' Tersimpan pada Mode Lokal.';

      setSaveSuccessMsg(
        `Berhasil memperbarui data ${targetRegion} (${targetMeta.shortName}) untuk periode ${formatPeriodLabel(
          period
        )} dan menghitung ulang agregasi Provinsi Kalimantan Barat (6100).${syncSuffix}`
      );
      setNk0Mapping(null);
      setNkMapping(null);
      setRhMapping(null);
    } catch (err) {
      setSaveErrorMsg(err instanceof Error ? err.message : 'Gagal menyimpan pembaruan data.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleRollover = async (regionsToRoll: KabKotaCode[]) => {
    setIsRollingOver(true);
    setSaveErrorMsg(null);
    setSaveSuccessMsg(null);
    try {
      const res = await onRolloverPrevMonth(regionsToRoll);
      setSaveSuccessMsg(
        `Berhasil menarik ${res.totalRolledRows} baris NK(N) = NK(N-1) × RH(N)/100 dari periode ${formatPeriodLabel(
          res.prevPeriod
        )} menjadi nk_n1 pada periode ${formatPeriodLabel(period)} di Supabase.`
      );
    } catch (err) {
      setSaveErrorMsg(err instanceof Error ? err.message : 'Gagal menarik data periode sebelumnya.');
    } finally {
      setIsRollingOver(false);
    }
  };

  const handleReplaceEmptyRhWith100 = () => {
    const { effectiveInputs, effectiveNodes } = getEffectiveInputsAndNodes();
    const filled = fillMissingPakomRhWith100(rhMapping, effectiveInputs, effectiveNodes);
    setRhMapping(filled);
    setActivePreviewTab('RH_CURRENT');
    setSaveSuccessMsg(null);
  };

  const activeMapping =
    activePreviewTab === 'NK0'
      ? nk0Mapping
      : activePreviewTab === 'NK_PREV'
      ? nkMapping
      : rhMapping;

  const togglePreviewSort = (key: PreviewSortKey) => {
    if (previewSortKey === key) {
      setPreviewSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setPreviewSortKey(key);
      setPreviewSortDir(key === 'KODE' || key === 'NAMA' || key === 'STATUS' ? 'asc' : 'desc');
    }
  };

  const renderPreviewSortIcon = (key: PreviewSortKey) => {
    if (previewSortKey !== key) return <ArrowUpDown className="h-3 w-3 opacity-35 shrink-0" />;
    return previewSortDir === 'asc' ? (
      <ArrowUp className="h-3 w-3 text-slate-900 shrink-0" />
    ) : (
      <ArrowDown className="h-3 w-3 text-slate-900 shrink-0" />
    );
  };

  const previewChanges = useMemo(() => {
    if (!activeMapping) return [];
    const list = activeMapping.changes.filter(
      (c) =>
        !showOnlyChanged ||
        c.pakomStatus === 'BARU' ||
        c.pakomStatus === 'DIHAPUS' ||
        Math.abs(c.diff) > 0.0001
    );
    return [...list].sort((a, b) => {
      if (previewSortKey === 'KODE') {
        const cmp = a.kode.localeCompare(b.kode);
        return previewSortDir === 'asc' ? cmp : -cmp;
      }
      if (previewSortKey === 'NAMA') {
        const cmp = a.nama.localeCompare(b.nama);
        return previewSortDir === 'asc' ? cmp : -cmp;
      }
      if (previewSortKey === 'STATUS') {
        const sa = a.pakomStatus ?? a.matchedBy;
        const sb = b.pakomStatus ?? b.matchedBy;
        const cmp = sa.localeCompare(sb);
        return previewSortDir === 'asc' ? cmp : -cmp;
      }
      if (previewSortKey === 'OLD') {
        const oa = a.oldValue ?? -Infinity;
        const ob = b.oldValue ?? -Infinity;
        return previewSortDir === 'desc' ? ob - oa : oa - ob;
      }
      if (previewSortKey === 'NEW') {
        return previewSortDir === 'desc' ? b.newValue - a.newValue : a.newValue - b.newValue;
      }
      return previewSortDir === 'desc'
        ? Math.abs(b.diff) - Math.abs(a.diff)
        : Math.abs(a.diff) - Math.abs(b.diff);
    });
  }, [activeMapping, showOnlyChanged, previewSortKey, previewSortDir]);

  return (
    <div className="space-y-6">
      {/* Step 1: Synchronized Context Banner + 5 Kab/Kota NK0 Status Strip */}
      <section className="rounded-lg border border-slate-200 bg-white p-5 space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <p className="text-xs font-mono font-semibold uppercase tracking-wider text-sky-700">
              PEMBARUAN BULANAN NK & RH · PAKOM NK0 TERSIMPAN PER WILAYAH
            </p>
            <h2 className="mt-1 text-lg font-extrabold tracking-tight text-slate-900">
              Update Data — {targetRegion} {targetMeta.name} ({formatPeriodLabel(period)})
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Target wilayah dan periode mengikuti filter tunggal di bilah atas. <strong>NK0 (Pakom Wilayah)</strong> tersimpan permanen di browser untuk seluruh 5 Kab/Kota; pembaruan bulanan cukup mengunggah <strong>NK ({prevMonthLabel})</strong> dan <strong>RH ({currMonthLabel})</strong>.
            </p>
          </div>

          <div className="shrink-0 rounded-md border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-xs font-mono">
            <div className="text-slate-500">Pakom Aktif ({targetRegion})</div>
            <div className="mt-0.5 font-bold text-slate-900">
              {currentPakomCount} komoditas · NK0 {formatNKCompact(results[targetRegion].umum.nk0)}
            </div>
            <div
              className={`mt-0.5 text-[11px] font-semibold ${
                currentNk0Meta?.isCustom ? 'text-emerald-700' : 'text-amber-700'
              }`}
            >
              {currentNk0Meta?.isCustom
                ? `NK0 Tersimpan (${currentNk0Meta.fileName})`
                : 'Belum upload NK0 wilayah ini'}
            </div>
          </div>
        </div>

        {/* 5 Kab/Kota Status Selector Strip (syncs directly with the single top filter) */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5 pt-2 border-t border-slate-100">
          {kabKotaList.map((reg) => {
            const kCode = reg.code as KabKotaCode;
            const isSelected = targetRegion === kCode;
            const meta = nk0Meta[kCode];
            const res = results[kCode];
            return (
              <button
                key={kCode}
                type="button"
                onClick={() => onSelectRegion(kCode)}
                className={`text-left rounded-md border p-3 transition-colors ${
                  isSelected
                    ? 'border-slate-900 bg-slate-900 text-white'
                    : 'border-slate-200 bg-white text-slate-900 hover:border-slate-400'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`font-mono text-xs font-bold ${
                      isSelected ? 'text-sky-300' : 'text-slate-500'
                    }`}
                  >
                    {kCode}
                  </span>
                  <span
                    className={`font-mono text-xs font-bold tabular-nums ${
                      isSelected
                        ? res.umum.inflasi >= 0
                          ? 'text-rose-300'
                          : 'text-emerald-300'
                        : res.umum.inflasi > 0.0005
                        ? 'text-rose-700'
                        : res.umum.inflasi < -0.0005
                        ? 'text-emerald-700'
                        : 'text-slate-600'
                    }`}
                  >
                    {formatSignedPct(res.umum.inflasi, 2)}
                  </span>
                </div>
                <div className="mt-0.5 text-xs font-bold truncate">{reg.shortName}</div>
                <div
                  className={`mt-1 text-[11px] font-mono ${
                    isSelected
                      ? 'text-slate-300'
                      : meta?.isCustom
                      ? 'text-emerald-700'
                      : 'text-amber-700'
                  }`}
                >
                  {res.pakomCount} kom · {meta?.isCustom ? 'NK0 Tersimpan' : 'Baseline Awal'}
                </div>
              </button>
            );
          })}
        </div>

        {/* Rollover Antarbulan Bar */}
        <div className="pt-2 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-slate-600">
            <span className="font-semibold text-slate-800">Rollover Antarbulan Supabase:</span>{' '}
            <span>
              Hitung <span className="font-mono">NK(N) = NK(N-1) × RH(N)/100</span> dari{' '}
              <strong>{prevMonthLabel}</strong> menjadi <strong>NK (N-1)</strong> periode{' '}
              <strong>{formatPeriodLabel(period)}</strong>.
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              disabled={isRollingOver || connectionStatus === 'local'}
              onClick={() => void handleRollover([targetRegion])}
              title={
                connectionStatus === 'local'
                  ? 'Membutuhkan koneksi Supabase aktif (VITE_SUPABASE_URL)'
                  : `Tarik NK (N) bulan lalu ke NK (N-1) untuk ${targetRegion}`
              }
              className="inline-flex items-center gap-1.5 rounded-md border border-sky-300 bg-sky-50 px-3 py-1.5 text-xs font-bold text-sky-900 hover:bg-sky-100 disabled:opacity-50 whitespace-nowrap"
            >
              {isRollingOver ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              <span>Tarik NK (N) Bulan Lalu → NK (N-1)</span>
            </button>
            <button
              type="button"
              disabled={isRollingOver || connectionStatus === 'local'}
              onClick={() => void handleRollover(KAB_KOTA_CODES)}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
            >
              <span>Rollover Semua 5 Kab/Kota</span>
            </button>
          </div>
        </div>

        {saveErrorMsg && (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 flex items-center gap-2 text-xs text-rose-900">
            <AlertTriangle className="h-4 w-4 text-rose-600 shrink-0" />
            <span>{saveErrorMsg}</span>
          </div>
        )}

        {saveSuccessMsg && (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs text-emerald-900 font-medium">
              <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
              <span>{saveSuccessMsg}</span>
            </div>
            <div className="flex items-center gap-3 text-xs font-mono">
              <span>
                {targetRegion}: <strong>{formatSignedPct(results[targetRegion].umum.inflasi, 2)}</strong>
              </span>
              <span>
                6100 Kalbar: <strong>{formatSignedPct(results['6100'].umum.inflasi, 2)}</strong>
              </span>
              <button
                type="button"
                onClick={() => onNavigateToLK(targetRegion)}
                className="font-sans font-semibold text-emerald-800 underline hover:text-emerald-950"
              >
                Lihat LK {targetRegion}
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Step 2: 3 Upload Cards (NK0/Pakom, NK Prev, RH Current) */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Card 1: Upload NK0 & Pakom */}
        <div className="rounded-lg border border-slate-200 bg-white p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-start justify-between gap-2">
              <div>
                <span className="text-[11px] font-mono font-semibold text-indigo-700">
                  MASTER WILAYAH · NK0=SBH2022
                </span>
                <h3 className="text-sm font-bold text-slate-900 mt-0.5">
                  Pakom & NK0 ({targetMeta.shortName})
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  Cukup diunggah sekali saat setup/perubahan Pakom. Tersimpan permanen untuk{' '}
                  <strong>{targetRegion}</strong> meskipun bulan berganti.
                </p>
              </div>
              <Layers className="h-5 w-5 text-indigo-600 shrink-0" />
            </div>

            <label className="mt-4 flex flex-col items-center justify-center rounded-md border border-dashed border-slate-300 bg-slate-50/60 px-4 py-5 text-center cursor-pointer hover:border-indigo-500 hover:bg-indigo-50/40 transition-colors">
              <Upload className="h-5 w-5 text-slate-400 mb-1.5" />
              <span className="text-xs font-semibold text-slate-800">
                Upload / Perbarui File NK0 ({targetRegion})
              </span>
              <span className="text-[11px] text-slate-500 mt-0.5">
                Mendukung file per kota maupun multi-wilayah (auto-filter {targetRegion})
              </span>
              <input
                type="file"
                accept=".csv,.xlsx,.xls"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void processUpload(file, file.name, 'NK0');
                  e.target.value = '';
                }}
              />
            </label>

            {nk0Error && (
              <div className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span>{nk0Error}</span>
              </div>
            )}

            {nk0Mapping && (
              <div className="mt-3 rounded-md border border-indigo-200 bg-indigo-50/70 px-3 py-2.5 text-xs text-slate-800 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold truncate">{nk0Mapping.fileName}</p>
                  <p className="text-[11px] text-slate-600 font-mono mt-0.5">
                    Pakom: <strong>{nk0Mapping.matchedCount}</strong> · +
                    {nk0Mapping.addedToPakomCount ?? 0} baru · -
                    {nk0Mapping.removedFromPakomCount ?? 0} keluar
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setActivePreviewTab('NK0')}
                  className="text-xs font-semibold text-indigo-800 underline shrink-0"
                >
                  Pratinjau
                </button>
              </div>
            )}
          </div>

          <div className="mt-4 pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => exportUploadTemplateWorkbook('NK0', results[targetRegion], period)}
              className="inline-flex items-center gap-1.5 rounded-md border border-indigo-300 bg-indigo-50 px-2.5 py-1 text-xs font-bold text-indigo-900 hover:bg-indigo-100 transition-colors"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Template NK0</span>
            </button>
            {targetRegion === '6107' && (
              <button
                type="button"
                onClick={() => void handleLoadSample('NK0')}
                className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                Muat Contoh 6107
              </button>
            )}
          </div>
        </div>

        {/* Card 2: Upload NK Bulan Sebelumnya */}
        <div className="rounded-lg border border-slate-200 bg-white p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-start justify-between gap-2">
              <div>
                <span className="text-[11px] font-mono font-semibold text-sky-700">
                  UPDATE BULANAN 1 · NK ({prevMonthLabel.toUpperCase()})
                </span>
                <h3 className="text-sm font-bold text-slate-900 mt-0.5">
                  Upload NK Bulan Sebelumnya ({targetMeta.shortName})
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  Membaca kolom <code className="font-mono bg-slate-100 px-1 rounded">NK</code> (termasuk NK {prevMonthLabel} / NK N-1). Otomatis menyaring baris{' '}
                  <strong>{targetRegion}</strong> jika ada kolom Kode Kota.
                </p>
              </div>
              <FileSpreadsheet className="h-5 w-5 text-sky-600 shrink-0" />
            </div>

            <label className="mt-4 flex flex-col items-center justify-center rounded-md border border-dashed border-slate-300 bg-slate-50/60 px-4 py-5 text-center cursor-pointer hover:border-sky-500 hover:bg-sky-50/40 transition-colors">
              <Upload className="h-5 w-5 text-slate-400 mb-1.5" />
              <span className="text-xs font-semibold text-slate-800">
                Pilih file .xlsx / .csv (NK {prevMonthLabel})
              </span>
              <span className="text-[11px] text-slate-500 mt-0.5">
                Mendukung pemisah titik koma (;), koma (,), & multi-wilayah
              </span>
              <input
                type="file"
                accept=".csv,.xlsx,.xls"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void processUpload(file, file.name, 'NK_PREV');
                  e.target.value = '';
                }}
              />
            </label>

            <label className="mt-3 inline-flex items-start gap-2 text-[11px] font-medium text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={syncPakomFromNk}
                onChange={(e) => setSyncPakomFromNk(e.target.checked)}
                className="mt-0.5 rounded border-slate-300"
              />
              <span>
                Sinkronkan Pakom dari file NK ini (pakai NK0 tersimpan, atau hitung NK0=NK/IHK jika belum ada)
              </span>
            </label>

            {nkError && (
              <div className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span>{nkError}</span>
              </div>
            )}

            {nkMapping && (
              <div className="mt-3 rounded-md border border-sky-200 bg-sky-50/70 px-3 py-2.5 text-xs text-slate-800 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold truncate">{nkMapping.fileName}</p>
                  <p className="text-[11px] text-slate-600 font-mono mt-0.5">
                    Cocok: <strong>{nkMapping.matchedCount}</strong>
                    {nkMapping.filteredRegionCode && ` · Filter ${nkMapping.filteredRegionCode}`} ·
                    Unmatched: <strong>{nkMapping.unmatchedCount}</strong>
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setActivePreviewTab('NK_PREV')}
                  className="text-xs font-semibold text-sky-800 underline shrink-0"
                >
                  Pratinjau
                </button>
              </div>
            )}
          </div>

          <div className="mt-4 pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => exportUploadTemplateWorkbook('NK_PREV', results[targetRegion], period)}
              className="inline-flex items-center gap-1.5 rounded-md border border-sky-300 bg-sky-50 px-2.5 py-1 text-xs font-bold text-sky-900 hover:bg-sky-100 transition-colors"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Template NK</span>
            </button>
            {targetRegion === '6107' && (
              <button
                type="button"
                onClick={() => void handleLoadSample('NK_PREV')}
                className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                Muat Contoh 6107
              </button>
            )}
          </div>
        </div>

        {/* Card 3: Upload RH Bulan Berjalan */}
        <div className="rounded-lg border border-slate-200 bg-white p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-start justify-between gap-2">
              <div>
                <span className="text-[11px] font-mono font-semibold text-amber-700">
                  UPDATE BULANAN 2 · RH ({currMonthLabel.toUpperCase()})
                </span>
                <h3 className="text-sm font-bold text-slate-900 mt-0.5">
                  Upload RH Bulan Berjalan ({targetMeta.shortName})
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  Membaca kolom <code className="font-mono bg-slate-100 px-1 rounded">RH</code> (termasuk RH {currMonthLabel} / RH N) dan menghitung ulang inflasi & andil {targetRegion}.
                </p>
              </div>
              <FileSpreadsheet className="h-5 w-5 text-amber-600 shrink-0" />
            </div>

            <label className="mt-4 flex flex-col items-center justify-center rounded-md border border-dashed border-slate-300 bg-slate-50/60 px-4 py-5 text-center cursor-pointer hover:border-amber-500 hover:bg-amber-50/40 transition-colors">
              <Upload className="h-5 w-5 text-slate-400 mb-1.5" />
              <span className="text-xs font-semibold text-slate-800">
                Pilih file .xlsx / .csv (RH {currMonthLabel})
              </span>
              <span className="text-[11px] text-slate-500 mt-0.5">
                Normalisasi kode 6/7-digit & filter wilayah {targetRegion}
              </span>
              <input
                type="file"
                accept=".csv,.xlsx,.xls"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void processUpload(file, file.name, 'RH_CURRENT');
                  e.target.value = '';
                }}
              />
            </label>

            {rhError && (
              <div className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span>{rhError}</span>
              </div>
            )}

            {rhMapping && (
              <div className="mt-3 rounded-md border border-amber-200 bg-amber-50/70 px-3 py-2.5 text-xs text-slate-800 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold truncate">{rhMapping.fileName}</p>
                  <p className="text-[11px] text-slate-600 font-mono mt-0.5">
                    Cocok: <strong>{rhMapping.matchedCount}</strong>
                    {(rhMapping.replacedEmptyCount ?? 0) > 0 && (
                      <>
                        {' '}
                        · <strong>{rhMapping.replacedEmptyCount}</strong> → 100
                      </>
                    )}{' '}
                    · Unmatched: <strong>{rhMapping.unmatchedCount}</strong>
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setActivePreviewTab('RH_CURRENT')}
                  className="text-xs font-semibold text-amber-800 underline shrink-0"
                >
                  Pratinjau
                </button>
              </div>
            )}

            <div className="mt-3 space-y-1.5">
              <label className="flex items-center gap-1.5 text-[11px] font-medium text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={fillEmptyRhWith100}
                  onChange={(e) => setFillEmptyRhWith100(e.target.checked)}
                  className="rounded border-slate-300"
                />
                <span>Otomatis isi sel RH kosong/0 = 100</span>
              </label>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="flex items-center gap-1.5 text-[11px] font-medium text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={resetUnlistedRhTo100}
                    onChange={(e) => setResetUnlistedRhTo100(e.target.checked)}
                    className="rounded border-slate-300"
                  />
                  <span>Reset Pakom di luar file RH = 100</span>
                </label>

                <button
                  type="button"
                  onClick={handleReplaceEmptyRhWith100}
                  className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] font-bold text-amber-900 hover:bg-amber-100 transition-colors"
                >
                  Replace Kosong → 100
                </button>
              </div>
            </div>
          </div>

          <div className="mt-4 pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => exportUploadTemplateWorkbook('RH_CURRENT', results[targetRegion], period)}
              className="inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-bold text-amber-900 hover:bg-amber-100 transition-colors"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Template RH</span>
            </button>
            {targetRegion === '6107' && (
              <button
                type="button"
                onClick={() => void handleLoadSample('RH_CURRENT')}
                className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                Muat Contoh 6107
              </button>
            )}
          </div>
        </div>
      </section>

      {/* Step 3: Mapping Validation Log & Diff Preview */}
      {(nk0Mapping || nkMapping || rhMapping) && (
        <section className="rounded-lg border border-slate-300 bg-white overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-4">
            <div>
              <h3 className="text-sm font-bold text-slate-900">
                Pratinjau & Validasi Hasil Mapping ({targetRegion} — {targetMeta.shortName})
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Periksa perubahan untuk periode <strong>{formatPeriodLabel(period)}</strong> sebelum menyimpan dan menghitung ulang Provinsi Kalimantan Barat (6100).
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {nk0Mapping && (
                <button
                  type="button"
                  onClick={() => setActivePreviewTab('NK0')}
                  className={`rounded-md px-3 py-1.5 text-xs font-semibold border transition-colors ${
                    activePreviewTab === 'NK0'
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                  }`}
                >
                  Preview NK0 ({nk0Mapping.matchedCount})
                </button>
              )}
              {nkMapping && (
                <button
                  type="button"
                  onClick={() => setActivePreviewTab('NK_PREV')}
                  className={`rounded-md px-3 py-1.5 text-xs font-semibold border transition-colors ${
                    activePreviewTab === 'NK_PREV'
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                  }`}
                >
                  Preview NK ({nkMapping.matchedCount})
                </button>
              )}
              {rhMapping && (
                <button
                  type="button"
                  onClick={() => setActivePreviewTab('RH_CURRENT')}
                  className={`rounded-md px-3 py-1.5 text-xs font-semibold border transition-colors ${
                    activePreviewTab === 'RH_CURRENT'
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                  }`}
                >
                  Preview RH ({rhMapping.matchedCount})
                </button>
              )}
              {activePreviewTab === 'RH_CURRENT' && (
                <button
                  type="button"
                  onClick={handleReplaceEmptyRhWith100}
                  className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-bold text-amber-900 hover:bg-amber-100 transition-colors"
                >
                  Replace Kosong → 100
                </button>
              )}
              <button
                type="button"
                disabled={isSaving}
                onClick={() => void handleSaveUpdates()}
                className="inline-flex items-center gap-1.5 rounded-md bg-sky-700 px-4 py-1.5 text-xs font-semibold text-white hover:bg-sky-800 disabled:opacity-60 transition-colors"
              >
                {isSaving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="h-3.5 w-3.5" />
                )}
                <span>{isSaving ? 'Menyimpan...' : 'Simpan & Hitung Ulang LK'}</span>
              </button>
            </div>
          </div>

          {activeMapping && (
            <div className="p-5 space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="rounded-md border border-slate-200 p-3">
                  <span className="text-[11px] text-slate-500 block">Header Terdeteksi</span>
                  <span className="text-sm font-mono font-bold text-slate-900">
                    Baris ke-{activeMapping.detectedHeaderRow}
                  </span>
                </div>
                <div className="rounded-md border border-slate-200 p-3">
                  <span className="text-[11px] text-slate-500 block">Total Baris Komoditas</span>
                  <span className="text-sm font-mono font-bold text-slate-900">
                    {activeMapping.totalParsedRows}
                    {activeMapping.filteredRegionCode ? ` (${activeMapping.filteredRegionCode})` : ''}
                  </span>
                </div>
                <div className="rounded-md border border-emerald-200 bg-emerald-50/50 p-3">
                  <span className="text-[11px] text-emerald-700 block">
                    {activeMapping.kind === 'NK0' || activeMapping.pakomCodes
                      ? 'Komoditas Pakom'
                      : 'Berhasil Di-mapping'}
                  </span>
                  <span className="text-sm font-mono font-bold text-emerald-800">
                    {activeMapping.matchedCount} komoditas
                  </span>
                </div>
                <div className="rounded-md border border-slate-200 p-3">
                  <span className="text-[11px] text-slate-500 block">
                    {activeMapping.kind === 'NK0' || activeMapping.pakomCodes
                      ? 'Perubahan Pakom'
                      : 'Tidak Cocok (Unmatched)'}
                  </span>
                  <span className="text-sm font-mono font-bold text-slate-800">
                    {activeMapping.kind === 'NK0' || activeMapping.pakomCodes
                      ? `+${activeMapping.addedToPakomCount ?? 0} / -${activeMapping.removedFromPakomCount ?? 0}`
                      : `${activeMapping.unmatchedCount} baris`}
                  </span>
                </div>
              </div>

              {activeMapping.unmatchedCount > 0 && (
                <div className="rounded-md border border-amber-200 bg-amber-50/60 p-3">
                  <button
                    type="button"
                    onClick={() => setShowUnmatched((v) => !v)}
                    className="w-full flex items-center justify-between text-xs font-semibold text-amber-900"
                  >
                    <span className="flex items-center gap-1.5">
                      <AlertTriangle className="h-4 w-4 text-amber-600" />
                      {activeMapping.unmatchedCount} baris dilewati/unmatched — lihat detail
                    </span>
                    {showUnmatched ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </button>
                  {showUnmatched && (
                    <div className="mt-2 max-h-40 overflow-y-auto border-t border-amber-200 pt-2 space-y-1 text-xs font-mono">
                      {activeMapping.unmatchedRows.map((u, idx) => (
                        <div key={idx} className="flex justify-between gap-4 text-amber-950">
                          <span>
                            Baris {u.sourceRowIndex}: [{u.rawCode}] {u.namaKomoditas}
                          </span>
                          <span className="text-amber-700">{u.reason}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div className="flex items-center justify-between">
                <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={showOnlyChanged}
                    onChange={(e) => setShowOnlyChanged(e.target.checked)}
                    className="rounded border-slate-300"
                  />
                  <span>Tampilkan hanya baris dengan perubahan nilai/pakom ({previewChanges.length})</span>
                </label>
                <span className="text-[11px] font-mono text-slate-500">
                  File: {activeMapping.fileName}
                </span>
              </div>

              <div className="overflow-x-auto max-h-72 border border-slate-200 rounded-md">
                <table className="w-full text-left border-collapse text-xs">
                  <thead className="sticky top-0 bg-slate-100 border-b border-slate-200 text-[11px] font-bold text-slate-700 select-none">
                    <tr>
                      <th
                        onClick={() => togglePreviewSort('KODE')}
                        className="py-2 px-3 cursor-pointer hover:bg-slate-200/70 whitespace-nowrap"
                      >
                        <span className="inline-flex items-center gap-1">
                          Kode {renderPreviewSortIcon('KODE')}
                        </span>
                      </th>
                      <th
                        onClick={() => togglePreviewSort('NAMA')}
                        className="py-2 px-3 cursor-pointer hover:bg-slate-200/70"
                      >
                        <span className="inline-flex items-center gap-1">
                          Komoditas {renderPreviewSortIcon('NAMA')}
                        </span>
                      </th>
                      <th
                        onClick={() => togglePreviewSort('STATUS')}
                        className="py-2 px-3 cursor-pointer hover:bg-slate-200/70 whitespace-nowrap"
                      >
                        <span className="inline-flex items-center gap-1">
                          Status {renderPreviewSortIcon('STATUS')}
                        </span>
                      </th>
                      <th
                        onClick={() => togglePreviewSort('OLD')}
                        className="py-2 px-3 text-right cursor-pointer hover:bg-slate-200/70 whitespace-nowrap"
                      >
                        <span className="inline-flex items-center justify-end gap-1">
                          Nilai Lama {renderPreviewSortIcon('OLD')}
                        </span>
                      </th>
                      <th
                        onClick={() => togglePreviewSort('NEW')}
                        className="py-2 px-3 text-right cursor-pointer hover:bg-slate-200/70 whitespace-nowrap"
                      >
                        <span className="inline-flex items-center justify-end gap-1">
                          Nilai Baru {renderPreviewSortIcon('NEW')}
                        </span>
                      </th>
                      <th
                        onClick={() => togglePreviewSort('DIFF')}
                        className="py-2 px-3 text-right cursor-pointer hover:bg-slate-200/70 whitespace-nowrap"
                      >
                        <span className="inline-flex items-center justify-end gap-1">
                          Selisih {renderPreviewSortIcon('DIFF')}
                        </span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {previewChanges.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-6 text-center text-slate-500">
                          Semua nilai sama persis dengan data saat ini (tidak ada selisih).
                        </td>
                      </tr>
                    ) : (
                      previewChanges.slice(0, 120).map((c) => (
                        <tr key={`${c.kode}-${c.pakomStatus ?? ''}`} className="hover:bg-slate-50">
                          <td className="py-1.5 px-3 font-mono text-slate-500">{c.kode}</td>
                          <td className="py-1.5 px-3 font-medium text-slate-800">{c.nama}</td>
                          <td className="py-1.5 px-3 font-mono text-[11px]">
                            {c.pakomStatus ? (
                              <span
                                className={
                                  c.pakomStatus === 'BARU'
                                    ? 'text-emerald-700 font-semibold'
                                    : c.pakomStatus === 'DIHAPUS'
                                    ? 'text-rose-700 font-semibold'
                                    : 'text-slate-500'
                                }
                              >
                                {c.pakomStatus}
                              </span>
                            ) : c.replacedEmpty ? (
                              <span className="text-amber-700 font-bold">KOSONG → 100</span>
                            ) : (
                              <span className="text-slate-500">{c.matchedBy}</span>
                            )}
                          </td>
                          <td className="py-1.5 px-3 text-right font-mono tabular-nums text-slate-600">
                            {c.oldValue !== null
                              ? formatNumber(c.oldValue, activeMapping.kind === 'RH_CURRENT' ? 4 : 2)
                              : '—'}
                          </td>
                          <td className="py-1.5 px-3 text-right font-mono tabular-nums font-semibold text-slate-900">
                            {c.pakomStatus === 'DIHAPUS'
                              ? 'Dihapus'
                              : formatNumber(c.newValue, activeMapping.kind === 'RH_CURRENT' ? 4 : 2)}
                          </td>
                          <td
                            className={`py-1.5 px-3 text-right font-mono tabular-nums font-semibold ${
                              c.diff > 0
                                ? 'text-rose-700'
                                : c.diff < 0
                                ? 'text-emerald-700'
                                : 'text-slate-500'
                            }`}
                          >
                            {c.diff > 0 ? '+' : ''}
                            {formatNumber(c.diff, activeMapping.kind === 'RH_CURRENT' ? 4 : 2)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      )}

      {/* Update History Log */}
      <section className="rounded-lg border border-slate-200 bg-white overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-200 flex items-center justify-between">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700 flex items-center gap-1.5">
            <History className="h-3.5 w-3.5 text-slate-500" />
            <span>
              Riwayat Pembaruan Database {connectionStatus === 'local' ? 'Lokal' : 'Supabase'}
            </span>
          </h3>
          <span className="text-[11px] font-mono text-slate-500">{history.length} entri</span>
        </div>
        {history.length === 0 ? (
          <div className="p-6 text-center text-xs text-slate-500">
            Belum ada unggahan pembaruan pada periode ini. Unggah file NK0/NK/RH di atas sesuai wilayah pada filter atas.
          </div>
        ) : (
          <div className="divide-y divide-slate-100 text-xs">
            {history.map((h) => {
              const kindLabel =
                h.kind === 'NK0'
                  ? 'NK0 & Pakom'
                  : h.kind === 'NK_PREV'
                  ? 'NK (N-1)'
                  : h.kind === 'RH_CURRENT'
                  ? 'RH (N)'
                  : h.kind === 'ROLLOVER'
                  ? 'Rollover'
                  : h.kind === 'RESPONDEN_SYNC'
                  ? 'Sync Responden'
                  : 'Edit Inline';
              return (
                <div key={h.id} className="px-5 py-2.5 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-3">
                    <span className="font-mono font-semibold text-slate-900">{h.regionCode}</span>
                    <span className="font-mono text-[11px] text-slate-600">{kindLabel}</span>
                    <span className="font-medium text-slate-800">{h.fileName}</span>
                  </div>
                  <div className="flex items-center gap-4 font-mono text-[11px] text-slate-600">
                    <span>{formatPeriodLabel(h.period)}</span>
                    <span className="text-emerald-700">{h.matchedCount} matched</span>
                    {h.unmatchedCount > 0 && (
                      <span className="text-amber-700">{h.unmatchedCount} unmatched</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};
