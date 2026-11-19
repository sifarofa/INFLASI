import React, { useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Calculator,
  CheckCircle2,
  Download,
  Edit3,
  Loader2,
  Lock,
  RefreshCw,
  RotateCcw,
  Search,
} from 'lucide-react';
import type {
  AdminRole,
  KabKotaCode,
  LKCalculatedRow,
  PeriodSelection,
  RegionCode,
  RegionLKResult,
} from '../types/inflasi';
import type { SupabaseConnectionStatus } from '../lib/supabase';
import {
  formatPeriodLabel,
  getCurrentMonthLabel,
  getPrevMonthLabel,
  getRegionInfo,
  KAB_KOTA_CODES,
} from '../data/regions';
import { formatAndil, formatIndex, formatNK, formatNumber, formatSignedPct } from '../utils/formatters';
import { exportSingleRegionWorkbook } from '../utils/excelExporter';

interface LembarKerjaViewProps {
  results: Record<RegionCode, RegionLKResult>;
  period: PeriodSelection;
  selectedRegion: RegionCode;
  userRole: AdminRole;
  allowedRegion: RegionCode;
  connectionStatus?: SupabaseConnectionStatus;
  onRolloverPrevMonth?: (targetRegions: KabKotaCode[]) => Promise<{
    totalRolledRows: number;
    prevPeriod: PeriodSelection;
    perRegionCounts: Partial<Record<KabKotaCode, number>>;
  }>;
  onUpdateCommodityInput: (
    regionCode: KabKotaCode,
    kode: string,
    field: 'nkPrev' | 'rhCurrent',
    value: number
  ) => void;
}

type LevelFilter = 'ALL' | 'SUMMARY' | 'COMMODITY';
type LKSortKey =
  | 'DEFAULT'
  | 'KODE'
  | 'NAMA'
  | 'NK0'
  | 'NK_PREV'
  | 'NK_CURR'
  | 'PCT_PREV'
  | 'PCT_CURR'
  | 'RH'
  | 'ANDIL'
  | 'IHK_PREV'
  | 'IHK_CURR'
  | 'INFLASI';
type SortDir = 'asc' | 'desc';

export const LembarKerjaView: React.FC<LembarKerjaViewProps> = ({
  results,
  period,
  selectedRegion,
  userRole,
  allowedRegion,
  connectionStatus = 'local',
  onRolloverPrevMonth,
  onUpdateCommodityInput,
}) => {
  const isProvinsi = userRole === 'PROVINSI';
  const activeRegion = isProvinsi ? selectedRegion : allowedRegion;

  const [kelompokFilter, setKelompokFilter] = useState<string>('ALL');
  const [levelFilter, setLevelFilter] = useState<LevelFilter>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [sortKey, setSortKey] = useState<LKSortKey>('DEFAULT');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [isRollingOver, setIsRollingOver] = useState<boolean>(false);
  const [rolloverNotice, setRolloverNotice] = useState<{ type: 'ok' | 'err'; text: string } | null>(
    null
  );
  const [editingCell, setEditingCell] = useState<{
    kode: string;
    field: 'nkPrev' | 'rhCurrent';
    draft: string;
  } | null>(null);

  const regionInfo = getRegionInfo(activeRegion);
  const lk = results[activeRegion];
  const prevMonth = getPrevMonthLabel(period);
  const currMonth = getCurrentMonthLabel(period);
  const isReadOnly = regionInfo.isAggregated;

  const toggleSort = (key: Exclude<LKSortKey, 'DEFAULT'>) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'KODE' || key === 'NAMA' ? 'asc' : 'desc');
    }
  };

  const renderSortIcon = (key: Exclude<LKSortKey, 'DEFAULT'>) => {
    if (sortKey !== key) {
      return <ArrowUpDown className="h-3 w-3 opacity-35 shrink-0" />;
    }
    return sortDir === 'asc' ? (
      <ArrowUp className="h-3 w-3 text-slate-900 shrink-0" />
    ) : (
      <ArrowDown className="h-3 w-3 text-slate-900 shrink-0" />
    );
  };

  const filteredRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const list = lk.rows.filter((row) => {
      if (row.flag === 0) return false;
      if (kelompokFilter !== 'ALL' && row.kelompokCode !== kelompokFilter) return false;
      if (levelFilter === 'SUMMARY' && row.flag === 3) return false;
      if (levelFilter === 'COMMODITY' && row.flag !== 3) return false;
      if (q) {
        const hitKode = row.kode.toLowerCase().includes(q) || row.lkKode.toLowerCase().includes(q);
        const hitNama = row.nama.toLowerCase().includes(q);
        if (!hitKode && !hitNama) return false;
      }
      return true;
    });

    if (sortKey === 'DEFAULT') return list;

    return [...list].sort((a, b) => {
      if (sortKey === 'KODE') {
        return sortDir === 'asc' ? a.kode.localeCompare(b.kode) : b.kode.localeCompare(a.kode);
      }
      if (sortKey === 'NAMA') {
        return sortDir === 'asc' ? a.nama.localeCompare(b.nama) : b.nama.localeCompare(a.nama);
      }
      const getNum = (r: LKCalculatedRow): number => {
        switch (sortKey) {
          case 'NK0':
            return r.nk0;
          case 'NK_PREV':
            return r.nkPrev;
          case 'NK_CURR':
            return r.nkCurrent;
          case 'PCT_PREV':
            return r.pctNkPrev;
          case 'PCT_CURR':
            return r.pctNkCurrent;
          case 'RH':
            return r.rhCurrent;
          case 'ANDIL':
            return r.andilInflasi;
          case 'IHK_PREV':
            return r.ihkPrev;
          case 'IHK_CURR':
            return r.ihkCurrent;
          case 'INFLASI':
            return r.inflasi;
          default:
            return 0;
        }
      };
      const va = getNum(a);
      const vb = getNum(b);
      if (va === vb) return a.kode.localeCompare(b.kode);
      return sortDir === 'desc' ? vb - va : va - vb;
    });
  }, [lk.rows, kelompokFilter, levelFilter, searchQuery, sortKey, sortDir]);

  const startEdit = (row: LKCalculatedRow, field: 'nkPrev' | 'rhCurrent') => {
    if (isReadOnly || row.flag !== 3) return;
    const rawVal = field === 'nkPrev' ? row.nkPrev : row.rhCurrent;
    setEditingCell({
      kode: row.kode,
      field,
      draft: String(Number(rawVal.toFixed(field === 'nkPrev' ? 2 : 6))),
    });
  };

  const commitEdit = () => {
    if (!editingCell || isReadOnly) {
      setEditingCell(null);
      return;
    }
    const parsed = Number(editingCell.draft.replace(',', '.'));
    if (Number.isFinite(parsed) && parsed >= 0) {
      onUpdateCommodityInput(
        activeRegion as KabKotaCode,
        editingCell.kode,
        editingCell.field,
        parsed
      );
    }
    setEditingCell(null);
  };

  const rowStyle = (flag: number) => {
    if (flag === 1) return 'bg-slate-100/90 font-bold text-slate-900';
    if (flag === 2) return 'bg-slate-50/90 font-semibold text-slate-800';
    return 'bg-white text-slate-800 hover:bg-slate-50/80';
  };

  const inflasiColor = (val: number) => {
    if (val > 0.0001) return 'text-rose-700';
    if (val < -0.0001) return 'text-emerald-700';
    return 'text-slate-600';
  };

  return (
    <div className="space-y-4">
      {/* Filter & Legend Bar */}
      <div className="rounded-lg border border-slate-200 bg-white p-4 space-y-3">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5">

            <div>
              <label
                htmlFor="lk-kelompok"
                className="block text-xs font-bold text-slate-700 mb-1"
              >
                Kelompok Pengeluaran
              </label>
              <select
                id="lk-kelompok"
                value={kelompokFilter}
                onChange={(e) => setKelompokFilter(e.target.value)}
                className="h-9 rounded-md border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-800 focus:border-slate-900 focus:outline-none max-w-[260px]"
              >
                <option value="ALL">Semua Kelompok (01–11)</option>
                {lk.kelompokList.map((k) => (
                  <option key={k.kode} value={k.kode}>
                    {k.kode} — {k.nama}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="lk-level"
                className="block text-xs font-bold text-slate-700 mb-1"
              >
                Tampilan Baris
              </label>
              <select
                id="lk-level"
                value={levelFilter}
                onChange={(e) => setLevelFilter(e.target.value as LevelFilter)}
                className="h-9 rounded-md border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-800 focus:border-slate-900 focus:outline-none"
              >
                <option value="ALL">Semua Hierarki ({Math.max(0, lk.rows.length - 1)} baris)</option>
                <option value="SUMMARY">
                  Kelompok & Subkelompok ({lk.kelompokList.length + lk.subkelompokList.length} baris)
                </option>
                <option value="COMMODITY">Hanya Komoditas ({lk.pakomCount} Pakom)</option>
              </select>
            </div>

            <div className="flex-1 min-w-[220px]">
              <label
                htmlFor="lk-search"
                className="block text-xs font-bold text-slate-700 mb-1"
              >
                Cari Komoditas / Kode
              </label>
              <div className="relative">
                <Search className="h-3.5 w-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  id="lk-search"
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Contoh: BERAS, 0112003, EMAS..."
                  className="h-9 w-full rounded-md border border-slate-300 bg-white pl-8 pr-3 text-xs font-medium text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none"
                />
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-2 shrink-0">
            {sortKey !== 'DEFAULT' && (
              <button
                type="button"
                onClick={() => {
                  setSortKey('DEFAULT');
                  setSortDir('asc');
                }}
                className="h-9 inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-xs font-bold text-slate-700 hover:bg-slate-50 whitespace-nowrap"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>Urutan Hierarki</span>
              </button>
            )}
            {isProvinsi && onRolloverPrevMonth && (
              <button
                type="button"
                disabled={isRollingOver || connectionStatus === 'local'}
                onClick={async () => {
                  setIsRollingOver(true);
                  setRolloverNotice(null);
                  try {
                    const targets =
                      activeRegion === '6100' ? KAB_KOTA_CODES : [activeRegion as KabKotaCode];
                    const res = await onRolloverPrevMonth(targets);
                    setRolloverNotice({
                      type: 'ok',
                      text: `Rollover sukses: ${res.totalRolledRows} baris dari ${formatPeriodLabel(
                        res.prevPeriod
                      )} disalin menjadi NK (N-1) periode aktif.`,
                    });
                  } catch (err) {
                    setRolloverNotice({
                      type: 'err',
                      text: err instanceof Error ? err.message : 'Gagal rollover data bulan lalu.',
                    });
                  } finally {
                    setIsRollingOver(false);
                  }
                }}
                title={
                  connectionStatus === 'local'
                    ? 'Membutuhkan koneksi Supabase aktif'
                    : `Tarik NK (N) bulan lalu menjadi NK (N-1) untuk ${activeRegion}`
                }
                className="h-9 inline-flex items-center gap-1.5 rounded-md border border-sky-300 bg-sky-50 px-3 text-xs font-bold text-sky-900 hover:bg-sky-100 disabled:opacity-50 whitespace-nowrap"
              >
                {isRollingOver ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                <span>Tarik NK (N) Bulan Lalu → NK (N-1)</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => exportSingleRegionWorkbook(lk, period)}
              className="h-9 inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-3.5 text-xs font-bold text-white hover:bg-slate-800 transition-colors whitespace-nowrap"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Export LK {activeRegion} (.xlsx)</span>
            </button>
          </div>
        </div>

        {rolloverNotice && (
          <div
            className={`rounded-md border px-3 py-2 text-xs flex items-center gap-2 ${
              rolloverNotice.type === 'ok'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                : 'border-rose-200 bg-rose-50 text-rose-800'
            }`}
          >
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span>{rolloverNotice.text}</span>
          </div>
        )}

        {/* Column Legend Strip */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-100 text-[11px] text-slate-600">
          <div className="flex flex-wrap items-center gap-4">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-xs bg-sky-100 border border-sky-400 inline-block" />
              <strong className="text-slate-800">Kolom Input Dinamis</strong>: NK ({prevMonth}) & RH ({currMonth})
              {!isReadOnly && ' — klik sel komoditas untuk ubah langsung'}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Calculator className="h-3.5 w-3.5 text-slate-500" />
              <strong className="text-slate-800">Kolom Rumus Otomatis</strong>: NK ({currMonth}), %NK, Andil, IHK, Inflasi
            </span>
          </div>
          {isReadOnly ? (
            <span className="inline-flex items-center gap-1 text-slate-700 font-medium">
              <Lock className="h-3 w-3 text-slate-500" />
              6100 Agregasi Otomatis 5 Kab/Kota (Read-only)
            </span>
          ) : (
            <span className="font-mono text-slate-500">
              Menampilkan {filteredRows.length} baris · klik header untuk sort
            </span>
          )}
        </div>
      </div>

      {/* Main LK Data Table */}
      <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
        <div className="overflow-x-auto max-h-[68vh]">
          <table className="w-full text-left border-collapse text-xs">
            <thead className="sticky top-0 z-20 bg-slate-100 border-b border-slate-300">
              <tr className="text-[11px] font-bold text-slate-800 select-none">
                <th
                  onClick={() => toggleSort('KODE')}
                  className="py-2.5 px-3 whitespace-nowrap border-r border-slate-200 bg-slate-100 cursor-pointer hover:bg-slate-200/70"
                >
                  <span className="inline-flex items-center gap-1">
                    Kode {renderSortIcon('KODE')}
                  </span>
                </th>
                <th
                  onClick={() => toggleSort('NAMA')}
                  className="py-2.5 px-3 min-w-[260px] border-r border-slate-200 bg-slate-100 cursor-pointer hover:bg-slate-200/70"
                >
                  <span className="inline-flex items-center gap-1">
                    Komoditas / Hierarki {renderSortIcon('NAMA')}
                  </span>
                </th>
                <th
                  onClick={() => toggleSort('NK0')}
                  className="py-2.5 px-3 text-right whitespace-nowrap bg-slate-100 cursor-pointer hover:bg-slate-200/70"
                >
                  <span className="inline-flex items-center justify-end gap-1">
                    NK0 = SBH {renderSortIcon('NK0')}
                  </span>
                  <span className="block text-[9px] font-normal text-slate-500">Bobot Dasar</span>
                </th>
                <th
                  onClick={() => toggleSort('NK_PREV')}
                  className="py-2.5 px-3 text-right whitespace-nowrap bg-sky-50 border-x border-sky-200 text-sky-900 cursor-pointer hover:bg-sky-100/70"
                >
                  <span className="inline-flex items-center justify-end gap-1">
                    NK ({prevMonth}) {renderSortIcon('NK_PREV')}
                  </span>
                  <span className="block text-[9px] font-semibold text-sky-700">
                    {isReadOnly ? 'AGREGAT N-1' : 'INPUT N-1'}
                  </span>
                </th>
                <th
                  onClick={() => toggleSort('NK_CURR')}
                  className="py-2.5 px-3 text-right whitespace-nowrap bg-slate-100 cursor-pointer hover:bg-slate-200/70"
                >
                  <span className="inline-flex items-center justify-end gap-1">
                    NK ({currMonth}) {renderSortIcon('NK_CURR')}
                  </span>
                  <span className="block text-[9px] font-normal text-slate-500">Rumus NK×RH/100</span>
                </th>
                <th
                  onClick={() => toggleSort('PCT_PREV')}
                  className="py-2.5 px-2.5 text-right whitespace-nowrap bg-slate-100 cursor-pointer hover:bg-slate-200/70"
                >
                  <span className="inline-flex items-center justify-end gap-1">
                    %NK {prevMonth} {renderSortIcon('PCT_PREV')}
                  </span>
                </th>
                <th
                  onClick={() => toggleSort('PCT_CURR')}
                  className="py-2.5 px-2.5 text-right whitespace-nowrap bg-slate-100 cursor-pointer hover:bg-slate-200/70"
                >
                  <span className="inline-flex items-center justify-end gap-1">
                    %NK {currMonth} {renderSortIcon('PCT_CURR')}
                  </span>
                </th>
                <th
                  onClick={() => toggleSort('RH')}
                  className="py-2.5 px-3 text-right whitespace-nowrap bg-amber-50 border-x border-amber-200 text-amber-900 cursor-pointer hover:bg-amber-100/70"
                >
                  <span className="inline-flex items-center justify-end gap-1">
                    RH ({currMonth}) {renderSortIcon('RH')}
                  </span>
                  <span className="block text-[9px] font-semibold text-amber-700">
                    {isReadOnly ? 'TERTIMBANG' : 'INPUT RH (N)'}
                  </span>
                </th>
                <th
                  onClick={() => toggleSort('ANDIL')}
                  className="py-2.5 px-2.5 text-right whitespace-nowrap bg-slate-100 cursor-pointer hover:bg-slate-200/70"
                >
                  <span className="inline-flex items-center justify-end gap-1">
                    Andil (%) {renderSortIcon('ANDIL')}
                  </span>
                </th>
                <th
                  onClick={() => toggleSort('IHK_PREV')}
                  className="py-2.5 px-2.5 text-right whitespace-nowrap bg-slate-100 cursor-pointer hover:bg-slate-200/70"
                >
                  <span className="inline-flex items-center justify-end gap-1">
                    IHK {prevMonth} {renderSortIcon('IHK_PREV')}
                  </span>
                </th>
                <th
                  onClick={() => toggleSort('IHK_CURR')}
                  className="py-2.5 px-2.5 text-right whitespace-nowrap bg-slate-100 cursor-pointer hover:bg-slate-200/70"
                >
                  <span className="inline-flex items-center justify-end gap-1">
                    IHK {currMonth} {renderSortIcon('IHK_CURR')}
                  </span>
                </th>
                <th
                  onClick={() => toggleSort('INFLASI')}
                  className="py-2.5 px-3 text-right whitespace-nowrap bg-slate-100 cursor-pointer hover:bg-slate-200/70"
                >
                  <span className="inline-flex items-center justify-end gap-1">
                    Inflasi (%) {renderSortIcon('INFLASI')}
                  </span>
                </th>
              </tr>

              {/* Pinned Row 1 TOTAL / UMUM Summary */}
              <tr className="bg-slate-900 text-white font-mono text-[11px] border-t border-slate-700">
                <td className="py-2 px-3 border-r border-slate-700">0</td>
                <td className="py-2 px-3 font-sans font-bold border-r border-slate-700">
                  TOTAL / UMUM — {lk.regionName.toUpperCase()}
                </td>
                <td className="py-2 px-3 text-right tabular-nums">{formatNK(lk.umum.nk0)}</td>
                <td className="py-2 px-3 text-right tabular-nums bg-slate-800 border-x border-slate-700">
                  {formatNK(lk.umum.nkPrev)}
                </td>
                <td className="py-2 px-3 text-right tabular-nums">{formatNK(lk.umum.nkCurrent)}</td>
                <td className="py-2 px-2.5 text-right tabular-nums">100,00</td>
                <td className="py-2 px-2.5 text-right tabular-nums">100,00</td>
                <td className="py-2 px-3 text-right tabular-nums bg-slate-800 border-x border-slate-700">
                  {formatNumber(lk.umum.rhCurrent, 4)}
                </td>
                <td className="py-2 px-2.5 text-right tabular-nums">
                  {formatAndil(lk.umum.andilInflasi, 4)}
                </td>
                <td className="py-2 px-2.5 text-right tabular-nums">
                  {formatIndex(lk.umum.ihkPrev, 2)}
                </td>
                <td className="py-2 px-2.5 text-right tabular-nums">
                  {formatIndex(lk.umum.ihkCurrent, 2)}
                </td>
                <td className="py-2 px-3 text-right tabular-nums font-bold">
                  {formatSignedPct(lk.umum.inflasi, 4)}
                </td>
              </tr>
            </thead>

            <tbody className="divide-y divide-slate-100">
              {filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={12} className="py-10 text-center text-slate-500">
                    Tidak ada baris komoditas yang cocok dengan filter pencarian.
                  </td>
                </tr>
              ) : (
                filteredRows.map((row) => {
                  const isCommodity = row.flag === 3;
                  const isEditingNk =
                    editingCell?.kode === row.kode && editingCell.field === 'nkPrev';
                  const isEditingRh =
                    editingCell?.kode === row.kode && editingCell.field === 'rhCurrent';

                  return (
                    <tr key={row.kode} className={`${rowStyle(row.flag)} transition-colors`}>
                      <td className="py-2 px-3 font-mono text-[11px] text-slate-500 border-r border-slate-100 whitespace-nowrap">
                        {row.kode}
                      </td>
                      <td className="py-2 px-3 border-r border-slate-100">
                        <div className="flex items-center gap-2">
                          <span
                            className={
                              sortKey === 'DEFAULT'
                                ? row.flag === 1
                                  ? 'uppercase tracking-tight'
                                  : row.flag === 2
                                  ? 'pl-2'
                                  : 'pl-4'
                                : row.flag === 1
                                ? 'uppercase tracking-tight'
                                : ''
                            }
                          >
                            {row.nama}
                          </span>
                          {row.kuesioner && isCommodity && (
                            <span className="text-[10px] font-mono text-slate-400 shrink-0">
                              {row.kuesioner}
                            </span>
                          )}
                        </div>
                      </td>

                      {/* NK0 */}
                      <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-600 whitespace-nowrap">
                        {formatNK(row.nk0)}
                      </td>

                      {/* NK (N-1) Dynamic Input Cell */}
                      <td
                        onClick={() => !isEditingNk && startEdit(row, 'nkPrev')}
                        className={`py-1.5 px-3 text-right font-mono tabular-nums border-x border-sky-100 whitespace-nowrap ${
                          isCommodity && !isReadOnly
                            ? 'bg-sky-50/40 hover:bg-sky-50 cursor-pointer text-slate-900'
                            : 'bg-sky-50/20 text-slate-700'
                        }`}
                      >
                        {isEditingNk ? (
                          <input
                            type="text"
                            autoFocus
                            value={editingCell.draft}
                            onChange={(e) =>
                              setEditingCell({ ...editingCell, draft: e.target.value })
                            }
                            onBlur={commitEdit}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitEdit();
                              if (e.key === 'Escape') setEditingCell(null);
                            }}
                            className="w-32 rounded border border-sky-500 bg-white px-1.5 py-0.5 text-right text-xs font-mono focus:outline-none"
                          />
                        ) : (
                          <span className="inline-flex items-center gap-1 justify-end">
                            {formatNK(row.nkPrev)}
                            {isCommodity && !isReadOnly && (
                              <Edit3 className="h-2.5 w-2.5 text-sky-500 opacity-50" />
                            )}
                          </span>
                        )}
                      </td>

                      {/* NK (N) Formula */}
                      <td className="py-2 px-3 text-right font-mono tabular-nums whitespace-nowrap">
                        {formatNK(row.nkCurrent)}
                      </td>

                      {/* %NK Prev */}
                      <td className="py-2 px-2.5 text-right font-mono tabular-nums text-slate-600 whitespace-nowrap">
                        {formatNumber(row.pctNkPrev, 3)}
                      </td>

                      {/* %NK Curr */}
                      <td className="py-2 px-2.5 text-right font-mono tabular-nums text-slate-600 whitespace-nowrap">
                        {formatNumber(row.pctNkCurrent, 3)}
                      </td>

                      {/* RH (N) Dynamic Input Cell */}
                      <td
                        onClick={() => !isEditingRh && startEdit(row, 'rhCurrent')}
                        className={`py-1.5 px-3 text-right font-mono tabular-nums border-x border-amber-100 whitespace-nowrap ${
                          isCommodity && !isReadOnly
                            ? 'bg-amber-50/40 hover:bg-amber-50 cursor-pointer text-slate-900 font-medium'
                            : 'bg-amber-50/20 text-slate-700'
                        }`}
                      >
                        {isEditingRh ? (
                          <input
                            type="text"
                            autoFocus
                            value={editingCell.draft}
                            onChange={(e) =>
                              setEditingCell({ ...editingCell, draft: e.target.value })
                            }
                            onBlur={commitEdit}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitEdit();
                              if (e.key === 'Escape') setEditingCell(null);
                            }}
                            className="w-24 rounded border border-amber-500 bg-white px-1.5 py-0.5 text-right text-xs font-mono focus:outline-none"
                          />
                        ) : (
                          <span className="inline-flex items-center gap-1 justify-end">
                            {formatNumber(row.rhCurrent, 4)}
                            {isCommodity && !isReadOnly && (
                              <Edit3 className="h-2.5 w-2.5 text-amber-600 opacity-50" />
                            )}
                          </span>
                        )}
                      </td>

                      {/* Andil Inflasi */}
                      <td
                        className={`py-2 px-2.5 text-right font-mono tabular-nums whitespace-nowrap ${inflasiColor(
                          row.andilInflasi
                        )}`}
                      >
                        {formatAndil(row.andilInflasi, 4)}
                      </td>

                      {/* IHK Prev */}
                      <td className="py-2 px-2.5 text-right font-mono tabular-nums text-slate-600 whitespace-nowrap">
                        {formatIndex(row.ihkPrev, 2)}
                      </td>

                      {/* IHK Curr */}
                      <td className="py-2 px-2.5 text-right font-mono tabular-nums text-slate-800 whitespace-nowrap">
                        {formatIndex(row.ihkCurrent, 2)}
                      </td>

                      {/* Inflasi */}
                      <td
                        className={`py-2 px-3 text-right font-mono tabular-nums font-semibold whitespace-nowrap ${inflasiColor(
                          row.inflasi
                        )}`}
                      >
                        {formatSignedPct(row.inflasi, 3)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
