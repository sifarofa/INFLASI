import React, { useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowDownRight,
  ArrowUp,
  ArrowUpDown,
  ArrowUpRight,
  Download,
  Search,
} from 'lucide-react';
import type {
  AdminRole,
  HierarchyFlag,
  PeriodSelection,
  RegionCode,
  RegionLKResult,
  TabelJejerRow,
} from '../types/inflasi';
import {
  formatPeriodLabel,
  getCurrentMonthLabel,
  getRegionInfo,
  JEJER_COLUMN_ORDER,
  REGIONS,
} from '../data/regions';
import { formatIndex, formatNumber, formatSignedPct } from '../utils/formatters';
import { exportTabelJejerWorkbook, type JejerMetricExport } from '../utils/excelExporter';

interface DashboardViewProps {
  results: Record<RegionCode, RegionLKResult>;
  jejerRows: TabelJejerRow[];
  period: PeriodSelection;
  selectedRegion: RegionCode;
  userRole: AdminRole;
  allowedRegion: RegionCode;
  onSelectRegion: (code: RegionCode) => void;
  onNavigateToLK: (code: RegionCode) => void;
}

type DirectionFilter = 'ALL' | 'MOVED' | 'POSITIVE' | 'NEGATIVE';
type LevelView = 'COMMODITY' | 'KELOMPOK' | 'SUBKELOMPOK';
type ProvinsiSortKey = 'CODE' | 'NAMA' | 'ARAH' | RegionCode;
type KabKotaSortKey = 'CODE' | 'NAMA' | 'ANDIL' | 'ANDIL_BPS' | 'INFLASI' | 'RH' | 'IHK' | 'ARAH';
type SortDir = 'asc' | 'desc';

export const DashboardView: React.FC<DashboardViewProps> = ({
  results,
  jejerRows,
  period,
  selectedRegion,
  userRole,
  allowedRegion,
  onSelectRegion,
  onNavigateToLK,
}) => {
  const isProvinsi = userRole === 'PROVINSI';
  const targetRegion: RegionCode = isProvinsi ? selectedRegion : allowedRegion;

  const [metric, setMetric] = useState<JejerMetricExport>('andil');
  const [levelView, setLevelView] = useState<LevelView>('COMMODITY');
  const [kelompokFilter, setKelompokFilter] = useState<string>('ALL');
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');

  const [provSortKey, setProvSortKey] = useState<ProvinsiSortKey>('6100');
  const [provSortDir, setProvSortDir] = useState<SortDir>('desc');

  const [kabSortKey, setKabSortKey] = useState<KabKotaSortKey>('ANDIL');
  const [kabSortDir, setKabSortDir] = useState<SortDir>('desc');

  const currMonth = getCurrentMonthLabel(period);
  const periodShort = `${currMonth.slice(0, 3)} ${period.year}`;
  const regionMeta = getRegionInfo(targetRegion);
  const scopedResult = results[targetRegion];

  const kelompokOptions = useMemo(
    () => (isProvinsi ? results['6100'].kelompokList : scopedResult.kelompokList),
    [isProvinsi, results, scopedResult]
  );

  const umumRow = useMemo(() => jejerRows.find((r) => r.flag === 0), [jejerRows]);

  const getNumericVal = (row: TabelJejerRow, rCode: RegionCode): number | null => {
    const cell = row.cells[rCode];
    if (!cell || !cell.inPakom) return null;
    if (metric === 'andil') return cell.andilInflasi ?? 0;
    if (metric === 'andilBps') return (cell.andilInflasi ?? 0) * 100;
    if (metric === 'inflasi') return cell.inflasi ?? 0;
    if (metric === 'rh') return cell.rhCurrent ?? 100;
    return cell.ihkCurrent ?? 0;
  };

  // Provinsi: full 6-region Tabel Jejer filtering & sorting across all 9 columns
  const provinsiRows = useMemo(() => {
    if (!isProvinsi) return [];
    const targetFlag: HierarchyFlag =
      levelView === 'COMMODITY' ? 3 : levelView === 'KELOMPOK' ? 1 : 2;
    const q = searchQuery.trim().toLowerCase();

    const filtered = jejerRows.filter((row) => {
      if (row.flag !== targetFlag) return false;
      if (kelompokFilter !== 'ALL' && row.kelompokCode !== kelompokFilter) return false;
      if (q) {
        const hitKode = row.kode.toLowerCase().includes(q);
        const hitNama = row.nama.toLowerCase().includes(q);
        if (!hitKode && !hitNama) return false;
      }
      if (directionFilter !== 'ALL') {
        const hasMovement = JEJER_COLUMN_ORDER.some((c) => {
          const cell = row.cells[c];
          return cell.inPakom && Math.abs(cell.andilInflasi ?? 0) > 0.000001;
        });
        const kalbarAndil = row.cells['6100']?.andilInflasi ?? 0;
        if (directionFilter === 'MOVED' && !hasMovement) return false;
        if (directionFilter === 'POSITIVE' && kalbarAndil <= 0.000001) return false;
        if (directionFilter === 'NEGATIVE' && kalbarAndil >= -0.000001) return false;
      }
      return true;
    });

    return filtered.sort((a, b) => {
      if (provSortKey === 'CODE') {
        return provSortDir === 'asc'
          ? a.kode.localeCompare(b.kode)
          : b.kode.localeCompare(a.kode);
      }
      if (provSortKey === 'NAMA') {
        return provSortDir === 'asc'
          ? a.nama.localeCompare(b.nama)
          : b.nama.localeCompare(a.nama);
      }
      if (provSortKey === 'ARAH') {
        const scoreA = a.upCount - a.downCount;
        const scoreB = b.upCount - b.downCount;
        if (scoreA !== scoreB) {
          return provSortDir === 'desc' ? scoreB - scoreA : scoreA - scoreB;
        }
        return a.kode.localeCompare(b.kode);
      }
      const va = getNumericVal(a, provSortKey);
      const vb = getNumericVal(b, provSortKey);
      if (va === null && vb === null) return a.kode.localeCompare(b.kode);
      if (va === null) return 1;
      if (vb === null) return -1;
      return provSortDir === 'desc' ? vb - va : va - vb;
    });
  }, [
    isProvinsi,
    jejerRows,
    levelView,
    kelompokFilter,
    searchQuery,
    directionFilter,
    provSortKey,
    provSortDir,
    metric,
  ]);

  // Kab/Kota: strictly scoped single-region rows with all 8 columns sortable
  const kabKotaRows = useMemo(() => {
    if (isProvinsi) return [];
    const targetFlag: HierarchyFlag =
      levelView === 'COMMODITY' ? 3 : levelView === 'KELOMPOK' ? 1 : 2;
    const q = searchQuery.trim().toLowerCase();

    const sourceList =
      targetFlag === 3
        ? scopedResult.commodities
        : targetFlag === 1
        ? scopedResult.kelompokList
        : scopedResult.subkelompokList;

    const filtered = sourceList.filter((row) => {
      if (kelompokFilter !== 'ALL' && row.kelompokCode !== kelompokFilter) return false;
      if (q) {
        const hitKode = row.kode.toLowerCase().includes(q);
        const hitNama = row.nama.toLowerCase().includes(q);
        if (!hitKode && !hitNama) return false;
      }
      if (directionFilter === 'MOVED' && Math.abs(row.inflasi) <= 0.0001) return false;
      if (directionFilter === 'POSITIVE' && row.andilInflasi <= 0.000001) return false;
      if (directionFilter === 'NEGATIVE' && row.andilInflasi >= -0.000001) return false;
      return true;
    });

    return [...filtered].sort((a, b) => {
      if (kabSortKey === 'CODE') {
        return kabSortDir === 'asc'
          ? a.kode.localeCompare(b.kode)
          : b.kode.localeCompare(a.kode);
      }
      if (kabSortKey === 'NAMA') {
        return kabSortDir === 'asc'
          ? a.nama.localeCompare(b.nama)
          : b.nama.localeCompare(a.nama);
      }
      const getVal = (r: typeof a): number => {
        if (kabSortKey === 'ANDIL') return r.andilInflasi;
        if (kabSortKey === 'ANDIL_BPS') return r.andilInflasi * 100;
        if (kabSortKey === 'INFLASI' || kabSortKey === 'ARAH') return r.inflasi;
        if (kabSortKey === 'RH') return r.rhCurrent;
        return r.ihkCurrent;
      };
      const va = getVal(a);
      const vb = getVal(b);
      if (va === vb) return a.kode.localeCompare(b.kode);
      return kabSortDir === 'desc' ? vb - va : va - vb;
    });
  }, [
    isProvinsi,
    scopedResult,
    levelView,
    kelompokFilter,
    searchQuery,
    directionFilter,
    kabSortKey,
    kabSortDir,
  ]);

  const toggleProvSort = (key: ProvinsiSortKey) => {
    if (provSortKey === key) {
      setProvSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setProvSortKey(key);
      setProvSortDir(key === 'CODE' || key === 'NAMA' ? 'asc' : 'desc');
    }
  };

  const toggleKabSort = (key: KabKotaSortKey) => {
    if (kabSortKey === key) {
      setKabSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setKabSortKey(key);
      setKabSortDir(key === 'CODE' || key === 'NAMA' ? 'asc' : 'desc');
    }
  };

  const renderSortIcon = (active: boolean, dir: SortDir, dark = false) => {
    if (!active) {
      return <ArrowUpDown className={`h-3.5 w-3.5 shrink-0 ${dark ? 'opacity-45' : 'opacity-35'}`} />;
    }
    const cls = `h-3.5 w-3.5 shrink-0 ${dark ? 'text-sky-300' : 'text-slate-900'}`;
    return dir === 'asc' ? <ArrowUp className={cls} /> : <ArrowDown className={cls} />;
  };

  const metricGroupTitle: Record<JejerMetricExport, string> = {
    andil: `Andil Inflasi (%) — ${periodShort}`,
    andilBps: `Andil Inflasi (bps / ×100) — ${periodShort}`,
    inflasi: `Inflasi MtM (%) — ${periodShort}`,
    rh: `Relatif Harga (RH) — ${periodShort}`,
    ihk: `Indeks Harga Konsumen (IHK) — ${periodShort}`,
  };

  const formatCellDisplay = (val: number | null): string => {
    if (val === null) return '-';
    if (metric === 'rh' || metric === 'ihk') return formatNumber(val, 2);
    const zeroTol = metric === 'andil' ? 0.00005 : 0.0001;
    if (Math.abs(val) < zeroTol) return '0';
    return formatNumber(val, 4);
  };

  const cellStyleClass = (val: number | null, isKalbarCol: boolean) => {
    const baseBg = isKalbarCol ? 'bg-slate-50 font-bold' : '';
    if (val === null) return `text-slate-400 ${baseBg}`;
    if (metric === 'rh') {
      if (val > 100.001) return 'text-rose-700 font-semibold';
      if (val < 99.999) return 'text-emerald-700 font-semibold';
      return `text-slate-600 ${baseBg}`;
    }
    if (metric === 'ihk') return `text-slate-900 font-medium ${baseBg}`;
    const tol = metric === 'andil' ? 0.00005 : 0.0001;
    if (val > tol) {
      return `text-rose-700 ${isKalbarCol ? 'bg-rose-50/70 font-bold' : 'font-semibold'}`;
    }
    if (val < -tol) {
      return `text-emerald-700 ${isKalbarCol ? 'bg-emerald-50/70 font-bold' : 'font-semibold'}`;
    }
    return `text-slate-400 ${baseBg}`;
  };

  const cardOrder: RegionCode[] = ['6100', '6106', '6107', '6111', '6171', '6172'];
  const kabMovedCount = useMemo(
    () => scopedResult.commodities.filter((c) => Math.abs(c.inflasi) > 0.0005).length,
    [scopedResult]
  );

  return (
    <div className="space-y-6">
      {/* KPI Strip */}
      {isProvinsi ? (
        <section className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3.5">
          {cardOrder.map((code) => {
            const reg = REGIONS.find((r) => r.code === code)!;
            const res = results[code];
            const isSelected = selectedRegion === code;
            const isProv = code === '6100';

            return (
              <div
                key={code}
                onClick={() => onSelectRegion(code)}
                onDoubleClick={() => onNavigateToLK(code)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && onSelectRegion(code)}
                className={`rounded-lg border p-4 transition-colors cursor-pointer flex flex-col justify-between ${
                  isProv
                    ? 'bg-slate-900 text-white border-slate-900'
                    : isSelected
                    ? 'bg-white text-slate-900 border-slate-900 ring-1 ring-slate-900'
                    : 'bg-white text-slate-900 border-slate-200 hover:border-slate-400'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`text-xs font-mono font-bold tracking-tight ${
                      isProv ? 'text-slate-300' : 'text-slate-500'
                    }`}
                  >
                    {reg.code}
                  </span>
                  {res.umum.inflasi >= 0 ? (
                    <ArrowUpRight
                      className={`h-4 w-4 ${isProv ? 'text-rose-400' : 'text-rose-600'}`}
                    />
                  ) : (
                    <ArrowDownRight
                      className={`h-4 w-4 ${isProv ? 'text-emerald-400' : 'text-emerald-600'}`}
                    />
                  )}
                </div>

                <p className="mt-1 text-sm font-bold tracking-tight truncate">{reg.shortName}</p>

                <p
                  className={`mt-2.5 text-2xl font-extrabold font-mono tabular-nums tracking-tight ${
                    isProv
                      ? res.umum.inflasi >= 0
                        ? 'text-rose-300'
                        : 'text-emerald-300'
                      : res.umum.inflasi > 0.0005
                      ? 'text-rose-700'
                      : res.umum.inflasi < -0.0005
                      ? 'text-emerald-700'
                      : 'text-slate-900'
                  }`}
                >
                  {formatSignedPct(res.umum.inflasi, 2)}
                </p>

                <div
                  className={`mt-3 pt-2.5 border-t flex items-center justify-between text-[11px] font-mono font-medium tabular-nums ${
                    isProv ? 'border-slate-700 text-slate-300' : 'border-slate-100 text-slate-600'
                  }`}
                >
                  <span>IHK {formatIndex(res.umum.ihkCurrent, 2)}</span>
                  <span>{res.pakomCount} kom</span>
                </div>
              </div>
            );
          })}
        </section>
      ) : (
        <section className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
          <div className="rounded-lg border border-slate-900 bg-slate-900 text-white p-4">
            <span className="text-xs font-mono font-semibold text-slate-300">
              {regionMeta.code} · {regionMeta.name}
            </span>
            <p
              className={`mt-2 text-2xl font-extrabold font-mono tabular-nums ${
                scopedResult.umum.inflasi >= 0 ? 'text-rose-300' : 'text-emerald-300'
              }`}
            >
              {formatSignedPct(scopedResult.umum.inflasi, 3)}
            </p>
            <p className="mt-1 text-xs font-medium text-slate-300">
              Inflasi MtM ({periodShort})
            </p>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <span className="text-xs font-semibold text-slate-500">IHK Berjalan</span>
            <p className="mt-2 text-2xl font-extrabold font-mono tabular-nums text-slate-900">
              {formatIndex(scopedResult.umum.ihkCurrent, 2)}
            </p>
            <p className="mt-1 text-xs font-mono text-slate-500">
              Bulan lalu {formatIndex(scopedResult.umum.ihkPrev, 2)}
            </p>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <span className="text-xs font-semibold text-slate-500">Pakom Aktif</span>
            <p className="mt-2 text-2xl font-extrabold font-mono tabular-nums text-slate-900">
              {scopedResult.pakomCount}
            </p>
            <p className="mt-1 text-xs font-medium text-slate-500">Komoditas terpantau</p>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <span className="text-xs font-semibold text-slate-500">Komoditas Bergejolak</span>
            <p className="mt-2 text-2xl font-extrabold font-mono tabular-nums text-slate-900">
              {kabMovedCount}
            </p>
            <p className="mt-1 text-xs font-medium text-slate-500">
              Mengalami perubahan harga bulan ini
            </p>
          </div>
        </section>
      )}

      {/* Main Comparison Table */}
      <section className="rounded-lg border border-slate-200 bg-white overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 space-y-4">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-extrabold tracking-tight text-slate-900">
                {isProvinsi
                  ? 'Tabel Jejer Perbandingan Lintas Wilayah'
                  : `Ringkasan Inflasi Komoditas — ${regionMeta.name}`}
              </h2>
              <p className="text-xs font-medium text-slate-500 mt-0.5">
                {isProvinsi
                  ? `${formatPeriodLabel(period)} · 5 Kab/Kota & Agregasi Kalbar (6100) · Tanda - menandakan di luar pakom`
                  : `${formatPeriodLabel(period)} · Kode Wilayah ${regionMeta.code}`}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => onNavigateToLK(targetRegion)}
                className="rounded-md border border-slate-300 bg-white px-3.5 py-2 text-xs font-bold text-slate-800 hover:bg-slate-50 transition-colors whitespace-nowrap"
              >
                Buka LK {targetRegion}
              </button>
              <button
                type="button"
                onClick={() =>
                  exportTabelJejerWorkbook(
                    jejerRows,
                    period,
                    metric,
                    isProvinsi ? undefined : allowedRegion
                  )
                }
                className="inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-3.5 py-2 text-xs font-bold text-white hover:bg-slate-800 transition-colors whitespace-nowrap"
              >
                <Download className="h-3.5 w-3.5" />
                <span>Export Excel</span>
              </button>
            </div>
          </div>

          {/* Filter Row */}
          <div className="flex flex-wrap items-end gap-3 pt-3 border-t border-slate-100">
            {isProvinsi && (
              <div>
                <label
                  htmlFor="jejer-metric"
                  className="block text-xs font-bold text-slate-700 mb-1"
                >
                  Metrik
                </label>
                <select
                  id="jejer-metric"
                  value={metric}
                  onChange={(e) => setMetric(e.target.value as JejerMetricExport)}
                  className="h-9 rounded-md border border-slate-300 bg-white px-3 text-xs font-bold text-slate-900 focus:border-slate-900 focus:outline-none"
                >
                  <option value="andil">Andil Inflasi (%)</option>
                  <option value="andilBps">Andil Inflasi (bps / ×100)</option>
                  <option value="inflasi">Inflasi MtM (%)</option>
                  <option value="rh">Relatif Harga (RH)</option>
                  <option value="ihk">IHK Berjalan</option>
                </select>
              </div>
            )}

            <div>
              <label
                htmlFor="jejer-level"
                className="block text-xs font-bold text-slate-700 mb-1"
              >
                Level
              </label>
              <select
                id="jejer-level"
                value={levelView}
                onChange={(e) => setLevelView(e.target.value as LevelView)}
                className="h-9 rounded-md border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-900 focus:border-slate-900 focus:outline-none"
              >
                <option value="COMMODITY">Komoditas</option>
                <option value="KELOMPOK">11 Kelompok</option>
                <option value="SUBKELOMPOK">Subkelompok</option>
              </select>
            </div>

            <div>
              <label
                htmlFor="jejer-kelompok"
                className="block text-xs font-bold text-slate-700 mb-1"
              >
                Kelompok
              </label>
              <select
                id="jejer-kelompok"
                value={kelompokFilter}
                onChange={(e) => setKelompokFilter(e.target.value)}
                className="h-9 rounded-md border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-900 focus:border-slate-900 focus:outline-none max-w-[220px]"
              >
                <option value="ALL">Semua Kelompok (01–11)</option>
                {kelompokOptions.map((k) => (
                  <option key={k.kode} value={k.kode}>
                    {k.kode} — {k.nama}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="jejer-dir"
                className="block text-xs font-bold text-slate-700 mb-1"
              >
                Pergerakan
              </label>
              <select
                id="jejer-dir"
                value={directionFilter}
                onChange={(e) => setDirectionFilter(e.target.value as DirectionFilter)}
                className="h-9 rounded-md border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-900 focus:border-slate-900 focus:outline-none"
              >
                <option value="ALL">Semua Baris</option>
                <option value="MOVED">Bergejolak Saja (≠ 0)</option>
                <option value="POSITIVE">Penyumbang Inflasi (+)</option>
                <option value="NEGATIVE">Penyumbang Deflasi (-)</option>
              </select>
            </div>

            <div className="flex-1 min-w-[200px]">
              <label
                htmlFor="jejer-search"
                className="block text-xs font-bold text-slate-700 mb-1"
              >
                Cari Komoditas / Kode
              </label>
              <div className="relative">
                <Search className="h-3.5 w-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  id="jejer-search"
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Contoh: DAGING AYAM, CABAI, 011..."
                  className="h-9 w-full rounded-md border border-slate-300 bg-white pl-8 pr-3 text-xs font-medium text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none"
                />
              </div>
            </div>
          </div>
        </div>

        {/* Table Body */}
        <div className="overflow-y-auto overflow-x-hidden max-h-[70vh]">
          {isProvinsi ? (
            <table className="w-full table-fixed text-left border-collapse text-[11px]">
              <colgroup>
                <col className="w-[8%]" />
                <col className="w-[28%]" />
                <col className="w-[9%]" />
                <col className="w-[9%]" />
                <col className="w-[9%]" />
                <col className="w-[9%]" />
                <col className="w-[9%]" />
                <col className="w-[9%]" />
                <col className="w-[10%]" />
              </colgroup>
              <thead className="sticky top-0 z-20">
                <tr className="bg-slate-900 text-white text-[11px] font-bold">
                  <th
                    rowSpan={2}
                    onClick={() => toggleProvSort('CODE')}
                    className="py-2 px-2 border-r border-slate-700 cursor-pointer hover:bg-slate-800 select-none align-middle"
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="truncate">Kode</span>
                      {renderSortIcon(provSortKey === 'CODE', provSortDir, true)}
                    </div>
                  </th>
                  <th
                    rowSpan={2}
                    onClick={() => toggleProvSort('NAMA')}
                    className="py-2 px-2 border-r border-slate-700 cursor-pointer hover:bg-slate-800 select-none align-middle"
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="truncate">Komoditas / Kelompok</span>
                      {renderSortIcon(provSortKey === 'NAMA', provSortDir, true)}
                    </div>
                  </th>
                  <th
                    colSpan={6}
                    className="py-1.5 px-2 text-center border-b border-slate-700 bg-emerald-800 text-white tracking-tight font-bold truncate"
                  >
                    {metricGroupTitle[metric]}
                  </th>
                  <th
                    rowSpan={2}
                    onClick={() => toggleProvSort('ARAH')}
                    className="py-2 px-1.5 text-center border-l border-slate-700 cursor-pointer hover:bg-slate-800 select-none align-middle"
                  >
                    <div className="inline-flex items-center justify-center gap-0.5 leading-tight">
                      <span>Arah</span>
                      {renderSortIcon(provSortKey === 'ARAH', provSortDir, true)}
                    </div>
                  </th>
                </tr>

                <tr className="bg-slate-100 text-slate-900 border-b border-slate-300 text-[11px] font-bold">
                  {JEJER_COLUMN_ORDER.map((rCode) => {
                    const reg = REGIONS.find((r) => r.code === rCode)!;
                    const isSorted = provSortKey === rCode;
                    const isKalbar = rCode === '6100';
                    const shortLabel =
                      rCode === '6106'
                        ? 'Ketapang'
                        : rCode === '6107'
                        ? 'Sintang'
                        : rCode === '6111'
                        ? 'KKU'
                        : rCode === '6171'
                        ? 'Pontianak'
                        : rCode === '6172'
                        ? 'Singkawang'
                        : 'Kalbar';
                    return (
                      <th
                        key={rCode}
                        onClick={() => toggleProvSort(rCode)}
                        title={reg.name}
                        className={`py-1.5 px-1.5 text-right border-r border-slate-200 cursor-pointer select-none transition-colors ${
                          isKalbar
                            ? 'bg-slate-200 text-slate-900 hover:bg-slate-300'
                            : 'hover:bg-slate-200/70'
                        }`}
                      >
                        <div className="flex items-center justify-end gap-0.5">
                          <span className="truncate">{shortLabel}</span>
                          {renderSortIcon(isSorted, provSortDir)}
                        </div>
                      </th>
                    );
                  })}
                </tr>

                {umumRow && (
                  <tr className="bg-slate-900 text-white font-mono text-[11px] border-b border-slate-700">
                    <td className="py-2 px-2 border-r border-slate-700 font-bold">0</td>
                    <td className="py-2 px-2 font-sans font-extrabold border-r border-slate-700 truncate">
                      TOTAL / UMUM
                    </td>
                    {JEJER_COLUMN_ORDER.map((rCode) => {
                      const val = getNumericVal(umumRow, rCode);
                      return (
                        <td
                          key={rCode}
                          className={`py-2 px-1.5 text-right tabular-nums border-r border-slate-800 truncate ${
                            rCode === '6100' ? 'bg-slate-800 font-extrabold' : 'font-semibold'
                          }`}
                        >
                          {formatCellDisplay(val)}
                        </td>
                      );
                    })}
                    <td className="py-2 px-1.5 text-center font-sans font-semibold text-slate-200">
                      {umumRow.upCount}↑ · {umumRow.downCount}↓
                    </td>
                  </tr>
                )}
              </thead>

              <tbody className="divide-y divide-slate-100">
                {provinsiRows.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="py-10 text-center text-slate-500 font-medium">
                      Tidak ada baris yang sesuai dengan filter saat ini.
                    </td>
                  </tr>
                ) : (
                  provinsiRows.map((row) => (
                    <tr key={row.kode} className="hover:bg-slate-50 transition-colors">
                      <td className="py-2 px-2 font-mono text-[11px] font-medium text-slate-600 border-r border-slate-100 truncate">
                        {row.kode}
                      </td>
                      <td
                        className="py-2 px-2 font-semibold text-slate-900 border-r border-slate-100 truncate"
                        title={row.nama}
                      >
                        {row.nama}
                      </td>
                      {JEJER_COLUMN_ORDER.map((rCode) => {
                        const val = getNumericVal(row, rCode);
                        const isKalbar = rCode === '6100';
                        return (
                          <td
                            key={rCode}
                            className={`py-2 px-1.5 text-right font-mono tabular-nums border-r border-slate-100 truncate ${cellStyleClass(
                              val,
                              isKalbar
                            )}`}
                          >
                            {formatCellDisplay(val)}
                          </td>
                        );
                      })}
                      <td className="py-2 px-1.5 text-center font-mono text-[11px] truncate">
                        {row.upCount === 0 && row.downCount === 0 ? (
                          <span className="text-slate-400 font-medium">Stabil</span>
                        ) : row.upCount > 0 && row.downCount === 0 ? (
                          <span className="text-rose-700 font-bold">
                            {row.upCount}/{row.activeRegionCount} ↑
                          </span>
                        ) : row.downCount > 0 && row.upCount === 0 ? (
                          <span className="text-emerald-700 font-bold">
                            {row.downCount}/{row.activeRegionCount} ↓
                          </span>
                        ) : (
                          <span className="text-amber-700 font-bold">
                            {row.upCount}↑/{row.downCount}↓
                          </span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          ) : (
            <table className="w-full table-fixed text-left border-collapse text-[11px]">
              <colgroup>
                <col className="w-[9%]" />
                <col className="w-[33%]" />
                <col className="w-[10%]" />
                <col className="w-[10%]" />
                <col className="w-[11%]" />
                <col className="w-[9%]" />
                <col className="w-[9%]" />
                <col className="w-[9%]" />
              </colgroup>
              <thead className="sticky top-0 z-20">
                <tr className="bg-slate-900 text-white text-[11px] font-bold">
                  <th
                    onClick={() => toggleKabSort('CODE')}
                    className="py-2 px-2 border-r border-slate-700 cursor-pointer hover:bg-slate-800 select-none"
                  >
                    <div className="flex items-center gap-1">
                      <span className="truncate">Kode</span>
                      {renderSortIcon(kabSortKey === 'CODE', kabSortDir, true)}
                    </div>
                  </th>
                  <th
                    onClick={() => toggleKabSort('NAMA')}
                    className="py-2 px-2 border-r border-slate-700 cursor-pointer hover:bg-slate-800 select-none"
                  >
                    <div className="flex items-center gap-1">
                      <span className="truncate">Komoditas / Kelompok</span>
                      {renderSortIcon(kabSortKey === 'NAMA', kabSortDir, true)}
                    </div>
                  </th>
                  <th
                    onClick={() => toggleKabSort('ANDIL')}
                    className="py-2 px-2 text-right border-r border-slate-700 cursor-pointer hover:bg-slate-800 select-none"
                  >
                    <div className="flex items-center justify-end gap-1">
                      <span className="truncate">Andil (%)</span>
                      {renderSortIcon(kabSortKey === 'ANDIL', kabSortDir, true)}
                    </div>
                  </th>
                  <th
                    onClick={() => toggleKabSort('ANDIL_BPS')}
                    className="py-2 px-2 text-right border-r border-slate-700 cursor-pointer hover:bg-slate-800 select-none"
                  >
                    <div className="flex items-center justify-end gap-1">
                      <span className="truncate">Andil (bps)</span>
                      {renderSortIcon(kabSortKey === 'ANDIL_BPS', kabSortDir, true)}
                    </div>
                  </th>
                  <th
                    onClick={() => toggleKabSort('INFLASI')}
                    className="py-2 px-2 text-right border-r border-slate-700 cursor-pointer hover:bg-slate-800 select-none"
                  >
                    <div className="flex items-center justify-end gap-1">
                      <span className="truncate">Inflasi MtM</span>
                      {renderSortIcon(kabSortKey === 'INFLASI', kabSortDir, true)}
                    </div>
                  </th>
                  <th
                    onClick={() => toggleKabSort('RH')}
                    className="py-2 px-2 text-right border-r border-slate-700 cursor-pointer hover:bg-slate-800 select-none"
                  >
                    <div className="flex items-center justify-end gap-1">
                      <span className="truncate">RH (N)</span>
                      {renderSortIcon(kabSortKey === 'RH', kabSortDir, true)}
                    </div>
                  </th>
                  <th
                    onClick={() => toggleKabSort('IHK')}
                    className="py-2 px-2 text-right border-r border-slate-700 cursor-pointer hover:bg-slate-800 select-none"
                  >
                    <div className="flex items-center justify-end gap-1">
                      <span className="truncate">IHK (N)</span>
                      {renderSortIcon(kabSortKey === 'IHK', kabSortDir, true)}
                    </div>
                  </th>
                  <th
                    onClick={() => toggleKabSort('ARAH')}
                    className="py-2 px-2 text-center cursor-pointer hover:bg-slate-800 select-none"
                  >
                    <div className="flex items-center justify-center gap-1">
                      <span className="truncate">Arah</span>
                      {renderSortIcon(kabSortKey === 'ARAH', kabSortDir, true)}
                    </div>
                  </th>
                </tr>

                <tr className="bg-slate-800 text-white font-mono text-[11px] border-b border-slate-700">
                  <td className="py-2 px-2 border-r border-slate-700 font-bold">0</td>
                  <td className="py-2 px-2 font-sans font-extrabold border-r border-slate-700 truncate">
                    TOTAL / UMUM ({regionMeta.shortName})
                  </td>
                  <td className="py-2 px-2 text-right tabular-nums border-r border-slate-700 font-bold">
                    {formatNumber(scopedResult.umum.andilInflasi, 4)}
                  </td>
                  <td className="py-2 px-2 text-right tabular-nums border-r border-slate-700 font-bold">
                    {formatNumber(scopedResult.umum.andilInflasi * 100, 2)}
                  </td>
                  <td className="py-2 px-2 text-right tabular-nums border-r border-slate-700 font-bold">
                    {formatSignedPct(scopedResult.umum.inflasi, 3)}
                  </td>
                  <td className="py-2 px-2 text-right tabular-nums border-r border-slate-700">
                    {formatNumber(scopedResult.umum.rhCurrent, 3)}
                  </td>
                  <td className="py-2 px-2 text-right tabular-nums border-r border-slate-700">
                    {formatIndex(scopedResult.umum.ihkCurrent, 2)}
                  </td>
                  <td className="py-2 px-2 text-center font-sans font-bold">
                    {scopedResult.umum.inflasi > 0.0005
                      ? 'Inflasi ↑'
                      : scopedResult.umum.inflasi < -0.0005
                      ? 'Deflasi ↓'
                      : 'Stabil'}
                  </td>
                </tr>
              </thead>

              <tbody className="divide-y divide-slate-100">
                {kabKotaRows.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-10 text-center text-slate-500 font-medium">
                      Tidak ada baris yang sesuai dengan filter saat ini.
                    </td>
                  </tr>
                ) : (
                  kabKotaRows.map((row) => (
                    <tr key={row.kode} className="hover:bg-slate-50 transition-colors">
                      <td className="py-2 px-2 font-mono text-[11px] font-medium text-slate-600 border-r border-slate-100 truncate">
                        {row.kode}
                      </td>
                      <td
                        className="py-2 px-2 font-semibold text-slate-900 border-r border-slate-100 truncate"
                        title={row.nama}
                      >
                        {row.nama}
                      </td>
                      <td
                        className={`py-2 px-2 text-right font-mono tabular-nums border-r border-slate-100 font-semibold ${
                          row.andilInflasi > 0.00005
                            ? 'text-rose-700'
                            : row.andilInflasi < -0.00005
                            ? 'text-emerald-700'
                            : 'text-slate-400'
                        }`}
                      >
                        {Math.abs(row.andilInflasi) < 0.00005 ? '0' : formatNumber(row.andilInflasi, 4)}
                      </td>
                      <td
                        className={`py-2 px-2 text-right font-mono tabular-nums border-r border-slate-100 ${
                          row.andilInflasi > 0.00005
                            ? 'text-rose-700 font-semibold'
                            : row.andilInflasi < -0.00005
                            ? 'text-emerald-700 font-semibold'
                            : 'text-slate-400'
                        }`}
                      >
                        {Math.abs(row.andilInflasi * 100) < 0.005
                          ? '0'
                          : formatNumber(row.andilInflasi * 100, 2)}
                      </td>
                      <td
                        className={`py-2 px-2 text-right font-mono tabular-nums border-r border-slate-100 font-semibold ${
                          row.inflasi > 0.0005
                            ? 'text-rose-700'
                            : row.inflasi < -0.0005
                            ? 'text-emerald-700'
                            : 'text-slate-500'
                        }`}
                      >
                        {formatSignedPct(row.inflasi, 3)}
                      </td>
                      <td className="py-2 px-2 text-right font-mono tabular-nums border-r border-slate-100 text-slate-800">
                        {formatNumber(row.rhCurrent, 3)}
                      </td>
                      <td className="py-2 px-2 text-right font-mono tabular-nums border-r border-slate-100 font-semibold text-slate-900">
                        {formatIndex(row.ihkCurrent, 2)}
                      </td>
                      <td className="py-2 px-2 text-center font-mono text-[11px] font-bold">
                        {row.inflasi > 0.0005 ? (
                          <span className="text-rose-700">Naik ↑</span>
                        ) : row.inflasi < -0.0005 ? (
                          <span className="text-emerald-700">Turun ↓</span>
                        ) : (
                          <span className="text-slate-400 font-medium">Stabil</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-2.5 border-t border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-2 text-xs font-medium text-slate-600">
          <span>
            Menampilkan{' '}
            <strong className="font-bold text-slate-900">
              {isProvinsi ? provinsiRows.length : kabKotaRows.length}
            </strong>{' '}
            baris
          </span>
          <span>Klik header kolom mana saja untuk mengurutkan data</span>
        </div>
      </section>
    </div>
  );
};
