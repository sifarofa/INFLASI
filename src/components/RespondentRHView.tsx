import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CheckCircle2,
  Download,
  Eye,
  EyeOff,
  FileSpreadsheet,
  Flag,
  Layers,
  Loader2,
  RotateCcw,
  Search,
  Upload,
} from 'lucide-react';
import type {
  AdminRole,
  KabKotaCode,
  PeriodSelection,
  RegionCode,
  RespondentFrequency,
  RespondentPriceObservation,
  RespondentRHDataset,
} from '../types/inflasi';
import { formatPeriodLabel, getRegionInfo } from '../data/regions';
import {
  parseRespondentObservations,
  readSpreadsheetRows,
  summarizeRespondentRH,
} from '../utils/excelParser';
import {
  exportRespondentAnalysisWorkbook,
  exportRespondentTemplateWorkbook,
} from '../utils/excelExporter';
import { formatIndex, formatNumber, formatSignedPct } from '../utils/formatters';

interface RespondentRHViewProps {
  period: PeriodSelection;
  selectedRegion: KabKotaCode;
  datasets: Record<string, RespondentRHDataset>;
  userRole: AdminRole;
  allowedRegion: RegionCode;
  onSetDataset: (
    frequency: RespondentFrequency,
    dataset: RespondentRHDataset
  ) => Promise<{ syncedToSupabase: boolean; savedRows: number; error?: string }>;
  onUpdateObservationAnnotation?: (
    regionCode: KabKotaCode,
    frequency: RespondentFrequency,
    observationId: string,
    patch: { catatan?: string; perluPerbaikan?: boolean }
  ) => void;
  onUpdateObservationPrice?: (
    regionCode: KabKotaCode,
    frequency: RespondentFrequency,
    observationId: string,
    priceIndex: number,
    nextValue: number | null
  ) => void;
  onResetObservationPrice?: (
    regionCode: KabKotaCode,
    frequency: RespondentFrequency,
    observationId: string
  ) => void;
  onApplyCalculatedRhToLK?: (
    regionCode: KabKotaCode,
    rhUpdates: Record<string, number>,
    sourceLabel: string
  ) => Promise<{ syncedToSupabase: boolean; savedRows: number; error?: string }>;
}

const ObservationNoteInput: React.FC<{
  value: string;
  highlighted?: boolean;
  onCommit: (nextNote: string) => void;
}> = ({ value, highlighted, onCommit }) => {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const commit = () => {
    if (draft !== value) {
      onCommit(draft);
    }
  };

  return (
    <input
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          setDraft(value);
          e.currentTarget.blur();
        }
      }}
      placeholder="Tulis catatan perbaikan..."
      aria-label="Catatan perbaikan responden"
      className={`w-full rounded border px-2 py-1 text-[11px] font-medium text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-1 ${
        highlighted
          ? 'border-indigo-300 bg-white focus:border-indigo-600 focus:ring-indigo-500/30'
          : 'border-slate-300 bg-white focus:border-slate-800 focus:ring-slate-500/20'
      }`}
    />
  );
};

const EditablePriceInput: React.FC<{
  value: number | null;
  edited?: boolean;
  align?: 'center' | 'right';
  ariaLabel: string;
  onCommit: (nextValue: number | null) => void;
}> = ({ value, edited, align = 'center', ariaLabel, onCommit }) => {
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState<string>(value ? String(value) : '');

  useEffect(() => {
    if (!focused) {
      setDraft(value ? String(value) : '');
    }
  }, [value, focused]);

  const commit = () => {
    setFocused(false);
    const cleaned = draft.trim().replace(/\s+/g, '');
    if (!cleaned) {
      if (value !== null) onCommit(null);
      return;
    }
    const normalized =
      cleaned.includes('.') && !cleaned.includes(',') && /^\d{1,3}(\.\d{3})+$/.test(cleaned)
        ? Number(cleaned.replace(/\./g, ''))
        : Number(cleaned.replace(/,/g, '.'));
    if (!Number.isFinite(normalized) || normalized <= 0) {
      setDraft(value ? String(value) : '');
      return;
    }
    if (value === null || Math.abs(normalized - value) > 0.0001) {
      onCommit(normalized);
    }
  };

  const displayText = focused ? draft : value ? formatNumber(value, 0) : '—';

  return (
    <input
      type="text"
      inputMode="numeric"
      aria-label={ariaLabel}
      value={displayText}
      onFocus={(e) => {
        setFocused(true);
        setDraft(value ? String(value) : '');
        requestAnimationFrame(() => e.target.select());
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          setDraft(value ? String(value) : '');
          setFocused(false);
          e.currentTarget.blur();
        }
      }}
      className={`w-full rounded px-0.5 py-0 font-mono tabular-nums bg-transparent focus:bg-white focus:outline-none focus:ring-1 focus:ring-indigo-500 ${
        align === 'right' ? 'text-right text-[11.5px]' : 'text-center text-[10px]'
      } ${
        edited
          ? 'font-extrabold text-indigo-900'
          : value
          ? 'font-bold text-slate-950'
          : 'font-medium text-slate-400 focus:text-slate-950'
      }`}
    />
  );
};

const FREQUENCY_META: Record<
  RespondentFrequency,
  {
    label: string;
    subtitle: string;
    periodCols: string[];
    sampleUrl: string;
    sampleFileName: string;
  }
> = {
  MINGGUAN: {
    label: 'Mingguan (HK-1.1 / HK-1.2)',
    subtitle: 'Analisis RH harga tingkat responden pencacahan mingguan (M1–M5).',
    periodCols: ['M1', 'M2', 'M3', 'M4', 'M5'],
    sampleUrl: '/assets/aistudio/Tabel_Harga_per_Responden__Mingguan__526e5501.csv',
    sampleFileName: 'Tabel_Harga_per_Responden__Mingguan.csv',
  },
  DWIMINGGUAN: {
    label: 'Dwimingguan (HK-1.2 / HK-2.1)',
    subtitle: 'Analisis RH harga tingkat responden pencacahan dwimingguan (M1 & M3).',
    periodCols: ['M1', 'M3'],
    sampleUrl: '/assets/aistudio/Tabel_Harga_per_Responden__Dwimingguan__13e09b96.csv',
    sampleFileName: 'Tabel_Harga_per_Responden__Dwimingguan.csv',
  },
  BULANAN: {
    label: 'Bulanan (HK-2.1 / HK-2.2 / HK-3)',
    subtitle: 'Analisis RH harga tingkat responden pencacahan bulanan.',
    periodCols: ['Bln'],
    sampleUrl: '/assets/aistudio/Tabel_Harga_per_Responden__Bulanan__a65d147f.csv',
    sampleFileName: 'Tabel_Harga_per_Responden__Bulanan.csv',
  },
};

type MovementFilter = 'ALL' | 'UP' | 'DOWN' | 'FLAT' | 'MISSING' | 'FLAGGED';
type TableViewMode = 'OBSERVATIONS' | 'COMMODITY_SUMMARY';
type RespSortKey =
  | 'KOMODITAS'
  | 'KUALITAS'
  | 'PASAR'
  | 'RESPONDEN'
  | `PREV_${number}`
  | `CURR_${number}`
  | 'AVG_PREV'
  | 'AVG_CURR'
  | 'RH'
  | 'FLAGGED';

export const RespondentRHView: React.FC<RespondentRHViewProps> = ({
  period,
  selectedRegion,
  datasets,
  userRole,
  allowedRegion,
  onSetDataset,
  onUpdateObservationAnnotation,
  onUpdateObservationPrice,
  onResetObservationPrice,
  onApplyCalculatedRhToLK,
}) => {
  const isProvinsi = userRole === 'PROVINSI';
  const targetRegion: KabKotaCode = isProvinsi
    ? selectedRegion
    : (allowedRegion as KabKotaCode);
  const targetMeta = getRegionInfo(targetRegion);

  const [frequency, setFrequency] = useState<RespondentFrequency>('MINGGUAN');
  const [tableView, setTableView] = useState<TableViewMode>('OBSERVATIONS');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [commodityFilter, setCommodityFilter] = useState<string>('ALL');
  const [marketTypeFilter, setMarketTypeFilter] = useState<string>('ALL');
  const [movementFilter, setMovementFilter] = useState<MovementFilter>('ALL');
  const [sortKey, setSortKey] = useState<RespSortKey>('RH');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [hidePrevPrice, setHidePrevPrice] = useState<boolean>(false);
  const [pageSize, setPageSize] = useState<number>(50);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [applySuccessMsg, setApplySuccessMsg] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isSyncingToLK, setIsSyncingToLK] = useState<boolean>(false);
  const [autoFillEmptyRh100, setAutoFillEmptyRh100] = useState<boolean>(true);

  useEffect(() => {
    setCommodityFilter('ALL');
    setMarketTypeFilter('ALL');
    setMovementFilter('ALL');
    setCurrentPage(1);
    setErrorMsg(null);
    setApplySuccessMsg(null);
  }, [targetRegion]);

  const meta = FREQUENCY_META[frequency];
  const datasetKey = `${targetRegion}_${frequency}`;
  const currentDataset = datasets[datasetKey];

  const handleParseFile = async (fileOrText: File | string, fileName: string) => {
    if (!isProvinsi) return;
    setErrorMsg(null);
    setApplySuccessMsg(null);
    setIsLoading(true);
    try {
      const rawRows = await readSpreadsheetRows(fileOrText, fileName);
      const parsed = parseRespondentObservations(rawRows, frequency, targetRegion);
      const observations = autoFillEmptyRh100
        ? parsed.map((o) => (o.priceRelative === null ? { ...o, priceRelative: 100 } : o))
        : parsed;
      const commoditySummaries = summarizeRespondentRH(observations, frequency);

      const syncRes = await onSetDataset(frequency, {
        regionCode: targetRegion,
        period,
        frequency,
        fileName,
        loadedAt: new Date().toISOString(),
        observations,
        commoditySummaries,
      });

      if (syncRes.syncedToSupabase) {
        setApplySuccessMsg(
          `Data harga responden ${frequency} (${syncRes.savedRows} observasi) berhasil disimpan ke Supabase (inflasi_harga_responden).`
        );
      } else if (syncRes.error) {
        setErrorMsg(`Tersimpan lokal, gagal sinkron ke Supabase: ${syncRes.error}`);
      }

      setCommodityFilter('ALL');
      setMarketTypeFilter('ALL');
      setMovementFilter('ALL');
      setCurrentPage(1);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gagal memproses file responden.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleReplaceMissingWith100 = async () => {
    if (!isProvinsi || !currentDataset) return;
    const updatedObs = currentDataset.observations.map((o) =>
      o.priceRelative === null ? { ...o, priceRelative: 100 } : o
    );
    const updatedSummaries = summarizeRespondentRH(updatedObs, frequency);
    await onSetDataset(frequency, {
      ...currentDataset,
      observations: updatedObs,
      commoditySummaries: updatedSummaries,
    });
    if (movementFilter === 'MISSING') setMovementFilter('ALL');
  };

  const handleLoadSample = async () => {
    if (!isProvinsi) return;
    setErrorMsg(null);
    setIsLoading(true);
    try {
      const res = await fetch(meta.sampleUrl);
      if (!res.ok) throw new Error('Template CSV responden tidak ditemukan.');
      const text = await res.text();
      await handleParseFile(text, meta.sampleFileName);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gagal memuat template responden.');
      setIsLoading(false);
    }
  };

  const handleApplyToLK = async () => {
    if (!isProvinsi || !currentDataset || !onApplyCalculatedRhToLK) return;
    const updates: Record<string, number> = {};
    for (const sum of currentDataset.commoditySummaries) {
      if (sum.calculatedRH !== null && sum.calculatedRH > 0) {
        updates[sum.kodeKomoditas] = sum.calculatedRH;
      }
    }
    const count = Object.keys(updates).length;
    if (count === 0) return;

    setIsSyncingToLK(true);
    setErrorMsg(null);
    setApplySuccessMsg(null);
    try {
      const res = await onApplyCalculatedRhToLK(
        targetRegion,
        updates,
        `Responden_${frequency}_${currentDataset.fileName ?? 'data'}`
      );
      const syncSuffix = res.syncedToSupabase
        ? ' Pembaruan kolom rh_n pada inflasi_lk_data Supabase berhasil.'
        : res.error
        ? ` (Catatan Supabase: ${res.error})`
        : '';
      setApplySuccessMsg(
        `Berhasil menerapkan RH hierarki BPS (${count} komoditas ${frequency}) ke Lembar Kerja ${targetRegion} (${targetMeta.shortName}).${syncSuffix}`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gagal menyinkronkan RH ke LK.');
    } finally {
      setIsSyncingToLK(false);
    }
  };

  const stats = useMemo(() => {
    const obs = currentDataset?.observations ?? [];
    let up = 0;
    let down = 0;
    let flat = 0;
    let missing = 0;
    let flagged = 0;
    for (const o of obs) {
      if (o.perluPerbaikan || o.hargaDiperbaiki) flagged++;
      if (o.priceRelative === null) missing++;
      else if (o.priceRelative > 100.001) up++;
      else if (o.priceRelative < 99.999) down++;
      else flat++;
    }
    return { total: obs.length, up, down, flat, missing, flagged };
  }, [currentDataset]);

  const flaggedCountByCommodity = useMemo(() => {
    const map: Record<string, number> = {};
    for (const o of currentDataset?.observations ?? []) {
      if (o.perluPerbaikan || o.hargaDiperbaiki) {
        map[o.kodeKomoditas] = (map[o.kodeKomoditas] ?? 0) + 1;
      }
    }
    return map;
  }, [currentDataset]);

  const marketTypes = useMemo(() => {
    const obs = currentDataset?.observations ?? [];
    return Array.from(new Set(obs.map((o) => o.jenisPasar).filter(Boolean)));
  }, [currentDataset]);

  const filteredObservations = useMemo(() => {
    const obs = currentDataset?.observations ?? [];
    const q = searchQuery.trim().toLowerCase();

    const filtered = obs.filter((o) => {
      if (commodityFilter !== 'ALL' && o.kodeKomoditas !== commodityFilter) return false;
      if (marketTypeFilter !== 'ALL' && o.jenisPasar !== marketTypeFilter) return false;

      if (movementFilter === 'UP' && (o.priceRelative === null || o.priceRelative <= 100.001))
        return false;
      if (movementFilter === 'DOWN' && (o.priceRelative === null || o.priceRelative >= 99.999))
        return false;
      if (
        movementFilter === 'FLAT' &&
        (o.priceRelative === null || Math.abs(o.priceRelative - 100) > 0.001)
      )
        return false;
      if (movementFilter === 'MISSING' && o.priceRelative !== null) return false;
      if (movementFilter === 'FLAGGED' && !o.perluPerbaikan && !o.hargaDiperbaiki) return false;

      if (q) {
        const hay = `${o.kodeKomoditas} ${o.komoditas} ${o.kualitas} ${o.pasar} ${o.namaResponden} ${o.catatan ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const cmpNullableNum = (va: number | null, vb: number | null): number => {
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      return sortDir === 'desc' ? vb - va : va - vb;
    };

    return [...filtered].sort((a, b) => {
      if (sortKey === 'KOMODITAS') {
        const cmp = a.kodeKomoditas.localeCompare(b.kodeKomoditas);
        return sortDir === 'asc' ? cmp : -cmp;
      }
      if (sortKey === 'KUALITAS') {
        const cmp = a.kualitas.localeCompare(b.kualitas);
        return sortDir === 'asc' ? cmp : -cmp;
      }
      if (sortKey === 'PASAR') {
        const cmp = `${a.pasar} ${a.jenisPasar}`.localeCompare(`${b.pasar} ${b.jenisPasar}`);
        return sortDir === 'asc' ? cmp : -cmp;
      }
      if (sortKey === 'RESPONDEN') {
        const cmp = a.namaResponden.localeCompare(b.namaResponden);
        return sortDir === 'asc' ? cmp : -cmp;
      }
      if (sortKey === 'FLAGGED') {
        const fa = a.perluPerbaikan || a.hargaDiperbaiki ? 1 : 0;
        const fb = b.perluPerbaikan || b.hargaDiperbaiki ? 1 : 0;
        if (fa !== fb) return sortDir === 'desc' ? fb - fa : fa - fb;
        const ca = (a.catatan ?? '').trim() ? 1 : 0;
        const cb = (b.catatan ?? '').trim() ? 1 : 0;
        if (ca !== cb) return sortDir === 'desc' ? cb - ca : ca - cb;
        return cmpNullableNum(a.priceRelative, b.priceRelative);
      }
      if (sortKey.startsWith('PREV_')) {
        const idx = Number(sortKey.slice(5));
        return cmpNullableNum(a.prevPrices[idx] ?? null, b.prevPrices[idx] ?? null);
      }
      if (sortKey.startsWith('CURR_')) {
        const idx = Number(sortKey.slice(5));
        return cmpNullableNum(a.currPrices[idx] ?? null, b.currPrices[idx] ?? null);
      }
      if (sortKey === 'AVG_PREV') {
        return cmpNullableNum(a.prevAvgPrice, b.prevAvgPrice);
      }
      if (sortKey === 'AVG_CURR') {
        return cmpNullableNum(a.currAvgPrice, b.currAvgPrice);
      }
      return cmpNullableNum(a.priceRelative, b.priceRelative);
    });
  }, [
    currentDataset,
    commodityFilter,
    marketTypeFilter,
    movementFilter,
    searchQuery,
    sortKey,
    sortDir,
  ]);

  const filteredSummaries = useMemo(() => {
    const list = currentDataset?.commoditySummaries ?? [];
    const q = searchQuery.trim().toLowerCase();
    return list
      .filter((s) => {
        if (commodityFilter !== 'ALL' && s.kodeKomoditas !== commodityFilter) return false;
        if (movementFilter === 'UP' && (s.calculatedRH === null || s.calculatedRH <= 100.001))
          return false;
        if (movementFilter === 'DOWN' && (s.calculatedRH === null || s.calculatedRH >= 99.999))
          return false;
        if (
          movementFilter === 'FLAT' &&
          (s.calculatedRH === null || Math.abs(s.calculatedRH - 100) > 0.001)
        )
          return false;
        if (movementFilter === 'MISSING' && s.calculatedRH !== null) return false;
        if (movementFilter === 'FLAGGED' && !(flaggedCountByCommodity[s.kodeKomoditas] > 0))
          return false;
        if (q) {
          const hay = `${s.kodeKomoditas} ${s.komoditas}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (sortKey === 'KOMODITAS') {
          const cmp = a.kodeKomoditas.localeCompare(b.kodeKomoditas);
          return sortDir === 'asc' ? cmp : -cmp;
        }
        if (sortKey === 'FLAGGED') {
          const fa = flaggedCountByCommodity[a.kodeKomoditas] ?? 0;
          const fb = flaggedCountByCommodity[b.kodeKomoditas] ?? 0;
          if (fa !== fb) return sortDir === 'desc' ? fb - fa : fa - fb;
        }
        const va = a.calculatedRH ?? -1;
        const vb = b.calculatedRH ?? -1;
        if (va === vb) return a.kodeKomoditas.localeCompare(b.kodeKomoditas);
        return sortDir === 'desc' ? vb - va : va - vb;
      });
  }, [
    currentDataset,
    commodityFilter,
    movementFilter,
    searchQuery,
    sortKey,
    sortDir,
    flaggedCountByCommodity,
  ]);

  const totalPages = Math.max(1, Math.ceil(filteredObservations.length / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const pagedRows: RespondentPriceObservation[] = filteredObservations.slice(
    (safePage - 1) * pageSize,
    safePage * pageSize
  );

  const toggleSort = (key: RespSortKey) => {
    const isTextKey =
      key === 'KOMODITAS' || key === 'KUALITAS' || key === 'PASAR' || key === 'RESPONDEN';
    if (sortKey === key) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortKey(key);
      setSortDir(isTextKey ? 'asc' : 'desc');
    }
    setCurrentPage(1);
  };

  const renderSortIcon = (key: RespSortKey) => {
    if (sortKey !== key) {
      return <ArrowUpDown className="h-3 w-3 opacity-45 shrink-0" />;
    }
    return sortDir === 'asc' ? (
      <ArrowUp className="h-3 w-3 text-slate-950 shrink-0" />
    ) : (
      <ArrowDown className="h-3 w-3 text-slate-950 shrink-0" />
    );
  };

  const rhColor = (rh: number | null) => {
    if (rh === null) return 'text-amber-900 bg-amber-100/80 font-bold';
    if (rh > 100.001) return 'text-rose-800 bg-rose-100/70 font-extrabold';
    if (rh < 99.999) return 'text-emerald-800 bg-emerald-100/70 font-extrabold';
    return 'text-slate-900 font-bold';
  };

  return (
    <div className="space-y-5">
      {/* Header & Frequency Selector (Synced to single top-bar Wilayah filter) */}
      <section className="rounded-lg border border-slate-200 bg-white p-5 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-extrabold tracking-tight text-slate-900">
              Analisis Harga & RH per Responden — {targetRegion} {targetMeta.shortName} ({frequency})
            </h2>
            <p className="mt-0.5 text-xs font-medium text-slate-500">
              {isProvinsi
                ? `Evaluasi Relatif Harga (RH) per responden & agregasi hierarki berbobot BPS untuk ${targetRegion} (${formatPeriodLabel(period)}). Wilayah mengikuti filter tunggal di bilah atas.`
                : `Tampilan harga tingkat responden & RH hasil unggahan Admin Provinsi untuk ${targetRegion} ${targetMeta.name} (${formatPeriodLabel(period)}).`}
            </p>
          </div>

          {isProvinsi && (
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => exportRespondentTemplateWorkbook(frequency)}
                className="h-9 inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-xs font-bold text-slate-800 hover:bg-slate-50"
              >
                <Download className="h-3.5 w-3.5 text-slate-700" />
                <span>Download Template</span>
              </button>

              {targetRegion === '6107' && (
                <button
                  type="button"
                  onClick={() => void handleLoadSample()}
                  disabled={isLoading}
                  className="h-9 inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-xs font-bold text-slate-800 hover:bg-slate-50 disabled:opacity-50"
                >
                  <FileSpreadsheet className="h-3.5 w-3.5 text-sky-700" />
                  <span>Muat Contoh {frequency}</span>
                </button>
              )}

              <label className="h-9 inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-3.5 text-xs font-bold text-white hover:bg-slate-800 cursor-pointer">
                <Upload className="h-3.5 w-3.5" />
                <span>Upload Responden ({targetRegion})</span>
                <input
                  type="file"
                  accept=".csv,.xlsx,.xls"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void handleParseFile(file, file.name);
                    e.target.value = '';
                  }}
                />
              </label>
            </div>
          )}
        </div>

        {/* 3 Frequency Tabs */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {(['MINGGUAN', 'DWIMINGGUAN', 'BULANAN'] as RespondentFrequency[]).map((freq) => {
            const item = FREQUENCY_META[freq];
            const isActive = frequency === freq;
            const loaded = datasets[`${targetRegion}_${freq}`];
            return (
              <button
                key={freq}
                type="button"
                onClick={() => {
                  setFrequency(freq);
                  setCommodityFilter('ALL');
                  setMarketTypeFilter('ALL');
                  setMovementFilter('ALL');
                  setSortKey('RH');
                  setSortDir('desc');
                  setCurrentPage(1);
                  setErrorMsg(null);
                  setApplySuccessMsg(null);
                }}
                className={`text-left rounded-md border p-3 transition-colors ${
                  isActive
                    ? 'border-slate-900 bg-slate-50'
                    : 'border-slate-200 bg-white hover:border-slate-300'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-mono font-bold text-slate-900">{freq}</span>
                  {loaded && (
                    <span className="text-[11px] font-mono text-emerald-700 font-bold">
                      {loaded.observations.length} responden · {loaded.commoditySummaries.length} kom
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-xs font-semibold text-slate-700">{item.label}</p>
              </button>
            );
          })}
        </div>

        {errorMsg && (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
            {errorMsg}
          </div>
        )}

        {applySuccessMsg && (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900 flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-700 shrink-0" />
            <span>{applySuccessMsg}</span>
          </div>
        )}
      </section>

      {!currentDataset ? (
        <section className="rounded-lg border border-dashed border-slate-300 bg-white p-10 text-center">
          <Layers className="h-7 w-7 text-slate-400 mx-auto mb-2.5" />
          <h3 className="text-sm font-bold text-slate-800">
            Belum Ada Data Responden {frequency} untuk {targetRegion} ({targetMeta.name})
          </h3>
          <p className="mt-1 text-xs text-slate-500 max-w-xl mx-auto">
            {isProvinsi
              ? `Unggah file Tabel Harga per Responden (.csv/.xlsx) untuk ${targetRegion} ${targetMeta.shortName} melalui tombol Upload di atas.`
              : `Data harga per responden ${frequency} untuk ${targetMeta.name} belum diunggah oleh Admin Provinsi.`}
          </p>
        </section>
      ) : (
        <>
          {/* Respondent-Level KPI Strip */}
          <section className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <div className="rounded-lg border border-slate-200 bg-white p-3.5">
              <span className="text-xs font-semibold text-slate-700 block">Total Observasi</span>
              <span className="mt-1 text-2xl font-mono font-extrabold text-slate-950 block tabular-nums">
                {stats.total}
              </span>
            </div>
            <div
              onClick={() => setMovementFilter(movementFilter === 'UP' ? 'ALL' : 'UP')}
              className={`rounded-lg border p-3.5 cursor-pointer transition-colors ${
                movementFilter === 'UP'
                  ? 'border-rose-500 bg-rose-50/60'
                  : 'border-slate-200 bg-white hover:border-slate-300'
              }`}
            >
              <span className="text-xs text-rose-800 font-semibold block">Harga Naik (RH &gt; 100)</span>
              <span className="mt-1 text-2xl font-mono font-extrabold text-rose-800 block tabular-nums">
                {stats.up}
              </span>
            </div>
            <div
              onClick={() => setMovementFilter(movementFilter === 'DOWN' ? 'ALL' : 'DOWN')}
              className={`rounded-lg border p-3.5 cursor-pointer transition-colors ${
                movementFilter === 'DOWN'
                  ? 'border-emerald-500 bg-emerald-50/60'
                  : 'border-slate-200 bg-white hover:border-slate-300'
              }`}
            >
              <span className="text-xs text-emerald-800 font-semibold block">Harga Turun (RH &lt; 100)</span>
              <span className="mt-1 text-2xl font-mono font-extrabold text-emerald-800 block tabular-nums">
                {stats.down}
              </span>
            </div>
            <div
              onClick={() => setMovementFilter(movementFilter === 'FLAT' ? 'ALL' : 'FLAT')}
              className={`rounded-lg border p-3.5 cursor-pointer transition-colors ${
                movementFilter === 'FLAT'
                  ? 'border-sky-500 bg-sky-50/60'
                  : 'border-slate-200 bg-white hover:border-slate-300'
              }`}
            >
              <span className="text-xs font-semibold text-slate-700 block">Harga Tetap (RH = 100)</span>
              <span className="mt-1 text-2xl font-mono font-extrabold text-slate-950 block tabular-nums">
                {stats.flat}
              </span>
            </div>
            <div
              onClick={() => setMovementFilter(movementFilter === 'MISSING' ? 'ALL' : 'MISSING')}
              className={`rounded-lg border p-3.5 cursor-pointer transition-colors ${
                movementFilter === 'MISSING'
                  ? 'border-amber-500 bg-amber-50/60'
                  : 'border-slate-200 bg-white hover:border-slate-300'
              }`}
            >
              <span className="text-xs font-semibold text-amber-800 block">Harga Kosong / Nol</span>
              <span className="mt-1 text-2xl font-mono font-extrabold text-amber-800 block tabular-nums">
                {stats.missing}
              </span>
            </div>
            <div
              onClick={() => setMovementFilter(movementFilter === 'FLAGGED' ? 'ALL' : 'FLAGGED')}
              className={`rounded-lg border p-3.5 cursor-pointer transition-colors ${
                movementFilter === 'FLAGGED'
                  ? 'border-indigo-600 bg-indigo-50'
                  : 'border-slate-200 bg-white hover:border-indigo-300'
              }`}
            >
              <span className="text-xs font-semibold text-indigo-900 inline-flex items-center gap-1">
                <Flag className="h-3 w-3 text-indigo-700" /> Diperbaiki / Ditandai
              </span>
              <span className="mt-1 text-2xl font-mono font-extrabold text-indigo-700 block tabular-nums">
                {stats.flagged}
              </span>
            </div>
          </section>

          {/* Filter & Analytical Table */}
          <section className="rounded-lg border border-slate-200 bg-white overflow-hidden">
            <div className="px-4 pt-4 pb-3 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3">
              <div className="inline-flex rounded-md border border-slate-200 bg-slate-50 p-0.5">
                <button
                  type="button"
                  onClick={() => setTableView('OBSERVATIONS')}
                  className={`rounded px-3 py-1.5 text-xs font-bold transition-colors ${
                    tableView === 'OBSERVATIONS'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-700 hover:text-slate-950'
                  }`}
                >
                  Detail Responden ({filteredObservations.length})
                </button>
                <button
                  type="button"
                  onClick={() => setTableView('COMMODITY_SUMMARY')}
                  className={`rounded px-3 py-1.5 text-xs font-bold transition-colors ${
                    tableView === 'COMMODITY_SUMMARY'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-700 hover:text-slate-950'
                  }`}
                >
                  Ringkasan RH Komoditas ({filteredSummaries.length})
                </button>
              </div>

              {currentDataset.fileName && (
                <span className="text-[11px] font-mono font-medium text-slate-700">
                  Sumber: {currentDataset.fileName}
                </span>
              )}
            </div>

            <div className="p-4 border-b border-slate-200 flex flex-wrap items-end justify-between gap-3">
              <div className="flex flex-wrap items-end gap-2.5 flex-1">
                <div>
                  <label
                    htmlFor="resp-comm"
                    className="block text-xs font-bold text-slate-800 mb-1"
                  >
                    Filter Komoditas
                  </label>
                  <select
                    id="resp-comm"
                    value={commodityFilter}
                    onChange={(e) => {
                      setCommodityFilter(e.target.value);
                      setCurrentPage(1);
                    }}
                    className="h-9 rounded-md border border-slate-300 bg-white px-2.5 text-xs font-semibold text-slate-900 focus:border-slate-900 focus:outline-none max-w-[230px]"
                  >
                    <option value="ALL">
                      Semua Komoditas ({currentDataset.commoditySummaries.length})
                    </option>
                    {currentDataset.commoditySummaries.map((c) => (
                      <option key={c.kodeKomoditas} value={c.kodeKomoditas}>
                        {c.kodeKomoditas} — {c.komoditas} ({c.observationCount})
                      </option>
                    ))}
                  </select>
                </div>

                {tableView === 'OBSERVATIONS' && (
                  <div>
                    <label
                      htmlFor="resp-mkt"
                      className="block text-xs font-bold text-slate-800 mb-1"
                    >
                      Jenis Pasar
                    </label>
                    <select
                      id="resp-mkt"
                      value={marketTypeFilter}
                      onChange={(e) => {
                        setMarketTypeFilter(e.target.value);
                        setCurrentPage(1);
                      }}
                      className="h-9 rounded-md border border-slate-300 bg-white px-2.5 text-xs font-semibold text-slate-900 focus:border-slate-900 focus:outline-none"
                    >
                      <option value="ALL">Semua Jenis Pasar</option>
                      {marketTypes.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div>
                  <label
                    htmlFor="resp-mov"
                    className="block text-xs font-bold text-slate-800 mb-1"
                  >
                    Status RH / Penanda
                  </label>
                  <select
                    id="resp-mov"
                    value={movementFilter}
                    onChange={(e) => {
                      setMovementFilter(e.target.value as MovementFilter);
                      setCurrentPage(1);
                    }}
                    className="h-9 rounded-md border border-slate-300 bg-white px-2.5 text-xs font-semibold text-slate-900 focus:border-slate-900 focus:outline-none"
                  >
                    <option value="ALL">Semua Pergerakan</option>
                    <option value="UP">Naik (RH &gt; 100)</option>
                    <option value="DOWN">Turun (RH &lt; 100)</option>
                    <option value="FLAT">Tetap (RH = 100)</option>
                    <option value="MISSING">Harga Kosong (.00)</option>
                    <option value="FLAGGED">Diperbaiki / Ditandai ({stats.flagged})</option>
                  </select>
                </div>

                <div className="flex-1 min-w-[200px]">
                  <label
                    htmlFor="resp-search"
                    className="block text-xs font-bold text-slate-800 mb-1"
                  >
                    Cari Responden / Pasar / Kualitas / Catatan
                  </label>
                  <div className="relative">
                    <Search className="h-3.5 w-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      id="resp-search"
                      type="text"
                      value={searchQuery}
                      onChange={(e) => {
                        setSearchQuery(e.target.value);
                        setCurrentPage(1);
                      }}
                      placeholder="Nama toko, pasar, kualitas, komoditas, catatan..."
                      className="h-9 w-full rounded-md border border-slate-300 bg-white pl-8 pr-3 text-xs font-medium text-slate-950 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none"
                    />
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 shrink-0">
                {tableView === 'OBSERVATIONS' && (
                  <button
                    type="button"
                    onClick={() => setHidePrevPrice((v) => !v)}
                    className={`h-9 inline-flex items-center gap-1.5 rounded-md border px-3 text-xs font-bold transition-colors shrink-0 ${
                      hidePrevPrice
                        ? 'border-sky-600 bg-sky-50 text-sky-900 hover:bg-sky-100'
                        : 'border-slate-300 bg-white text-slate-800 hover:bg-slate-50'
                    }`}
                  >
                    {hidePrevPrice ? (
                      <>
                        <Eye className="h-3.5 w-3.5 text-sky-700" />
                        <span>Tampilkan Harga N-1</span>
                      </>
                    ) : (
                      <>
                        <EyeOff className="h-3.5 w-3.5 text-slate-700" />
                        <span>Sembunyikan Harga N-1</span>
                      </>
                    )}
                  </button>
                )}

                {isProvinsi && (
                  <>
                    <label className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-800 cursor-pointer mr-1">
                      <input
                        type="checkbox"
                        checked={autoFillEmptyRh100}
                        onChange={(e) => setAutoFillEmptyRh100(e.target.checked)}
                        className="rounded border-slate-300"
                      />
                      <span>Auto RH kosong = 100</span>
                    </label>

                    {stats.missing > 0 && (
                      <button
                        type="button"
                        onClick={() => void handleReplaceMissingWith100()}
                        className="h-9 inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-3 text-xs font-bold text-amber-950 hover:bg-amber-100"
                      >
                        <span>Replace RH Kosong → 100 ({stats.missing})</span>
                      </button>
                    )}

                    {onApplyCalculatedRhToLK && (
                      <button
                        type="button"
                        disabled={isSyncingToLK}
                        onClick={() => void handleApplyToLK()}
                        className="h-9 inline-flex items-center gap-1.5 rounded-md bg-sky-700 px-3 text-xs font-bold text-white hover:bg-sky-800 disabled:opacity-60 shrink-0"
                      >
                        {isSyncingToLK ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <CheckCircle2 className="h-3.5 w-3.5" />
                        )}
                        <span>
                          {isSyncingToLK ? 'Menyinkronkan...' : `Terapkan ke LK ${targetRegion}`}
                        </span>
                      </button>
                    )}
                  </>
                )}

                <button
                  type="button"
                  onClick={() =>
                    exportRespondentAnalysisWorkbook(
                      filteredObservations,
                      period,
                      frequency,
                      currentDataset.regionCode
                    )
                  }
                  className="h-9 inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-xs font-bold text-slate-800 hover:bg-slate-50 shrink-0"
                >
                  <Download className="h-3.5 w-3.5" />
                  <span>Export Responden (.xlsx)</span>
                </button>
              </div>
            </div>

            {tableView === 'COMMODITY_SUMMARY' ? (
              <div className="overflow-y-auto overflow-x-hidden max-h-[68vh]">
                <table className="w-full table-fixed text-left border-collapse text-[11px]">
                  <colgroup>
                    <col className="w-[46%]" />
                    <col className="w-[11%]" />
                    <col className="w-[15%]" />
                    <col className="w-[16%]" />
                    <col className="w-[12%]" />
                  </colgroup>
                  <thead className="sticky top-0 z-20 bg-slate-100 border-b border-slate-300 text-[11px] font-bold text-slate-900 select-none">
                    <tr>
                      <th
                        onClick={() => toggleSort('KOMODITAS')}
                        className="py-2 px-2.5 border-r border-slate-200 cursor-pointer hover:bg-slate-200/70"
                      >
                        <span className="inline-flex items-center gap-1">
                          Kode & Komoditas {renderSortIcon('KOMODITAS')}
                        </span>
                      </th>
                      <th className="py-2 px-2 text-center border-r border-slate-200">
                        Kualitas
                      </th>
                      <th className="py-2 px-2 text-center border-r border-slate-200">
                        Responden Aktif
                      </th>
                      <th
                        onClick={() => toggleSort('RH')}
                        className="py-2 px-2.5 text-right border-r border-slate-200 cursor-pointer hover:bg-slate-200/70"
                      >
                        <span className="inline-flex items-center justify-end gap-1">
                          RH Komoditas {renderSortIcon('RH')}
                        </span>
                      </th>
                      <th className="py-2 px-2.5 text-right">Perubahan (%)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredSummaries.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="py-10 text-center text-slate-600 font-medium">
                          Tidak ada ringkasan komoditas yang cocok dengan filter.
                        </td>
                      </tr>
                    ) : (
                      filteredSummaries.map((sum) => {
                        const pct = sum.calculatedRH !== null ? sum.calculatedRH - 100 : null;
                        const flagCount = flaggedCountByCommodity[sum.kodeKomoditas] ?? 0;
                        return (
                          <tr
                            key={sum.kodeKomoditas}
                            onClick={() => {
                              setCommodityFilter(sum.kodeKomoditas);
                              setTableView('OBSERVATIONS');
                              setCurrentPage(1);
                            }}
                            className={`cursor-pointer transition-colors ${
                              flagCount > 0
                                ? 'bg-indigo-50/75 hover:bg-indigo-100/65'
                                : 'hover:bg-slate-50'
                            }`}
                          >
                            <td
                              className={`py-2 px-2.5 border-r border-slate-100 truncate ${
                                flagCount > 0 ? 'border-l-4 border-l-indigo-600' : ''
                              }`}
                              title={`${sum.kodeKomoditas} — ${sum.komoditas}`}
                            >
                              <span className="font-mono text-[11px] font-bold text-slate-700 mr-2">
                                {sum.kodeKomoditas}
                              </span>
                              <span className="font-bold text-slate-950">{sum.komoditas}</span>
                              {flagCount > 0 && (
                                <span className="ml-2 inline-flex items-center gap-1 rounded bg-indigo-100 px-1.5 py-0.5 text-[9.5px] font-bold text-indigo-900 border border-indigo-300">
                                  <Flag className="h-2.5 w-2.5" />
                                  {flagCount} perbaikan
                                </span>
                              )}
                            </td>
                            <td className="py-2 px-2 text-center font-mono font-semibold border-r border-slate-100 text-slate-800">
                              {sum.qualityCount}
                            </td>
                            <td className="py-2 px-2 text-center font-mono font-semibold border-r border-slate-100 text-slate-800">
                              {sum.activeObservationCount} / {sum.observationCount}
                            </td>
                            <td
                              className={`py-2 px-2.5 text-right font-mono tabular-nums border-r border-slate-100 ${rhColor(
                                sum.calculatedRH
                              )}`}
                            >
                              {sum.calculatedRH !== null
                                ? formatNumber(sum.calculatedRH, 6)
                                : 'Kosong'}
                            </td>
                            <td
                              className={`py-2 px-2.5 text-right font-mono tabular-nums ${rhColor(
                                sum.calculatedRH
                              )}`}
                            >
                              {pct !== null ? formatSignedPct(pct, 3) : '—'}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            ) : (
              <>
                <div className="overflow-y-auto overflow-x-hidden max-h-[68vh]">
                  <table className="w-full table-fixed text-left border-collapse text-[11px]">
                    <colgroup>
                      {hidePrevPrice ? (
                        frequency === 'MINGGUAN' ? (
                          <>
                            <col className="w-[18%]" />
                            <col className="w-[14%]" />
                            <col className="w-[28%]" />
                            <col className="w-[7.5%]" />
                            <col className="w-[7.5%]" />
                            <col className="w-[7%]" />
                            <col className="w-[18%]" />
                          </>
                        ) : frequency === 'DWIMINGGUAN' ? (
                          <>
                            <col className="w-[22%]" />
                            <col className="w-[16%]" />
                            <col className="w-[21%]" />
                            <col className="w-[8%]" />
                            <col className="w-[8%]" />
                            <col className="w-[7%]" />
                            <col className="w-[18%]" />
                          </>
                        ) : (
                          <>
                            <col className="w-[24%]" />
                            <col className="w-[19%]" />
                            <col className="w-[12%]" />
                            <col className="w-[9%]" />
                            <col className="w-[9%]" />
                            <col className="w-[8%]" />
                            <col className="w-[19%]" />
                          </>
                        )
                      ) : frequency === 'MINGGUAN' ? (
                        <>
                          <col className="w-[15%]" />
                          <col className="w-[11%]" />
                          <col className="w-[21%]" />
                          <col className="w-[21%]" />
                          <col className="w-[6%]" />
                          <col className="w-[6%]" />
                          <col className="w-[5.5%]" />
                          <col className="w-[14.5%]" />
                        </>
                      ) : frequency === 'DWIMINGGUAN' ? (
                        <>
                          <col className="w-[19%]" />
                          <col className="w-[14%]" />
                          <col className="w-[15%]" />
                          <col className="w-[15%]" />
                          <col className="w-[7%]" />
                          <col className="w-[7%]" />
                          <col className="w-[7%]" />
                          <col className="w-[16%]" />
                        </>
                      ) : (
                        <>
                          <col className="w-[21%]" />
                          <col className="w-[17%]" />
                          <col className="w-[10%]" />
                          <col className="w-[10%]" />
                          <col className="w-[8%]" />
                          <col className="w-[8%]" />
                          <col className="w-[8%]" />
                          <col className="w-[18%]" />
                        </>
                      )}
                    </colgroup>
                    <thead className="sticky top-0 z-20 bg-slate-100 border-b border-slate-300 text-[11px] font-bold text-slate-900 select-none">
                      <tr className="leading-tight">
                        <th className="py-2 px-2 border-r border-slate-200 align-middle">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                            <button
                              type="button"
                              onClick={() => toggleSort('KOMODITAS')}
                              className="inline-flex items-center gap-0.5 text-slate-950 hover:text-black"
                            >
                              <span>Komoditas</span>
                              {renderSortIcon('KOMODITAS')}
                            </button>
                            <button
                              type="button"
                              onClick={() => toggleSort('KUALITAS')}
                              className="inline-flex items-center gap-0.5 text-[10.5px] font-bold text-slate-700 hover:text-slate-950"
                            >
                              <span>/ Kualitas</span>
                              {renderSortIcon('KUALITAS')}
                            </button>
                          </div>
                        </th>
                        <th className="py-2 px-2 border-r border-slate-200 align-middle">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                            <button
                              type="button"
                              onClick={() => toggleSort('RESPONDEN')}
                              className="inline-flex items-center gap-0.5 text-slate-950 hover:text-black"
                            >
                              <span>Responden</span>
                              {renderSortIcon('RESPONDEN')}
                            </button>
                            <button
                              type="button"
                              onClick={() => toggleSort('PASAR')}
                              className="inline-flex items-center gap-0.5 text-[10.5px] font-bold text-slate-700 hover:text-slate-950"
                            >
                              <span>/ Pasar</span>
                              {renderSortIcon('PASAR')}
                            </button>
                          </div>
                        </th>
                        {!hidePrevPrice && (
                          <th className="py-1.5 px-2 border-r border-sky-200 bg-sky-100/90 text-sky-950 align-middle">
                            <div className="flex flex-wrap items-center justify-between gap-1">
                              <div className="inline-flex items-center gap-1">
                                <span>Harga N-1</span>
                                <button
                                  type="button"
                                  onClick={() => setHidePrevPrice(true)}
                                  title="Sembunyikan kolom Harga N-1"
                                  aria-label="Sembunyikan kolom Harga N-1"
                                  className="rounded p-0.5 text-sky-900 hover:bg-sky-200/80"
                                >
                                  <EyeOff className="h-3 w-3" />
                                </button>
                              </div>
                              <div className="inline-flex flex-wrap items-center gap-1">
                                {meta.periodCols.map((col, idx) => {
                                  const k: RespSortKey = `PREV_${idx}`;
                                  const isActive = sortKey === k;
                                  return (
                                    <button
                                      key={`prev-sort-${col}`}
                                      type="button"
                                      onClick={() => toggleSort(k)}
                                      title={`Urutkan berdasarkan Harga N-1 ${col}`}
                                      className={`inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[9.5px] font-mono font-bold transition-colors ${
                                        isActive
                                          ? 'bg-sky-800 text-white'
                                          : 'bg-white text-sky-950 hover:bg-sky-200'
                                      }`}
                                    >
                                      <span>{col}</span>
                                      {isActive && renderSortIcon(k)}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          </th>
                        )}
                        <th className="py-1.5 px-2 border-r border-amber-200 bg-amber-100/90 text-amber-950 align-middle">
                          <div className="flex flex-wrap items-center justify-between gap-1">
                            <span>Harga N</span>
                            <div className="inline-flex flex-wrap items-center gap-1">
                              {meta.periodCols.map((col, idx) => {
                                const k: RespSortKey = `CURR_${idx}`;
                                const isActive = sortKey === k;
                                return (
                                  <button
                                    key={`curr-sort-${col}`}
                                    type="button"
                                    onClick={() => toggleSort(k)}
                                    title={`Urutkan berdasarkan Harga N ${col}`}
                                    className={`inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[9.5px] font-mono font-bold transition-colors ${
                                      isActive
                                        ? 'bg-amber-800 text-white'
                                        : 'bg-white text-amber-950 hover:bg-amber-200'
                                    }`}
                                  >
                                    <span>{col}</span>
                                    {isActive && renderSortIcon(k)}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        </th>
                        <th
                          onClick={() => toggleSort('AVG_PREV')}
                          className="py-2 px-1.5 text-right border-r border-slate-200 cursor-pointer hover:bg-slate-200/70 align-middle"
                        >
                          <span className="inline-flex items-center justify-end gap-0.5">
                            Rata² N-1 {renderSortIcon('AVG_PREV')}
                          </span>
                        </th>
                        <th
                          onClick={() => toggleSort('AVG_CURR')}
                          className="py-2 px-1.5 text-right border-r border-slate-200 cursor-pointer hover:bg-slate-200/70 align-middle"
                        >
                          <span className="inline-flex items-center justify-end gap-0.5">
                            Rata² N {renderSortIcon('AVG_CURR')}
                          </span>
                        </th>
                        <th
                          onClick={() => toggleSort('RH')}
                          className="py-2 px-1.5 text-right border-r border-slate-200 cursor-pointer hover:bg-slate-200/70 align-middle"
                        >
                          <span className="inline-flex items-center justify-end gap-0.5">
                            RH {renderSortIcon('RH')}
                          </span>
                        </th>
                        <th
                          onClick={() => toggleSort('FLAGGED')}
                          className="py-2 px-2 text-left cursor-pointer hover:bg-slate-200/70 align-middle"
                        >
                          <span className="inline-flex items-center gap-1">
                            Catatan &amp; Perbaikan {renderSortIcon('FLAGGED')}
                          </span>
                        </th>
                      </tr>
                    </thead>

                    <tbody className="divide-y divide-slate-100">
                      {pagedRows.length === 0 ? (
                        <tr>
                          <td
                            colSpan={hidePrevPrice ? 7 : 8}
                            className="py-10 text-center text-slate-600 font-medium"
                          >
                            Tidak ada observasi responden yang cocok dengan filter.
                          </td>
                        </tr>
                      ) : (
                        pagedRows.map((obs) => {
                          const isFlagged = Boolean(obs.perluPerbaikan);
                          const isPriceEdited = Boolean(obs.hargaDiperbaiki);
                          const isHighlighted = isFlagged || isPriceEdited;
                          return (
                            <tr
                              key={obs.id}
                              className={
                                isHighlighted
                                  ? 'bg-indigo-50/90 hover:bg-indigo-100/75 transition-colors align-top'
                                  : 'hover:bg-slate-50/90 transition-colors align-top'
                              }
                            >
                              <td
                                className={`py-2 px-2 border-r border-slate-100 ${
                                  isHighlighted ? 'border-l-4 border-l-indigo-600' : ''
                                }`}
                              >
                                <div
                                  className="font-bold text-slate-950 truncate"
                                  title={`${obs.kodeKomoditas} — ${obs.komoditas}`}
                                >
                                  <span className="font-mono text-[10.5px] font-bold text-slate-700 mr-1">
                                    {obs.kodeKomoditas}
                                  </span>
                                  {obs.komoditas}
                                </div>
                                <div
                                  className="text-[11px] font-medium text-slate-800 truncate mt-0.5"
                                  title={obs.kualitas}
                                >
                                  {obs.kualitas}
                                </div>
                                <div className="font-mono text-[10px] font-medium text-slate-600 truncate mt-0.5">
                                  {obs.kodeKualitas} · Bobot {formatNumber(obs.bobotKualitas, 2)}
                                </div>
                                {(isPriceEdited || isFlagged) && (
                                  <div className="mt-1 flex flex-wrap items-center gap-1">
                                    {isPriceEdited && (
                                      <span className="inline-flex items-center rounded bg-indigo-100 px-1.5 py-0.5 text-[9.5px] font-bold text-indigo-900 border border-indigo-300">
                                        Harga Diperbaiki
                                      </span>
                                    )}
                                    {isFlagged && (
                                      <span className="inline-flex items-center gap-1 rounded bg-indigo-100 px-1.5 py-0.5 text-[9.5px] font-bold text-indigo-900 border border-indigo-300">
                                        <Flag className="h-2.5 w-2.5" /> Perlu Perbaikan
                                      </span>
                                    )}
                                  </div>
                                )}
                              </td>
                              <td className="py-2 px-2 border-r border-slate-100">
                                <div
                                  className="font-bold text-slate-950 truncate"
                                  title={obs.namaResponden}
                                >
                                  {obs.namaResponden}
                                </div>
                                <div
                                  className="text-[11px] font-medium text-slate-800 truncate mt-0.5"
                                  title={`${obs.pasar} (${obs.jenisPasar})`}
                                >
                                  {obs.pasar}
                                </div>
                                <div className="text-[10px] font-medium text-slate-600 truncate mt-0.5">
                                  {obs.jenisPasar}
                                </div>
                              </td>

                              {!hidePrevPrice && (
                                <td className="py-1.5 px-1.5 border-r border-slate-100 bg-sky-50/40">
                                  {meta.periodCols.length === 1 ? (
                                    <div className="rounded border border-sky-200/80 bg-white/90 px-2 py-1 text-right font-mono text-[11.5px] font-semibold tabular-nums text-slate-900">
                                      {obs.prevPrices[0] ? formatNumber(obs.prevPrices[0], 0) : '—'}
                                    </div>
                                  ) : meta.periodCols.length === 5 ? (
                                    <div className="grid grid-cols-5 gap-1 font-mono tabular-nums">
                                      {meta.periodCols.map((col, idx) => {
                                        const val = obs.prevPrices[idx] ?? null;
                                        return (
                                          <div
                                            key={`${obs.id}-prev-${col}`}
                                            title={`${col}: ${val ? formatNumber(val, 0) : 'Kosong'}`}
                                            className="rounded border border-sky-200/90 bg-white/95 px-0.5 py-0.5 text-center leading-tight"
                                          >
                                            <div className="text-[8.5px] font-bold text-sky-900">
                                              {col}
                                            </div>
                                            <div
                                              className={`text-[10px] truncate ${
                                                val
                                                  ? 'font-semibold text-slate-900'
                                                  : 'text-slate-400'
                                              }`}
                                            >
                                              {val ? formatNumber(val, 0) : '—'}
                                            </div>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  ) : (
                                    <div className="grid grid-cols-2 gap-1 font-mono text-[10.5px] tabular-nums">
                                      {meta.periodCols.map((col, idx) => {
                                        const val = obs.prevPrices[idx] ?? null;
                                        return (
                                          <div
                                            key={`${obs.id}-prev-${col}`}
                                            className="flex items-center justify-between gap-1 rounded border border-sky-200/80 bg-white/95 px-1.5 py-0.5"
                                          >
                                            <span className="text-[9.5px] font-bold text-sky-900">
                                              {col}
                                            </span>
                                            <span
                                              className={
                                                val
                                                  ? 'font-semibold text-slate-900'
                                                  : 'text-slate-400'
                                              }
                                            >
                                              {val ? formatNumber(val, 0) : '—'}
                                            </span>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  )}
                                </td>
                              )}

                              <td className="py-1.5 px-1.5 border-r border-slate-100 bg-amber-50/40">
                                {meta.periodCols.length === 1 ? (
                                  <div
                                    className={`rounded border px-1.5 py-0.5 ${
                                      obs.originalCurrPrices &&
                                      obs.originalCurrPrices[0] !== obs.currPrices[0]
                                        ? 'border-indigo-400 bg-indigo-50/85'
                                        : 'border-amber-200/90 bg-white/95'
                                    }`}
                                  >
                                    <EditablePriceInput
                                      value={obs.currPrices[0] ?? null}
                                      edited={Boolean(
                                        obs.originalCurrPrices &&
                                          obs.originalCurrPrices[0] !== obs.currPrices[0]
                                      )}
                                      align="right"
                                      ariaLabel={`Harga N ${obs.komoditas} ${obs.namaResponden}`}
                                      onCommit={(nextVal) =>
                                        onUpdateObservationPrice?.(
                                          targetRegion,
                                          frequency,
                                          obs.id,
                                          0,
                                          nextVal
                                        )
                                      }
                                    />
                                  </div>
                                ) : meta.periodCols.length === 5 ? (
                                  <div className="grid grid-cols-5 gap-1 font-mono tabular-nums">
                                    {meta.periodCols.map((col, idx) => {
                                      const val = obs.currPrices[idx] ?? null;
                                      const slotEdited = Boolean(
                                        obs.originalCurrPrices &&
                                          obs.originalCurrPrices[idx] !== obs.currPrices[idx]
                                      );
                                      return (
                                        <div
                                          key={`${obs.id}-curr-${col}`}
                                          title={`Klik untuk edit ${col}: ${val ? formatNumber(val, 0) : 'Kosong'}`}
                                          className={`rounded border px-0.5 py-0.5 text-center leading-tight ${
                                            slotEdited
                                              ? 'border-indigo-400 bg-indigo-50/85'
                                              : 'border-amber-200/90 bg-white/95 hover:border-amber-400'
                                          }`}
                                        >
                                          <div
                                            className={`text-[8.5px] font-bold ${
                                              slotEdited ? 'text-indigo-900' : 'text-amber-950'
                                            }`}
                                          >
                                            {col}
                                          </div>
                                          <EditablePriceInput
                                            value={val}
                                            edited={slotEdited}
                                            align="center"
                                            ariaLabel={`Harga ${col} ${obs.komoditas} ${obs.namaResponden}`}
                                            onCommit={(nextVal) =>
                                              onUpdateObservationPrice?.(
                                                targetRegion,
                                                frequency,
                                                obs.id,
                                                idx,
                                                nextVal
                                              )
                                            }
                                          />
                                        </div>
                                      );
                                    })}
                                  </div>
                                ) : (
                                  <div className="grid grid-cols-2 gap-1 font-mono text-[10.5px] tabular-nums">
                                    {meta.periodCols.map((col, idx) => {
                                      const val = obs.currPrices[idx] ?? null;
                                      const slotEdited = Boolean(
                                        obs.originalCurrPrices &&
                                          obs.originalCurrPrices[idx] !== obs.currPrices[idx]
                                      );
                                      return (
                                        <div
                                          key={`${obs.id}-curr-${col}`}
                                          title={`Klik untuk edit ${col}: ${val ? formatNumber(val, 0) : 'Kosong'}`}
                                          className={`flex items-center justify-between gap-1 rounded border px-1.5 py-0.5 ${
                                            slotEdited
                                              ? 'border-indigo-400 bg-indigo-50/85'
                                              : 'border-amber-200/90 bg-white/95 hover:border-amber-400'
                                          }`}
                                        >
                                          <span
                                            className={`text-[9.5px] font-bold shrink-0 ${
                                              slotEdited ? 'text-indigo-900' : 'text-amber-950'
                                            }`}
                                          >
                                            {col}
                                          </span>
                                          <EditablePriceInput
                                            value={val}
                                            edited={slotEdited}
                                            align="right"
                                            ariaLabel={`Harga ${col} ${obs.komoditas} ${obs.namaResponden}`}
                                            onCommit={(nextVal) =>
                                              onUpdateObservationPrice?.(
                                                targetRegion,
                                                frequency,
                                                obs.id,
                                                idx,
                                                nextVal
                                              )
                                            }
                                          />
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </td>

                              <td className="py-2 px-1.5 text-right font-mono text-[11.5px] tabular-nums font-semibold text-slate-800 border-r border-slate-100 truncate">
                                {obs.prevAvgPrice ? formatNumber(obs.prevAvgPrice, 0) : '—'}
                              </td>
                              <td className="py-2 px-1.5 text-right font-mono text-[11.5px] tabular-nums font-bold text-slate-950 border-r border-slate-100 truncate">
                                {obs.currAvgPrice ? formatNumber(obs.currAvgPrice, 0) : '—'}
                              </td>
                              <td
                                className={`py-2 px-1.5 text-right font-mono text-[11.5px] tabular-nums border-r border-slate-100 truncate ${rhColor(
                                  obs.priceRelative
                                )}`}
                              >
                                {obs.priceRelative ? formatIndex(obs.priceRelative, 3) : 'Kosong'}
                              </td>
                              <td className="py-1.5 px-2">
                                <div className="space-y-1.5">
                                  <div className="flex flex-wrap items-center gap-1">
                                    <button
                                      type="button"
                                      onClick={() =>
                                        onUpdateObservationAnnotation?.(
                                          targetRegion,
                                          frequency,
                                          obs.id,
                                          { perluPerbaikan: !isFlagged }
                                        )
                                      }
                                      className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-bold transition-colors ${
                                        isFlagged
                                          ? 'bg-indigo-600 text-white hover:bg-indigo-700'
                                          : 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-100'
                                      }`}
                                    >
                                      <Flag className="h-3 w-3" />
                                      <span>
                                        {isFlagged ? 'Perlu Perbaikan' : 'Tandai Perbaikan'}
                                      </span>
                                    </button>
                                    {isPriceEdited && (
                                      <button
                                        type="button"
                                        title="Kembalikan harga ke nilai awal sebelum diedit"
                                        onClick={() =>
                                          onResetObservationPrice?.(
                                            targetRegion,
                                            frequency,
                                            obs.id
                                          )
                                        }
                                        className="inline-flex items-center gap-1 rounded border border-indigo-300 bg-white px-1.5 py-0.5 text-[10px] font-bold text-indigo-800 hover:bg-indigo-50"
                                      >
                                        <RotateCcw className="h-2.5 w-2.5" />
                                        <span>Reset</span>
                                      </button>
                                    )}
                                  </div>
                                  <ObservationNoteInput
                                    value={obs.catatan ?? ''}
                                    highlighted={isHighlighted}
                                    onCommit={(nextNote) =>
                                      onUpdateObservationAnnotation?.(
                                        targetRegion,
                                        frequency,
                                        obs.id,
                                        { catatan: nextNote }
                                      )
                                    }
                                  />
                                </div>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Pagination Footer */}
                <div className="px-4 py-2.5 border-t border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600">
                  <div>
                    Menampilkan{' '}
                    <strong className="text-slate-900">
                      {filteredObservations.length === 0 ? 0 : (safePage - 1) * pageSize + 1}–
                      {Math.min(safePage * pageSize, filteredObservations.length)}
                    </strong>{' '}
                    dari <strong className="text-slate-900">{filteredObservations.length}</strong> observasi responden
                  </div>

                  <div className="flex items-center gap-2">
                    <select
                      aria-label="Baris per halaman"
                      value={pageSize}
                      onChange={(e) => {
                        setPageSize(Number(e.target.value));
                        setCurrentPage(1);
                      }}
                      className="rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                    >
                      <option value={50}>50 / hal</option>
                      <option value={100}>100 / hal</option>
                      <option value={250}>250 / hal</option>
                    </select>
                    <button
                      type="button"
                      disabled={safePage <= 1}
                      onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                      className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium disabled:opacity-40 hover:bg-slate-100"
                    >
                      Prev
                    </button>
                    <span className="font-mono text-xs">
                      {safePage} / {totalPages}
                    </span>
                    <button
                      type="button"
                      disabled={safePage >= totalPages}
                      onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                      className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium disabled:opacity-40 hover:bg-slate-100"
                    >
                      Next
                    </button>
                  </div>
                </div>
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
};
