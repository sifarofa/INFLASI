import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Download,
  FileSpreadsheet,
  Layers,
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
import { REGIONS } from '../data/regions';
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
  datasets: Record<string, RespondentRHDataset>;
  userRole: AdminRole;
  allowedRegion: RegionCode;
  onSetDataset: (frequency: RespondentFrequency, dataset: RespondentRHDataset) => void;
}

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

type MovementFilter = 'ALL' | 'UP' | 'DOWN' | 'FLAT' | 'MISSING';
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
  | 'PCT';

export const RespondentRHView: React.FC<RespondentRHViewProps> = ({
  period,
  datasets,
  userRole,
  allowedRegion,
  onSetDataset,
}) => {
  const isProvinsi = userRole === 'PROVINSI';
  const defaultKab: KabKotaCode =
    allowedRegion !== '6100' ? (allowedRegion as KabKotaCode) : '6107';

  const [frequency, setFrequency] = useState<RespondentFrequency>('MINGGUAN');
  const [targetRegion, setTargetRegion] = useState<KabKotaCode>(defaultKab);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [commodityFilter, setCommodityFilter] = useState<string>('ALL');
  const [marketTypeFilter, setMarketTypeFilter] = useState<string>('ALL');
  const [movementFilter, setMovementFilter] = useState<MovementFilter>('ALL');
  const [sortKey, setSortKey] = useState<RespSortKey>('RH');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [pageSize, setPageSize] = useState<number>(50);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [autoFillEmptyRh100, setAutoFillEmptyRh100] = useState<boolean>(true);

  useEffect(() => {
    if (!isProvinsi && allowedRegion !== '6100') {
      setTargetRegion(allowedRegion as KabKotaCode);
    }
  }, [isProvinsi, allowedRegion]);

  const meta = FREQUENCY_META[frequency];
  const datasetKey = `${targetRegion}_${frequency}`;
  const currentDataset = datasets[datasetKey];

  const kabKotaList = isProvinsi
    ? REGIONS.filter((r) => !r.isAggregated)
    : REGIONS.filter((r) => r.code === allowedRegion);

  const handleParseFile = async (fileOrText: File | string, fileName: string) => {
    setErrorMsg(null);
    setIsLoading(true);
    try {
      const rawRows = await readSpreadsheetRows(fileOrText, fileName);
      const parsed = parseRespondentObservations(rawRows, frequency);
      const observations = autoFillEmptyRh100
        ? parsed.map((o) => (o.priceRelative === null ? { ...o, priceRelative: 100 } : o))
        : parsed;
      const commoditySummaries = summarizeRespondentRH(observations, frequency);

      onSetDataset(frequency, {
        regionCode: targetRegion,
        period,
        frequency,
        fileName,
        loadedAt: new Date().toISOString(),
        observations,
        commoditySummaries,
      });
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

  const handleReplaceMissingWith100 = () => {
    if (!currentDataset) return;
    const updatedObs = currentDataset.observations.map((o) =>
      o.priceRelative === null ? { ...o, priceRelative: 100 } : o
    );
    const updatedSummaries = summarizeRespondentRH(updatedObs, frequency);
    onSetDataset(frequency, {
      ...currentDataset,
      observations: updatedObs,
      commoditySummaries: updatedSummaries,
    });
    if (movementFilter === 'MISSING') setMovementFilter('ALL');
  };

  const handleLoadSample = async () => {
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

  const stats = useMemo(() => {
    const obs = currentDataset?.observations ?? [];
    let up = 0;
    let down = 0;
    let flat = 0;
    let missing = 0;
    for (const o of obs) {
      if (o.priceRelative === null) missing++;
      else if (o.priceRelative > 100.001) up++;
      else if (o.priceRelative < 99.999) down++;
      else flat++;
    }
    return { total: obs.length, up, down, flat, missing };
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

      if (q) {
        const hay = `${o.kodeKomoditas} ${o.komoditas} ${o.kualitas} ${o.pasar} ${o.namaResponden}`.toLowerCase();
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
      if (sortKey === 'PCT') {
        const pa = a.priceRelative !== null ? a.priceRelative - 100 : null;
        const pb = b.priceRelative !== null ? b.priceRelative - 100 : null;
        return cmpNullableNum(pa, pb);
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
      return <ArrowUpDown className="h-3 w-3 opacity-35 shrink-0" />;
    }
    return sortDir === 'asc' ? (
      <ArrowUp className="h-3 w-3 text-slate-900 shrink-0" />
    ) : (
      <ArrowDown className="h-3 w-3 text-slate-900 shrink-0" />
    );
  };

  const rhColor = (rh: number | null) => {
    if (rh === null) return 'text-amber-700 bg-amber-50/50';
    if (rh > 100.001) return 'text-rose-700 bg-rose-50/50 font-semibold';
    if (rh < 99.999) return 'text-emerald-700 bg-emerald-50/50 font-semibold';
    return 'text-slate-600';
  };

  const totalTableCols = 8 + meta.periodCols.length * 2;

  return (
    <div className="space-y-5">
      {/* Header & Frequency Selector */}
      <section className="rounded-lg border border-slate-200 bg-white p-5 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-extrabold tracking-tight text-slate-900">
              Analisis Harga & RH per Responden ({frequency})
            </h2>
            <p className="mt-0.5 text-xs font-medium text-slate-500">
              Evaluasi langsung Relatif Harga (RH) masing-masing responden, kualitas, dan sub-periode pencacahan ({targetRegion}).
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <select
              value={targetRegion}
              disabled={!isProvinsi}
              onChange={(e) => {
                setTargetRegion(e.target.value as KabKotaCode);
                setCommodityFilter('ALL');
                setMarketTypeFilter('ALL');
                setMovementFilter('ALL');
                setCurrentPage(1);
              }}
              className="h-9 rounded-md border border-slate-300 bg-white px-3 text-xs font-bold text-slate-900 focus:border-slate-900 focus:outline-none disabled:bg-slate-100"
            >
              {kabKotaList.map((r) => (
                <option key={r.code} value={r.code}>
                  {r.code} — {r.shortName}
                </option>
              ))}
            </select>

            <button
              type="button"
              onClick={() => exportRespondentTemplateWorkbook(frequency)}
              className="h-9 inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-xs font-bold text-slate-800 hover:bg-slate-50"
            >
              <Download className="h-3.5 w-3.5 text-slate-700" />
              <span>Download Template</span>
            </button>

            <button
              type="button"
              onClick={() => void handleLoadSample()}
              disabled={isLoading}
              className="h-9 inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-xs font-bold text-slate-800 hover:bg-slate-50 disabled:opacity-50"
            >
              <FileSpreadsheet className="h-3.5 w-3.5 text-sky-700" />
              <span>Muat Contoh {frequency}</span>
            </button>

            <label className="h-9 inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-3.5 text-xs font-bold text-white hover:bg-slate-800 cursor-pointer">
              <Upload className="h-3.5 w-3.5" />
              <span>Upload File Responden</span>
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
                      {loaded.observations.length} responden
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
      </section>

      {!currentDataset ? (
        <section className="rounded-lg border border-dashed border-slate-300 bg-white p-10 text-center">
          <Layers className="h-7 w-7 text-slate-400 mx-auto mb-2.5" />
          <h3 className="text-sm font-bold text-slate-800">
            Belum Ada Data Responden {frequency} ({targetRegion}) Dimuat
          </h3>
          <p className="mt-1 text-xs text-slate-500 max-w-xl mx-auto">
            Klik <strong>Muat Template {frequency}</strong> untuk menampilkan tabel analisis RH per responden dari template CSV terlampir, atau unggah file `.csv`/`.xlsx` responden.
          </p>
        </section>
      ) : (
        <>
          {/* Respondent-Level KPI Strip */}
          <section className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <div className="rounded-lg border border-slate-200 bg-white p-3.5">
              <span className="text-xs font-semibold text-slate-500 block">Total Observasi</span>
              <span className="mt-1 text-2xl font-mono font-extrabold text-slate-900 block tabular-nums">
                {stats.total}
              </span>
            </div>
            <div
              onClick={() => setMovementFilter(movementFilter === 'UP' ? 'ALL' : 'UP')}
              className={`rounded-lg border p-3.5 cursor-pointer transition-colors ${
                movementFilter === 'UP'
                  ? 'border-rose-500 bg-rose-50/50'
                  : 'border-slate-200 bg-white hover:border-slate-300'
              }`}
            >
              <span className="text-xs text-rose-700 font-semibold block">Harga Naik (RH &gt; 100)</span>
              <span className="mt-1 text-2xl font-mono font-extrabold text-rose-700 block tabular-nums">
                {stats.up}
              </span>
            </div>
            <div
              onClick={() => setMovementFilter(movementFilter === 'DOWN' ? 'ALL' : 'DOWN')}
              className={`rounded-lg border p-3.5 cursor-pointer transition-colors ${
                movementFilter === 'DOWN'
                  ? 'border-emerald-500 bg-emerald-50/50'
                  : 'border-slate-200 bg-white hover:border-slate-300'
              }`}
            >
              <span className="text-xs text-emerald-700 font-semibold block">Harga Turun (RH &lt; 100)</span>
              <span className="mt-1 text-2xl font-mono font-extrabold text-emerald-700 block tabular-nums">
                {stats.down}
              </span>
            </div>
            <div
              onClick={() => setMovementFilter(movementFilter === 'FLAT' ? 'ALL' : 'FLAT')}
              className={`rounded-lg border p-3.5 cursor-pointer transition-colors ${
                movementFilter === 'FLAT'
                  ? 'border-sky-500 bg-sky-50/50'
                  : 'border-slate-200 bg-white hover:border-slate-300'
              }`}
            >
              <span className="text-xs font-semibold text-slate-500 block">Harga Tetap (RH = 100)</span>
              <span className="mt-1 text-2xl font-mono font-extrabold text-slate-900 block tabular-nums">
                {stats.flat}
              </span>
            </div>
            <div
              onClick={() => setMovementFilter(movementFilter === 'MISSING' ? 'ALL' : 'MISSING')}
              className={`rounded-lg border p-3.5 cursor-pointer transition-colors ${
                movementFilter === 'MISSING'
                  ? 'border-amber-500 bg-amber-50/50'
                  : 'border-slate-200 bg-white hover:border-slate-300'
              }`}
            >
              <span className="text-xs font-semibold text-amber-700 block">Harga Kosong / Nol</span>
              <span className="mt-1 text-2xl font-mono font-extrabold text-amber-700 block tabular-nums">
                {stats.missing}
              </span>
            </div>
          </section>

          {/* Filter & Respondent-Level Analytical Table */}
          <section className="rounded-lg border border-slate-200 bg-white overflow-hidden">
            <div className="p-4 border-b border-slate-200 flex flex-wrap items-end justify-between gap-3">
              <div className="flex flex-wrap items-end gap-2.5 flex-1">
                <div>
                  <label
                    htmlFor="resp-comm"
                    className="block text-xs font-bold text-slate-700 mb-1"
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
                    className="h-9 rounded-md border border-slate-300 bg-white px-2.5 text-xs font-semibold text-slate-800 focus:border-slate-900 focus:outline-none max-w-[230px]"
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

                <div>
                  <label
                    htmlFor="resp-mkt"
                    className="block text-xs font-bold text-slate-700 mb-1"
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
                    className="h-9 rounded-md border border-slate-300 bg-white px-2.5 text-xs font-semibold text-slate-800 focus:border-slate-900 focus:outline-none"
                  >
                    <option value="ALL">Semua Jenis Pasar</option>
                    {marketTypes.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="resp-mov"
                    className="block text-xs font-bold text-slate-700 mb-1"
                  >
                    Status RH
                  </label>
                  <select
                    id="resp-mov"
                    value={movementFilter}
                    onChange={(e) => {
                      setMovementFilter(e.target.value as MovementFilter);
                      setCurrentPage(1);
                    }}
                    className="h-9 rounded-md border border-slate-300 bg-white px-2.5 text-xs font-semibold text-slate-800 focus:border-slate-900 focus:outline-none"
                  >
                    <option value="ALL">Semua Pergerakan</option>
                    <option value="UP">Naik (RH &gt; 100)</option>
                    <option value="DOWN">Turun (RH &lt; 100)</option>
                    <option value="FLAT">Tetap (RH = 100)</option>
                    <option value="MISSING">Harga Kosong (.00)</option>
                  </select>
                </div>

                <div className="flex-1 min-w-[200px]">
                  <label
                    htmlFor="resp-search"
                    className="block text-xs font-bold text-slate-700 mb-1"
                  >
                    Cari Responden / Pasar / Kualitas
                  </label>
                  <div className="relative">
                    <Search className="h-3.5 w-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      id="resp-search"
                      type="text"
                      value={searchQuery}
                      onChange={(e) => {
                        setSearchQuery(e.target.value);
                        setCurrentPage(1);
                      }}
                      placeholder="Nama toko, pasar, kualitas, komoditas..."
                      className="h-9 w-full rounded-md border border-slate-300 bg-white pl-8 pr-3 text-xs font-medium text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none"
                    />
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <label className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-700 cursor-pointer mr-1">
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
                    onClick={handleReplaceMissingWith100}
                    className="h-9 inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-3 text-xs font-bold text-amber-900 hover:bg-amber-100"
                  >
                    <span>Replace RH Kosong → 100 ({stats.missing})</span>
                  </button>
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

            <div className="overflow-x-auto max-h-[62vh]">
              <table className="w-full text-left border-collapse text-xs">
                <thead className="sticky top-0 z-20 bg-slate-100 border-b border-slate-300 text-[11px] font-bold text-slate-800 select-none">
                  {/* Super Header Row: Kelompok Harga N-1 & Harga N */}
                  <tr>
                    <th
                      rowSpan={2}
                      onClick={() => toggleSort('KOMODITAS')}
                      className="py-2.5 px-3 border-r border-slate-200 cursor-pointer hover:bg-slate-200/70 whitespace-nowrap align-middle"
                    >
                      <span className="inline-flex items-center gap-1">
                        Komoditas {renderSortIcon('KOMODITAS')}
                      </span>
                    </th>
                    <th
                      rowSpan={2}
                      onClick={() => toggleSort('KUALITAS')}
                      className="py-2.5 px-3 border-r border-slate-200 cursor-pointer hover:bg-slate-200/70 min-w-[170px] align-middle"
                    >
                      <span className="inline-flex items-center gap-1">
                        Kualitas {renderSortIcon('KUALITAS')}
                      </span>
                    </th>
                    <th
                      rowSpan={2}
                      onClick={() => toggleSort('PASAR')}
                      className="py-2.5 px-3 border-r border-slate-200 cursor-pointer hover:bg-slate-200/70 min-w-[150px] align-middle"
                    >
                      <span className="inline-flex items-center gap-1">
                        Pasar & Jenis {renderSortIcon('PASAR')}
                      </span>
                    </th>
                    <th
                      rowSpan={2}
                      onClick={() => toggleSort('RESPONDEN')}
                      className="py-2.5 px-3 border-r border-slate-200 cursor-pointer hover:bg-slate-200/70 min-w-[140px] align-middle"
                    >
                      <span className="inline-flex items-center gap-1">
                        Nama Responden {renderSortIcon('RESPONDEN')}
                      </span>
                    </th>
                    <th
                      colSpan={meta.periodCols.length}
                      className="py-1.5 px-2 text-center border-b border-r border-sky-200 bg-sky-100/80 text-sky-950 font-bold whitespace-nowrap"
                    >
                      Harga Bulan Sebelumnya (N-1)
                    </th>
                    <th
                      colSpan={meta.periodCols.length}
                      className="py-1.5 px-2 text-center border-b border-r border-amber-200 bg-amber-100/80 text-amber-950 font-bold whitespace-nowrap"
                    >
                      Harga Bulan Berjalan (N)
                    </th>
                    <th
                      rowSpan={2}
                      onClick={() => toggleSort('AVG_PREV')}
                      className="py-2.5 px-2.5 text-right border-r border-slate-200 cursor-pointer hover:bg-slate-200/70 whitespace-nowrap align-middle"
                    >
                      <span className="inline-flex items-center justify-end gap-1">
                        Rata² N-1 {renderSortIcon('AVG_PREV')}
                      </span>
                    </th>
                    <th
                      rowSpan={2}
                      onClick={() => toggleSort('AVG_CURR')}
                      className="py-2.5 px-2.5 text-right border-r border-slate-200 cursor-pointer hover:bg-slate-200/70 whitespace-nowrap align-middle"
                    >
                      <span className="inline-flex items-center justify-end gap-1">
                        Rata² N {renderSortIcon('AVG_CURR')}
                      </span>
                    </th>
                    <th
                      rowSpan={2}
                      onClick={() => toggleSort('RH')}
                      className="py-2.5 px-3 text-right border-r border-slate-200 cursor-pointer hover:bg-slate-200/70 whitespace-nowrap align-middle"
                    >
                      <span className="inline-flex items-center justify-end gap-1">
                        RH Responden {renderSortIcon('RH')}
                      </span>
                    </th>
                    <th
                      rowSpan={2}
                      onClick={() => toggleSort('PCT')}
                      className="py-2.5 px-3 text-right cursor-pointer hover:bg-slate-200/70 whitespace-nowrap align-middle"
                    >
                      <span className="inline-flex items-center justify-end gap-1">
                        Perubahan {renderSortIcon('PCT')}
                      </span>
                    </th>
                  </tr>

                  {/* Sub-header Row: aligned individual M1, M2, M3, M4, M5 columns */}
                  <tr>
                    {meta.periodCols.map((col, idx) => {
                      const k: RespSortKey = `PREV_${idx}`;
                      return (
                        <th
                          key={`prev-${col}`}
                          onClick={() => toggleSort(k)}
                          className="py-1.5 px-2.5 text-right border-r border-sky-200/80 bg-sky-50 text-sky-900 cursor-pointer hover:bg-sky-100 whitespace-nowrap"
                          title={`Harga N-1 ${col}`}
                        >
                          <span className="inline-flex items-center justify-end gap-1">
                            {col} {renderSortIcon(k)}
                          </span>
                        </th>
                      );
                    })}
                    {meta.periodCols.map((col, idx) => {
                      const k: RespSortKey = `CURR_${idx}`;
                      return (
                        <th
                          key={`curr-${col}`}
                          onClick={() => toggleSort(k)}
                          className="py-1.5 px-2.5 text-right border-r border-amber-200/80 bg-amber-50 text-amber-900 cursor-pointer hover:bg-amber-100 whitespace-nowrap"
                          title={`Harga N ${col}`}
                        >
                          <span className="inline-flex items-center justify-end gap-1">
                            {col} {renderSortIcon(k)}
                          </span>
                        </th>
                      );
                    })}
                  </tr>
                </thead>

                <tbody className="divide-y divide-slate-100">
                  {pagedRows.length === 0 ? (
                    <tr>
                      <td colSpan={totalTableCols} className="py-10 text-center text-slate-500">
                        Tidak ada observasi responden yang cocok dengan filter.
                      </td>
                    </tr>
                  ) : (
                    pagedRows.map((obs) => {
                      const pctChange =
                        obs.priceRelative !== null ? obs.priceRelative - 100 : null;
                      return (
                        <tr key={obs.id} className="hover:bg-slate-50/90 transition-colors">
                          <td className="py-2 px-3 border-r border-slate-100">
                            <span className="font-mono text-[11px] text-slate-500 block">
                              {obs.kodeKomoditas}
                            </span>
                            <span className="font-semibold text-slate-900">
                              {obs.komoditas}
                            </span>
                          </td>
                          <td className="py-2 px-3 border-r border-slate-100">
                            <span className="text-slate-800 font-medium block">
                              {obs.kualitas}
                            </span>
                            <span className="font-mono text-[10px] text-slate-500">
                              {obs.kodeKualitas} · Bobot {formatNumber(obs.bobotKualitas, 2)}
                            </span>
                          </td>
                          <td className="py-2 px-3 border-r border-slate-100">
                            <span className="text-slate-800 block">{obs.pasar}</span>
                            <span className="text-[10px] text-slate-500">
                              {obs.jenisPasar}
                            </span>
                          </td>
                          <td className="py-2 px-3 border-r border-slate-100 font-semibold text-slate-900">
                            {obs.namaResponden}
                          </td>

                          {/* Aligned Individual N-1 Price Columns */}
                          {meta.periodCols.map((col, idx) => {
                            const val = obs.prevPrices[idx] ?? null;
                            return (
                              <td
                                key={`${obs.id}-prev-${col}`}
                                className="py-2 px-2.5 text-right font-mono text-[11px] tabular-nums border-r border-slate-100 bg-sky-50/20 text-slate-600 whitespace-nowrap"
                              >
                                {val ? formatNumber(val, 0) : '—'}
                              </td>
                            );
                          })}

                          {/* Aligned Individual N Price Columns */}
                          {meta.periodCols.map((col, idx) => {
                            const val = obs.currPrices[idx] ?? null;
                            return (
                              <td
                                key={`${obs.id}-curr-${col}`}
                                className="py-2 px-2.5 text-right font-mono text-[11px] tabular-nums border-r border-slate-100 bg-amber-50/20 text-slate-900 font-medium whitespace-nowrap"
                              >
                                {val ? formatNumber(val, 0) : '—'}
                              </td>
                            );
                          })}

                          <td className="py-2 px-2.5 text-right font-mono tabular-nums text-slate-600 border-r border-slate-100 whitespace-nowrap">
                            {obs.prevAvgPrice ? formatNumber(obs.prevAvgPrice, 0) : '—'}
                          </td>
                          <td className="py-2 px-2.5 text-right font-mono tabular-nums font-semibold text-slate-900 border-r border-slate-100 whitespace-nowrap">
                            {obs.currAvgPrice ? formatNumber(obs.currAvgPrice, 0) : '—'}
                          </td>
                          <td
                            className={`py-2 px-3 text-right font-mono tabular-nums border-r border-slate-100 whitespace-nowrap ${rhColor(
                              obs.priceRelative
                            )}`}
                          >
                            {obs.priceRelative ? formatIndex(obs.priceRelative, 3) : 'Kosong'}
                          </td>
                          <td
                            className={`py-2 px-3 text-right font-mono tabular-nums whitespace-nowrap ${rhColor(
                              obs.priceRelative
                            )}`}
                          >
                            {pctChange !== null ? formatSignedPct(pctChange, 2) : '—'}
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
          </section>
        </>
      )}
    </div>
  );
};
