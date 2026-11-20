import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Download,
  FileSpreadsheet,
  Flag,
  MapPin,
  Search,
  Trash2,
  Trophy,
  UploadCloud,
  X,
} from 'lucide-react';
import type {
  AngkaSementaraDataset,
  AngkaSementaraRow,
  HierarchyFlag,
  KalbarFlagType,
} from '../types/inflasi';
import { BULAN_OPTIONS } from '../data/regions';
import {
  buildAngkaSementaraIndex,
  type CommodityCatalogItem,
  parseAngkaSementaraFile,
} from '../utils/angkaSementaraParser';
import {
  clearAngkaSementaraDataset,
  loadAngkaSementaraDataset,
  saveAngkaSementaraDataset,
} from '../utils/angkaSementaraStorage';
import { exportAngkaSementaraRankingWorkbook } from '../utils/excelExporter';
import { formatAndil, formatIndex, formatSignedPct } from '../utils/formatters';

type ViewMode = 'CROSS_REGION' | 'KALBAR_COMMODITIES';
type ScopeFilter = 'PROVINSI' | 'KABKOTA' | 'ALL';
type KalbarFilter = 'ALL' | 'KALBAR_ONLY';
type FlagFilter = 'ALL' | '0' | '1' | '2' | '3';
type CrossSortKey = 'INF_MOM' | 'ANDIL_MOM' | 'IHK' | 'INF_YTD' | 'INF_YOY' | 'KODE_KOTA' | 'NAMA_KOTA';
type KalbarSortKey = 'INF_MOM' | 'ANDIL_MOM' | 'IHK' | 'INF_YTD' | 'INF_YOY' | 'KODE' | 'NAMA' | 'RANK_NASIONAL';
type SortDir = 'asc' | 'desc';

const SAMPLE_NATIONAL_URL = '/assets/aistudio/Angka_Sementara_26_Oktober__2026_new_a98b1d8c.csv';
const SAMPLE_KALBAR_URL = '/assets/aistudio/Angka_Sementara_26_Oktober__2026_new_5558fa55.csv';

const PAGE_SIZE = 50;

function formatBulanTahun(bulan: number | null, tahun: number | null): string {
  if (!bulan && !tahun) return 'Periode tidak terdeteksi';
  const bLabel = BULAN_OPTIONS.find((b) => b.value === bulan)?.label ?? (bulan ? `Bulan ${bulan}` : '');
  return `${bLabel} ${tahun ?? ''}`.trim();
}

function getFlagLabel(flag: HierarchyFlag): string {
  if (flag === 0) return 'Umum (0)';
  if (flag === 1) return 'Kelompok (1)';
  if (flag === 2) return 'Subkelompok (2)';
  return 'Komoditas (3)';
}

function renderKalbarFlagTag(kalbarFlag: KalbarFlagType) {
  if (kalbarFlag === 'PROV_KALBAR') {
    return (
      <span className="inline-flex items-center gap-1 rounded border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[11px] font-semibold text-sky-800 whitespace-nowrap">
        <Flag className="h-3 w-3 text-sky-700" />
        <span>Prov. Kalbar</span>
      </span>
    );
  }
  if (kalbarFlag === 'KABKOTA_KALBAR') {
    return (
      <span className="inline-flex items-center gap-1 rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[11px] font-semibold text-amber-800 whitespace-nowrap">
        <MapPin className="h-3 w-3 text-amber-700" />
        <span>Kab/Kota Kalbar</span>
      </span>
    );
  }
  return <span className="text-[11px] text-slate-400 whitespace-nowrap">Luar Kalbar</span>;
}

export const AngkaSementaraRankingView: React.FC = () => {
  const [dataset, setDataset] = useState<AngkaSementaraDataset | null>(null);
  const [isRestoring, setIsRestoring] = useState<boolean>(true);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState<boolean>(false);

  const [viewMode, setViewMode] = useState<ViewMode>('CROSS_REGION');

  // Commodity search & selection state
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [flagFilter, setFlagFilter] = useState<FlagFilter>('ALL');
  const [selectedCommodityKey, setSelectedCommodityKey] = useState<string>('0|0');

  // Cross-region ranking table controls
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('PROVINSI');
  const [kalbarFilter, setKalbarFilter] = useState<KalbarFilter>('ALL');
  const [crossSortKey, setCrossSortKey] = useState<CrossSortKey>('INF_MOM');
  const [crossSortDir, setCrossSortDir] = useState<SortDir>('desc');
  const [page, setPage] = useState<number>(1);
  const [showAllRows, setShowAllRows] = useState<boolean>(false);

  // Kalbar intra-region commodity ranking controls
  const [selectedKalbarRegion, setSelectedKalbarRegion] = useState<string>('61');
  const [kalbarCommoditySearch, setKalbarCommoditySearch] = useState<string>('');
  const [kalbarFlagLevel, setKalbarFlagLevel] = useState<FlagFilter>('3');
  const [kalbarSortKey, setKalbarSortKey] = useState<KalbarSortKey>('INF_MOM');
  const [kalbarSortDir, setKalbarSortDir] = useState<SortDir>('desc');

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let active = true;
    loadAngkaSementaraDataset().then((stored) => {
      if (!active) return;
      if (stored) {
        setDataset(stored);
      }
      setIsRestoring(false);
    });
    return () => {
      active = false;
    };
  }, []);

  const index = useMemo(() => {
    if (!dataset) return null;
    return buildAngkaSementaraIndex(dataset);
  }, [dataset]);

  // Ensure valid initial Kalbar region & commodity when dataset loads
  useEffect(() => {
    if (!index) return;
    if (index.kalbarRegions.length > 0) {
      const exists = index.kalbarRegions.some((r) => r.kdKota === selectedKalbarRegion);
      if (!exists) {
        setSelectedKalbarRegion(index.kalbarRegions[0].kdKota);
      }
    }
    const defaultKey = index.byCommodity.has('3|0111001')
      ? '3|0111001'
      : index.byCommodity.has('0|0')
        ? '0|0'
        : index.catalog[0]
          ? `${index.catalog[0].flag}|${index.catalog[0].kode}`
          : '';
    if (defaultKey && !index.byCommodity.has(selectedCommodityKey)) {
      setSelectedCommodityKey(defaultKey);
    }
  }, [index, selectedKalbarRegion, selectedCommodityKey]);

  // Matching commodities from search query
  const matchingCatalog = useMemo<CommodityCatalogItem[]>(() => {
    if (!index) return [];
    const q = searchQuery.trim().toLowerCase();
    const filtered = index.catalog.filter((item) => {
      if (flagFilter !== 'ALL' && String(item.flag) !== flagFilter) return false;
      if (!q) return true;
      return (
        item.nama.toLowerCase().includes(q) ||
        item.kode.toLowerCase().includes(q)
      );
    });

    if (!q) return filtered.slice(0, 60);

    // Prioritize exact name/code match, then prefix match, then substring
    return [...filtered].sort((a, b) => {
      const aNama = a.nama.toLowerCase();
      const bNama = b.nama.toLowerCase();
      const aExact = aNama === q || a.kode.toLowerCase() === q ? 0 : 1;
      const bExact = bNama === q || b.kode.toLowerCase() === q ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      const aStarts = aNama.startsWith(q) ? 0 : 1;
      const bStarts = bNama.startsWith(q) ? 0 : 1;
      if (aStarts !== bStarts) return aStarts - bStarts;
      if (a.flag !== b.flag) return b.flag - a.flag; // Prefer Flag 3 commodity on search
      return aNama.localeCompare(bNama);
    });
  }, [index, searchQuery, flagFilter]);

  // Auto-select top search result whenever searchQuery changes non-empty
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q || matchingCatalog.length === 0) return;
    const topMatch = matchingCatalog[0];
    setSelectedCommodityKey(`${topMatch.flag}|${topMatch.kode}`);
    setPage(1);
  }, [searchQuery, matchingCatalog]);

  const activeCatalogItem = useMemo(() => {
    if (!index) return null;
    const [fStr, kode] = selectedCommodityKey.split('|');
    return (
      index.catalog.find((c) => String(c.flag) === fStr && c.kode === kode) ??
      index.catalog[0] ??
      null
    );
  }, [index, selectedCommodityKey]);

  const activeCommodityRows = useMemo<AngkaSementaraRow[]>(() => {
    if (!index || !activeCatalogItem) return [];
    return index.byCommodity.get(`${activeCatalogItem.flag}|${activeCatalogItem.kode}`) ?? [];
  }, [index, activeCatalogItem]);

  // Kalbar detection rows for the active commodity (Provinsi Kalbar + 5 Kab/Kota Kalbar)
  const kalbarDetection = useMemo(() => {
    if (!index || !activeCatalogItem) {
      return { provRow: null, kabRows: [] as Array<{ row: AngkaSementaraRow; rankLevel: number; totalLevel: number; rankAll: number; totalAll: number }> };
    }
    const provRaw = activeCommodityRows.find((r) => r.kalbarFlag === 'PROV_KALBAR') ?? null;
    const provRankLevel = provRaw
      ? index.rankInLevelMap.get(`${provRaw.kdKota}|${provRaw.flag}|${provRaw.kode}`) ?? { rank: 1, total: 1 }
      : null;
    const provRankAll = provRaw
      ? index.rankInAllMap.get(`${provRaw.kdKota}|${provRaw.flag}|${provRaw.kode}`) ?? { rank: 1, total: 1 }
      : null;

    const kabRows = activeCommodityRows
      .filter((r) => r.kalbarFlag === 'KABKOTA_KALBAR')
      .map((row) => {
        const lvl = index.rankInLevelMap.get(`${row.kdKota}|${row.flag}|${row.kode}`) ?? { rank: 1, total: 1 };
        const all = index.rankInAllMap.get(`${row.kdKota}|${row.flag}|${row.kode}`) ?? { rank: 1, total: 1 };
        return {
          row,
          rankLevel: lvl.rank,
          totalLevel: lvl.total,
          rankAll: all.rank,
          totalAll: all.total,
        };
      })
      .sort((a, b) => b.row.infMom - a.row.infMom);

    return {
      provRow:
        provRaw && provRankLevel && provRankAll
          ? {
              row: provRaw,
              rankLevel: provRankLevel.rank,
              totalLevel: provRankLevel.total,
              rankAll: provRankAll.rank,
              totalAll: provRankAll.total,
            }
          : null,
      kabRows,
    };
  }, [index, activeCatalogItem, activeCommodityRows]);

  // Cross-region ranking rows for the active commodity
  const crossRegionRows = useMemo(() => {
    if (!index) return [];
    let scoped = activeCommodityRows.filter((r) => {
      if (scopeFilter === 'PROVINSI' && r.regionLevel !== 'PROVINSI') return false;
      if (scopeFilter === 'KABKOTA' && r.regionLevel !== 'KABKOTA') return false;
      if (kalbarFilter === 'KALBAR_ONLY' && r.kalbarFlag === 'NON_KALBAR') return false;
      return true;
    });

    scoped = [...scoped].sort((a, b) => {
      let cmp = 0;
      switch (crossSortKey) {
        case 'INF_MOM':
          cmp = a.infMom - b.infMom;
          break;
        case 'ANDIL_MOM':
          cmp = a.andilMom - b.andilMom;
          break;
        case 'IHK':
          cmp = a.ihk - b.ihk;
          break;
        case 'INF_YTD':
          cmp = a.infYtd - b.infYtd;
          break;
        case 'INF_YOY':
          cmp = a.infYoy - b.infYoy;
          break;
        case 'KODE_KOTA':
          cmp = a.kdKota.localeCompare(b.kdKota);
          break;
        case 'NAMA_KOTA':
          cmp = a.namaKota.localeCompare(b.namaKota);
          break;
      }
      if (cmp === 0) cmp = a.kdKota.localeCompare(b.kdKota);
      return crossSortDir === 'desc' ? -cmp : cmp;
    });

    return scoped.map((row, idx) => {
      const lvl = index.rankInLevelMap.get(`${row.kdKota}|${row.flag}|${row.kode}`) ?? { rank: idx + 1, total: scoped.length };
      const all = index.rankInAllMap.get(`${row.kdKota}|${row.flag}|${row.kode}`) ?? { rank: idx + 1, total: scoped.length };
      return {
        displayOrder: idx + 1,
        row,
        rankLevel: lvl,
        rankAll: all,
      };
    });
  }, [index, activeCommodityRows, scopeFilter, kalbarFilter, crossSortKey, crossSortDir]);

  const paginatedCrossRows = useMemo(() => {
    if (showAllRows) return crossRegionRows;
    const start = (page - 1) * PAGE_SIZE;
    return crossRegionRows.slice(start, start + PAGE_SIZE);
  }, [crossRegionRows, page, showAllRows]);

  const totalPages = Math.max(1, Math.ceil(crossRegionRows.length / PAGE_SIZE));

  // Intra-Kalbar commodity ranking (Tab 2)
  const kalbarCommodityRows = useMemo(() => {
    if (!dataset || !index) return [];
    const q = kalbarCommoditySearch.trim().toLowerCase();
    const filtered = dataset.rows.filter((r) => {
      if (r.kdKota !== selectedKalbarRegion) return false;
      if (kalbarFlagLevel !== 'ALL' && String(r.flag) !== kalbarFlagLevel) return false;
      if (q && !r.nama.toLowerCase().includes(q) && !r.kode.toLowerCase().includes(q)) return false;
      return true;
    });

    const mapped = filtered.map((row) => {
      const lvl = index.rankInLevelMap.get(`${row.kdKota}|${row.flag}|${row.kode}`) ?? { rank: 1, total: 1 };
      const all = index.rankInAllMap.get(`${row.kdKota}|${row.flag}|${row.kode}`) ?? { rank: 1, total: 1 };
      return { row, rankLevel: lvl, rankAll: all };
    });

    return mapped.sort((a, b) => {
      let cmp = 0;
      switch (kalbarSortKey) {
        case 'INF_MOM':
          cmp = a.row.infMom - b.row.infMom;
          break;
        case 'ANDIL_MOM':
          cmp = a.row.andilMom - b.row.andilMom;
          break;
        case 'IHK':
          cmp = a.row.ihk - b.row.ihk;
          break;
        case 'INF_YTD':
          cmp = a.row.infYtd - b.row.infYtd;
          break;
        case 'INF_YOY':
          cmp = a.row.infYoy - b.row.infYoy;
          break;
        case 'KODE':
          cmp = a.row.kode.localeCompare(b.row.kode);
          break;
        case 'NAMA':
          cmp = a.row.nama.localeCompare(b.row.nama);
          break;
        case 'RANK_NASIONAL':
          cmp = a.rankLevel.rank - b.rankLevel.rank;
          break;
      }
      if (cmp === 0) cmp = a.row.kode.localeCompare(b.row.kode);
      return kalbarSortDir === 'desc' ? -cmp : cmp;
    });
  }, [dataset, index, selectedKalbarRegion, kalbarFlagLevel, kalbarCommoditySearch, kalbarSortKey, kalbarSortDir]);

  const handleFileUpload = async (file: File) => {
    setErrorMsg(null);
    setIsLoading(true);
    try {
      const parsed = await parseAngkaSementaraFile(file, file.name);
      setDataset(parsed);
      await saveAngkaSementaraDataset(parsed);
      setPage(1);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gagal membaca file Angka Sementara.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleLoadSample = async (url: string, labelFileName: string) => {
    setErrorMsg(null);
    setIsLoading(true);
    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        throw new Error(`Gagal memuat file contoh (${resp.status}).`);
      }
      const text = await resp.text();
      const parsed = await parseAngkaSementaraFile(text, labelFileName);
      setDataset(parsed);
      await saveAngkaSementaraDataset(parsed);
      setPage(1);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gagal memuat contoh Angka Sementara.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleClearDataset = async () => {
    setDataset(null);
    setErrorMsg(null);
    setSearchQuery('');
    await clearAngkaSementaraDataset();
  };

  const handleCrossSort = (key: CrossSortKey) => {
    if (crossSortKey === key) {
      setCrossSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setCrossSortKey(key);
      setCrossSortDir(key === 'KODE_KOTA' || key === 'NAMA_KOTA' ? 'asc' : 'desc');
    }
    setPage(1);
  };

  const handleKalbarSort = (key: KalbarSortKey) => {
    if (kalbarSortKey === key) {
      setKalbarSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setKalbarSortKey(key);
      setKalbarSortDir(key === 'KODE' || key === 'NAMA' || key === 'RANK_NASIONAL' ? 'asc' : 'desc');
    }
  };

  const renderCrossSortIcon = (key: CrossSortKey) => {
    if (crossSortKey !== key) return <ArrowUpDown className="h-3 w-3 text-slate-400" />;
    return crossSortDir === 'desc' ? (
      <ArrowDown className="h-3 w-3 text-sky-700" />
    ) : (
      <ArrowUp className="h-3 w-3 text-sky-700" />
    );
  };

  const renderKalbarSortIcon = (key: KalbarSortKey) => {
    if (kalbarSortKey !== key) return <ArrowUpDown className="h-3 w-3 text-slate-400" />;
    return kalbarSortDir === 'desc' ? (
      <ArrowDown className="h-3 w-3 text-sky-700" />
    ) : (
      <ArrowUp className="h-3 w-3 text-sky-700" />
    );
  };

  const handleExport = () => {
    if (!dataset || !activeCatalogItem) return;
    const scopeLabel =
      scopeFilter === 'PROVINSI'
        ? 'Provinsi'
        : scopeFilter === 'KABKOTA'
          ? 'Kabupaten/Kota'
          : 'Semua Wilayah';

    const kalbarCombined = [
      ...(kalbarDetection.provRow
        ? [
            {
              rank: 1,
              row: kalbarDetection.provRow.row,
              rankLevelLabel: `#${kalbarDetection.provRow.rankLevel} / ${kalbarDetection.provRow.totalLevel} Prov`,
              rankAllLabel: `#${kalbarDetection.provRow.rankAll} / ${kalbarDetection.provRow.totalAll} Wil`,
            },
          ]
        : []),
      ...kalbarDetection.kabRows.map((k, idx) => ({
        rank: idx + 1,
        row: k.row,
        rankLevelLabel: `#${k.rankLevel} / ${k.totalLevel} KabKota`,
        rankAllLabel: `#${k.rankAll} / ${k.totalAll} Wil`,
      })),
    ];

    exportAngkaSementaraRankingWorkbook({
      title: dataset.title,
      commodityLabel: `${activeCatalogItem.kode} - ${activeCatalogItem.nama}`,
      scopeLabel,
      rows: crossRegionRows.map((item) => ({
        rank: item.displayOrder,
        row: item.row,
        rankLevelLabel: `#${item.rankLevel.rank} / ${item.rankLevel.total}`,
        rankAllLabel: `#${item.rankAll.rank} / ${item.rankAll.total}`,
      })),
      kalbarRows: kalbarCombined,
    });
  };

  // Hidden shared file input
  const fileInputElement = (
    <input
      ref={fileInputRef}
      type="file"
      accept=".csv,.tsv,.txt,.xlsx,.xls"
      className="hidden"
      onChange={(e) => {
        const f = e.target.files?.[0];
        if (f) handleFileUpload(f);
        e.target.value = '';
      }}
    />
  );

  if (isRestoring) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-8">
        <div className="h-5 w-64 bg-slate-100 rounded mb-3" />
        <div className="h-4 w-96 bg-slate-100 rounded mb-6" />
        <div className="space-y-2">
          <div className="h-10 bg-slate-100 rounded" />
          <div className="h-10 bg-slate-100 rounded" />
          <div className="h-10 bg-slate-100 rounded" />
        </div>
      </div>
    );
  }

  // Empty state before any file is uploaded
  if (!dataset || !index) {
    return (
      <div className="space-y-6">
        {fileInputElement}

        <div className="rounded-lg border border-slate-200 bg-white p-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-slate-200 pb-5">
            <div>
              <h2 className="text-lg font-bold text-slate-900 tracking-tight">
                Sorting & Ranking INF(MoM) Angka Sementara
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                Unggah file Angka Sementara (.csv atau .xlsx) untuk mendeteksi posisi ranking inflasi MoM Provinsi Kalimantan Barat dan 5 Kab/Kota Kalbar secara otomatis.
              </p>
            </div>
          </div>

          {errorMsg && (
            <div className="mt-4 rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-xs font-medium text-rose-800 flex items-center justify-between gap-2">
              <span>{errorMsg}</span>
              <button
                type="button"
                onClick={() => setErrorMsg(null)}
                className="text-rose-700 hover:text-rose-900"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragging(false);
              const f = e.dataTransfer.files?.[0];
              if (f) handleFileUpload(f);
            }}
            className={`mt-5 rounded-lg border-2 border-dashed p-8 text-center transition-colors ${
              isDragging
                ? 'border-sky-600 bg-sky-50'
                : 'border-slate-300 bg-slate-50/60 hover:border-slate-400'
            }`}
          >
            <UploadCloud className="mx-auto h-9 w-9 text-slate-500" />
            <h3 className="mt-3 text-sm font-bold text-slate-900">
              {isLoading ? 'Memproses file Angka Sementara...' : 'Seret & lepas file Angka Sementara di sini'}
            </h3>
            <p className="mt-1 text-xs text-slate-500">
              Mendukung kolom standar: Tahun · Bulan · Kd.Kota · Nama Kota · Kode · Nama · Flag · IHK · INF(MOM) · INF(YTD) · INF(YOY) · ANDIL(MOM)
            </p>

            <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                disabled={isLoading}
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-2 rounded-md bg-slate-900 px-4 py-2 text-xs font-bold text-white hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
              >
                <FileSpreadsheet className="h-4 w-4" />
                <span>Pilih File (.csv / .xlsx)</span>
              </button>

              <button
                type="button"
                disabled={isLoading}
                onClick={() =>
                  handleLoadSample(SAMPLE_NATIONAL_URL, 'Angka_Sementara_26_Oktober_2026_Nasional.csv')
                }
                className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
              >
                <Trophy className="h-4 w-4 text-sky-700" />
                <span>Muat Contoh Nasional (Okt 2026 · 188 Wilayah)</span>
              </button>

              <button
                type="button"
                disabled={isLoading}
                onClick={() =>
                  handleLoadSample(SAMPLE_KALBAR_URL, 'Angka_Sementara_26_Oktober_2026_Kalbar.csv')
                }
                className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
              >
                <Flag className="h-4 w-4 text-amber-700" />
                <span>Muat Contoh Template Kalbar</span>
              </button>
            </div>
          </div>

          <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4 border-t border-slate-200 pt-5 text-xs text-slate-600">
            <div>
              <p className="font-bold text-slate-900">1. Flag Otomatis Wilayah Kalbar</p>
              <p className="mt-1">
                Sistem menandai otomatis Provinsi Kalimantan Barat (61) dan 5 Kab/Kota Kalbar (6106 Ketapang, 6107 Sintang, 6111 Kayong Utara, 6171 Pontianak, 6172 Singkawang).
              </p>
            </div>
            <div>
              <p className="font-bold text-slate-900">2. Search Komoditas Instan</p>
              <p className="mt-1">
                Ketik nama atau kode komoditas (misal: BERAS) untuk langsung mendeteksi peringkat INF(MoM) Provinsi Kalbar dan tiap Kab/Kota terhadap seluruh Indonesia.
              </p>
            </div>
            <div>
              <p className="font-bold text-slate-900">3. Sorting INF(MoM) Fleksibel</p>
              <p className="mt-1">
                Urutkan peringkat antar-wilayah berdasarkan INF(MoM) tertinggi atau deflasi terdalam, atau urutkan seluruh komoditas di dalam wilayah Kalbar.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const activeKalbarRegionInfo = index.kalbarRegions.find((r) => r.kdKota === selectedKalbarRegion);

  return (
    <div className="space-y-5">
      {fileInputElement}

      {/* Dataset Header & Upload Controls */}
      <div className="rounded-lg border border-slate-200 bg-white px-5 py-4">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <span className="font-semibold text-slate-700 truncate max-w-xs">{dataset.fileName}</span>
              <span aria-hidden="true">·</span>
              <span>{formatBulanTahun(dataset.bulan, dataset.tahun)}</span>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">{index.provCount} Provinsi</span>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">{index.kabKotaCount} Kab/Kota</span>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums font-semibold text-sky-700">
                {index.kalbarRegions.length} Wilayah Kalbar Terdeteksi
              </span>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">
                {new Intl.NumberFormat('id-ID').format(dataset.rows.length)} baris
              </span>
            </div>
            <h2 className="mt-1 text-base font-bold text-slate-900 tracking-tight truncate">
              {dataset.title}
            </h2>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              disabled={isLoading}
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-bold text-white hover:bg-slate-800 whitespace-nowrap"
            >
              <UploadCloud className="h-3.5 w-3.5" />
              <span>{isLoading ? 'Memuat...' : 'Upload File Baru'}</span>
            </button>

            <button
              type="button"
              onClick={handleExport}
              disabled={!activeCatalogItem}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Export Excel</span>
            </button>

            <button
              type="button"
              onClick={handleClearDataset}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-rose-50 hover:text-rose-700 hover:border-rose-200 whitespace-nowrap"
              title="Hapus dataset Angka Sementara"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Hapus</span>
            </button>
          </div>
        </div>

        {errorMsg && (
          <div className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3.5 py-2 text-xs font-medium text-rose-800 flex items-center justify-between gap-2">
            <span>{errorMsg}</span>
            <button type="button" onClick={() => setErrorMsg(null)}>
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* Mode Switcher */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex items-center gap-1 rounded-lg bg-slate-200/70 p-1">
          <button
            type="button"
            onClick={() => setViewMode('CROSS_REGION')}
            className={`rounded-md px-3.5 py-1.5 text-xs font-bold transition-colors whitespace-nowrap ${
              viewMode === 'CROSS_REGION'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Ranking Komoditas Antar-Wilayah
          </button>
          <button
            type="button"
            onClick={() => setViewMode('KALBAR_COMMODITIES')}
            className={`rounded-md px-3.5 py-1.5 text-xs font-bold transition-colors whitespace-nowrap ${
              viewMode === 'KALBAR_COMMODITIES'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Sorting Komoditas di Kalbar
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-xs bg-sky-600" />
            <span>Flag Provinsi Kalbar (61)</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-xs bg-amber-500" />
            <span>Flag Kab/Kota Kalbar (6106–6172)</span>
          </span>
        </div>
      </div>

      {viewMode === 'CROSS_REGION' ? (
        <div className="space-y-5">
          {/* Commodity Search & Quick Selector */}
          <div className="rounded-lg border border-slate-200 bg-white p-5 space-y-4">
            <div className="flex flex-col md:flex-row gap-3">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Cari komoditas atau kode (misal: beras, cabai rawit, telur ayam ras, umum)..."
                  className="w-full rounded-md border border-slate-300 bg-white pl-9 pr-9 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700"
                    title="Bersihkan pencarian"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <label htmlFor="flag-filter" className="text-xs font-semibold text-slate-600 whitespace-nowrap">
                  Level Flag:
                </label>
                <select
                  id="flag-filter"
                  value={flagFilter}
                  onChange={(e) => setFlagFilter(e.target.value as FlagFilter)}
                  className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-900 focus:border-slate-900 focus:outline-none"
                >
                  <option value="ALL">Semua Level</option>
                  <option value="3">Komoditas (Flag 3)</option>
                  <option value="0">Umum (Flag 0)</option>
                  <option value="1">Kelompok (Flag 1)</option>
                  <option value="2">Subkelompok (Flag 2)</option>
                </select>
              </div>
            </div>

            {/* Matching Commodities Bar */}
            <div>
              <div className="flex items-center justify-between text-xs text-slate-500 mb-2">
                <span>
                  {searchQuery.trim()
                    ? `Hasil pencarian "${searchQuery.trim()}" (${matchingCatalog.length} cocok)`
                    : 'Pilih cepat komoditas / kategori:'}
                </span>
                {activeCatalogItem && (
                  <span className="font-mono text-slate-700">
                    Aktif: <strong>{activeCatalogItem.kode}</strong> · {activeCatalogItem.nama}
                  </span>
                )}
              </div>

              {matchingCatalog.length === 0 ? (
                <p className="text-xs text-slate-500 py-2">
                  Tidak ada komoditas yang cocok dengan "{searchQuery}".
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {matchingCatalog.slice(0, 14).map((item) => {
                    const key = `${item.flag}|${item.kode}`;
                    const isSelected = key === `${activeCatalogItem?.flag}|${activeCatalogItem?.kode}`;
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => {
                          setSelectedCommodityKey(key);
                          setPage(1);
                        }}
                        className={`rounded-md border px-2.5 py-1 text-xs transition-colors whitespace-nowrap ${
                          isSelected
                            ? 'border-slate-900 bg-slate-900 text-white font-bold'
                            : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100 font-medium'
                        }`}
                      >
                        <span className="font-mono opacity-75 mr-1.5">{item.kode}</span>
                        <span>{item.nama}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Automatic Kalbar Ranking Detection Panel */}
          {activeCatalogItem && (
            <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
              <div className="border-b border-slate-200 bg-slate-50/70 px-5 py-3.5 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2 text-xs text-slate-500">
                    <span className="font-mono font-semibold text-slate-700">
                      Kode {activeCatalogItem.kode}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{getFlagLabel(activeCatalogItem.flag)}</span>
                    <span aria-hidden="true">·</span>
                    <span className="tabular-nums">
                      Tercatat di {activeCatalogItem.regionCount} wilayah nasional
                    </span>
                  </div>
                  <h3 className="mt-0.5 text-base font-bold text-slate-900">
                    Deteksi Ranking INF(MoM) Kalbar — {activeCatalogItem.nama}
                  </h3>
                </div>
              </div>

              <div className="p-5 space-y-5">
                {/* Provinsi Kalbar Highlight */}
                <div>
                  <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2.5">
                    Provinsi Kalimantan Barat
                  </h4>

                  {kalbarDetection.provRow ? (
                    <div className="rounded-lg border border-sky-200 bg-sky-50/50 p-4 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
                      <div className="flex items-start gap-3">
                        <div className="rounded-md bg-sky-700 px-3 py-2 text-center text-white shrink-0">
                          <div className="text-[10px] font-medium opacity-85">Rank Prov.</div>
                          <div className="font-mono text-lg font-extrabold leading-tight tabular-nums">
                            #{kalbarDetection.provRow.rankLevel}
                          </div>
                          <div className="text-[10px] opacity-85 tabular-nums">
                            dari {kalbarDetection.provRow.totalLevel}
                          </div>
                        </div>

                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-xs font-bold text-slate-700">
                              {kalbarDetection.provRow.row.kdKota}
                            </span>
                            <span className="text-sm font-extrabold text-slate-900">
                              {kalbarDetection.provRow.row.namaKota}
                            </span>
                            {renderKalbarFlagTag('PROV_KALBAR')}
                          </div>
                          <p className="mt-1 text-xs text-slate-600 tabular-nums">
                            Peringkat ke-<strong>{kalbarDetection.provRow.rankLevel}</strong> dari{' '}
                            <strong>{kalbarDetection.provRow.totalLevel}</strong> Provinsi se-Indonesia
                            {' · '}Peringkat gabungan ke-<strong>{kalbarDetection.provRow.rankAll}</strong> dari{' '}
                            <strong>{kalbarDetection.provRow.totalAll}</strong> wilayah (berdasarkan INF(MoM) tertinggi).
                          </p>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 border-t lg:border-t-0 pt-3 lg:pt-0 border-sky-200/80 shrink-0">
                        <div>
                          <div className="text-[11px] text-slate-500">INF(MOM)</div>
                          <div
                            className={`font-mono text-sm font-extrabold tabular-nums ${
                              kalbarDetection.provRow.row.infMom > 0
                                ? 'text-rose-700'
                                : kalbarDetection.provRow.row.infMom < 0
                                  ? 'text-emerald-700'
                                  : 'text-slate-700'
                            }`}
                          >
                            {formatSignedPct(kalbarDetection.provRow.row.infMom, 2)}
                          </div>
                        </div>
                        <div>
                          <div className="text-[11px] text-slate-500">ANDIL(MOM)</div>
                          <div className="font-mono text-sm font-bold text-slate-900 tabular-nums">
                            {formatAndil(kalbarDetection.provRow.row.andilMom, 4)}
                          </div>
                        </div>
                        <div>
                          <div className="text-[11px] text-slate-500">IHK</div>
                          <div className="font-mono text-sm font-bold text-slate-900 tabular-nums">
                            {formatIndex(kalbarDetection.provRow.row.ihk, 2)}
                          </div>
                        </div>
                        <div>
                          <div className="text-[11px] text-slate-500">INF(YTD)</div>
                          <div className="font-mono text-sm font-semibold text-slate-700 tabular-nums">
                            {formatSignedPct(kalbarDetection.provRow.row.infYtd, 2)}
                          </div>
                        </div>
                        <div>
                          <div className="text-[11px] text-slate-500">INF(YOY)</div>
                          <div className="font-mono text-sm font-semibold text-slate-700 tabular-nums">
                            {formatSignedPct(kalbarDetection.provRow.row.infYoy, 2)}
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-500">
                      Komoditas ini tidak tercatat pada Provinsi Kalimantan Barat di file yang diunggah.
                    </div>
                  )}
                </div>

                {/* Kab/Kota Kalbar Table */}
                <div>
                  <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2.5">
                    Kabupaten / Kota di Kalimantan Barat ({kalbarDetection.kabRows.length} Wilayah)
                  </h4>

                  {kalbarDetection.kabRows.length === 0 ? (
                    <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-500">
                      Tidak ada data Kab/Kota Kalbar untuk komoditas ini pada file yang diunggah.
                    </div>
                  ) : (
                    <div className="overflow-y-auto overflow-x-hidden rounded-lg border border-slate-200">
                      <table className="w-full table-fixed text-left border-collapse text-[11px]">
                        <colgroup>
                          <col className="w-[9%]" />
                          <col className="w-[9%]" />
                          <col className="w-[7%]" />
                          <col className="w-[19%]" />
                          <col className="w-[13%]" />
                          <col className="w-[8%]" />
                          <col className="w-[9%]" />
                          <col className="w-[9%]" />
                          <col className="w-[8.5%]" />
                          <col className="w-[8.5%]" />
                        </colgroup>
                        <thead>
                          <tr className="border-b border-slate-200 bg-slate-50 text-slate-600 leading-tight">
                            <th className="py-2 px-2 font-semibold">Rank Kab/Kota</th>
                            <th className="py-2 px-2 font-semibold">Rank All</th>
                            <th className="py-2 px-2 font-semibold">Kode</th>
                            <th className="py-2 px-2 font-semibold">Nama Kab/Kota</th>
                            <th className="py-2 px-2 font-semibold">Flag</th>
                            <th className="py-2 px-2 font-semibold text-right">IHK</th>
                            <th className="py-2 px-2 font-semibold text-right">INF(MoM)</th>
                            <th className="py-2 px-2 font-semibold text-right">Andil</th>
                            <th className="py-2 px-2 font-semibold text-right">INF(YtD)</th>
                            <th className="py-2 px-2 font-semibold text-right">INF(YoY)</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200">
                          {kalbarDetection.kabRows.map((item) => (
                            <tr key={item.row.kdKota} className="bg-amber-50/40 hover:bg-amber-50/80 transition-colors">
                              <td className="py-2 px-2 font-mono font-extrabold text-slate-900 tabular-nums truncate">
                                #{item.rankLevel}{' '}
                                <span className="text-[10px] font-normal text-slate-500">
                                  /{item.totalLevel}
                                </span>
                              </td>
                              <td className="py-2 px-2 font-mono text-slate-700 tabular-nums truncate">
                                #{item.rankAll}{' '}
                                <span className="text-[10px] text-slate-400">
                                  /{item.totalAll}
                                </span>
                              </td>
                              <td className="py-2 px-2 font-mono font-semibold text-slate-700 truncate">
                                {item.row.kdKota}
                              </td>
                              <td
                                className="py-2 px-2 font-bold text-slate-900 truncate"
                                title={item.row.namaKota}
                              >
                                {item.row.namaKota}
                              </td>
                              <td className="py-2 px-2 truncate">{renderKalbarFlagTag(item.row.kalbarFlag)}</td>
                              <td className="py-2 px-2 text-right font-mono tabular-nums text-slate-700 truncate">
                                {formatIndex(item.row.ihk, 2)}
                              </td>
                              <td
                                className={`py-2 px-2 text-right font-mono font-extrabold tabular-nums truncate ${
                                  item.row.infMom > 0
                                    ? 'text-rose-700'
                                    : item.row.infMom < 0
                                      ? 'text-emerald-700'
                                      : 'text-slate-700'
                                }`}
                              >
                                {formatSignedPct(item.row.infMom, 2)}
                              </td>
                              <td className="py-2 px-2 text-right font-mono tabular-nums text-slate-800 truncate">
                                {formatAndil(item.row.andilMom, 4)}
                              </td>
                              <td className="py-2 px-2 text-right font-mono tabular-nums text-slate-700 truncate">
                                {formatSignedPct(item.row.infYtd, 2)}
                              </td>
                              <td className="py-2 px-2 text-right font-mono tabular-nums text-slate-700 truncate">
                                {formatSignedPct(item.row.infYoy, 2)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Full Sortable National Table with Kalbar Flags */}
          <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
            <div className="border-b border-slate-200 px-5 py-4 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
              <div>
                <h3 className="text-sm font-bold text-slate-900">
                  Tabel Peringkat Lengkap {activeCatalogItem ? `— ${activeCatalogItem.nama}` : ''}
                </h3>
                <p className="text-xs text-slate-500 mt-0.5 tabular-nums">
                  Menampilkan {crossRegionRows.length} wilayah · Diurutkan berdasarkan{' '}
                  <strong>{crossSortKey}</strong> ({crossSortDir === 'desc' ? 'Tertinggi → Terendah' : 'Terendah → Tertinggi'})
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {/* Region Scope Segmented Control */}
                <div className="inline-flex items-center gap-1 rounded-md bg-slate-100 p-1">
                  {(
                    [
                      { id: 'PROVINSI', label: `Provinsi (${index.provCount})` },
                      { id: 'KABKOTA', label: `Kab/Kota (${index.kabKotaCount})` },
                      { id: 'ALL', label: `Semua (${index.totalRegions})` },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => {
                        setScopeFilter(opt.id);
                        setPage(1);
                      }}
                      className={`rounded px-2.5 py-1 text-xs font-semibold transition-colors whitespace-nowrap ${
                        scopeFilter === opt.id
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>

                {/* Kalbar Only Toggle */}
                <div className="inline-flex items-center gap-1 rounded-md bg-slate-100 p-1">
                  <button
                    type="button"
                    onClick={() => {
                      setKalbarFilter('ALL');
                      setPage(1);
                    }}
                    className={`rounded px-2.5 py-1 text-xs font-semibold transition-colors whitespace-nowrap ${
                      kalbarFilter === 'ALL'
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Semua Wilayah
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setKalbarFilter('KALBAR_ONLY');
                      setPage(1);
                    }}
                    className={`rounded px-2.5 py-1 text-xs font-semibold transition-colors whitespace-nowrap ${
                      kalbarFilter === 'KALBAR_ONLY'
                        ? 'bg-sky-700 text-white shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Hanya Kalbar
                  </button>
                </div>
              </div>
            </div>

            <div className="overflow-y-auto overflow-x-hidden max-h-[68vh]">
              <table className="w-full table-fixed text-left border-collapse text-[11px]">
                <colgroup>
                  <col className="w-[5%]" />
                  <col className="w-[9%]" />
                  <col className="w-[7%]" />
                  <col className="w-[23%]" />
                  <col className="w-[14%]" />
                  <col className="w-[8%]" />
                  <col className="w-[9%]" />
                  <col className="w-[8.5%]" />
                  <col className="w-[8.5%]" />
                  <col className="w-[8%]" />
                </colgroup>
                <thead className="sticky top-0 z-10">
                  <tr className="border-b border-slate-200 bg-slate-50 text-slate-600 leading-tight">
                    <th className="py-2 px-2 font-semibold">No.</th>
                    <th className="py-2 px-2 font-semibold">Rank MoM</th>
                    <th className="py-2 px-2 font-semibold">
                      <button
                        type="button"
                        onClick={() => handleCrossSort('KODE_KOTA')}
                        className="inline-flex items-center gap-0.5 hover:text-slate-900"
                      >
                        <span>Kode</span>
                        {renderCrossSortIcon('KODE_KOTA')}
                      </button>
                    </th>
                    <th className="py-2 px-2 font-semibold">
                      <button
                        type="button"
                        onClick={() => handleCrossSort('NAMA_KOTA')}
                        className="inline-flex items-center gap-1 hover:text-slate-900"
                      >
                        <span>Nama Kota / Provinsi</span>
                        {renderCrossSortIcon('NAMA_KOTA')}
                      </button>
                    </th>
                    <th className="py-2 px-2 font-semibold">Flag</th>
                    <th className="py-2 px-2 font-semibold text-right">
                      <button
                        type="button"
                        onClick={() => handleCrossSort('IHK')}
                        className="inline-flex items-center gap-0.5 hover:text-slate-900"
                      >
                        <span>IHK</span>
                        {renderCrossSortIcon('IHK')}
                      </button>
                    </th>
                    <th className="py-2 px-2 font-semibold text-right">
                      <button
                        type="button"
                        onClick={() => handleCrossSort('INF_MOM')}
                        className="inline-flex items-center gap-0.5 hover:text-slate-900"
                      >
                        <span>INF(MoM)</span>
                        {renderCrossSortIcon('INF_MOM')}
                      </button>
                    </th>
                    <th className="py-2 px-2 font-semibold text-right">
                      <button
                        type="button"
                        onClick={() => handleCrossSort('INF_YTD')}
                        className="inline-flex items-center gap-0.5 hover:text-slate-900"
                      >
                        <span>INF(YtD)</span>
                        {renderCrossSortIcon('INF_YTD')}
                      </button>
                    </th>
                    <th className="py-2 px-2 font-semibold text-right">
                      <button
                        type="button"
                        onClick={() => handleCrossSort('INF_YOY')}
                        className="inline-flex items-center gap-0.5 hover:text-slate-900"
                      >
                        <span>INF(YoY)</span>
                        {renderCrossSortIcon('INF_YOY')}
                      </button>
                    </th>
                    <th className="py-2 px-2 font-semibold text-right">
                      <button
                        type="button"
                        onClick={() => handleCrossSort('ANDIL_MOM')}
                        className="inline-flex items-center gap-0.5 hover:text-slate-900"
                      >
                        <span>Andil</span>
                        {renderCrossSortIcon('ANDIL_MOM')}
                      </button>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {paginatedCrossRows.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="py-8 text-center text-slate-500">
                        Tidak ada baris wilayah untuk filter yang dipilih.
                      </td>
                    </tr>
                  ) : (
                    paginatedCrossRows.map(({ displayOrder, row, rankLevel, rankAll }) => {
                      const rowBg =
                        row.kalbarFlag === 'PROV_KALBAR'
                          ? 'bg-sky-50/80 hover:bg-sky-100/70'
                          : row.kalbarFlag === 'KABKOTA_KALBAR'
                            ? 'bg-amber-50/60 hover:bg-amber-100/60'
                            : 'bg-white hover:bg-slate-50';

                      const effectiveRank = scopeFilter === 'ALL' ? rankAll : rankLevel;

                      return (
                        <tr key={`${row.kdKota}-${row.kode}`} className={`${rowBg} transition-colors`}>
                          <td className="py-2 px-2 font-mono text-slate-500 tabular-nums">
                            {displayOrder}
                          </td>
                          <td className="py-2 px-2 font-mono font-bold text-slate-900 tabular-nums truncate">
                            #{effectiveRank.rank}{' '}
                            <span className="text-[10px] font-normal text-slate-400">
                              /{effectiveRank.total}
                            </span>
                          </td>
                          <td className="py-2 px-2 font-mono font-semibold text-slate-700 truncate">
                            {row.kdKota}
                          </td>
                          <td
                            className="py-2 px-2 font-semibold text-slate-900 truncate"
                            title={row.namaKota}
                          >
                            {row.namaKota}
                          </td>
                          <td className="py-2 px-2 truncate">{renderKalbarFlagTag(row.kalbarFlag)}</td>
                          <td className="py-2 px-2 text-right font-mono tabular-nums text-slate-700 truncate">
                            {formatIndex(row.ihk, 2)}
                          </td>
                          <td
                            className={`py-2 px-2 text-right font-mono font-extrabold tabular-nums truncate ${
                              row.infMom > 0
                                ? 'text-rose-700'
                                : row.infMom < 0
                                  ? 'text-emerald-700'
                                  : 'text-slate-700'
                            }`}
                          >
                            {formatSignedPct(row.infMom, 2)}
                          </td>
                          <td className="py-2 px-2 text-right font-mono tabular-nums text-slate-700 truncate">
                            {formatSignedPct(row.infYtd, 2)}
                          </td>
                          <td className="py-2 px-2 text-right font-mono tabular-nums text-slate-700 truncate">
                            {formatSignedPct(row.infYoy, 2)}
                          </td>
                          <td className="py-2 px-2 text-right font-mono tabular-nums text-slate-800 truncate">
                            {formatAndil(row.andilMom, 4)}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {crossRegionRows.length > PAGE_SIZE && (
              <div className="border-t border-slate-200 px-5 py-3 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600">
                <span className="tabular-nums">
                  {showAllRows
                    ? `Menampilkan semua ${crossRegionRows.length} wilayah`
                    : `Halaman ${page} dari ${totalPages} (${crossRegionRows.length} wilayah)`}
                </span>

                <div className="flex items-center gap-2">
                  {!showAllRows && (
                    <>
                      <button
                        type="button"
                        disabled={page <= 1}
                        onClick={() => setPage((p) => Math.max(1, p - 1))}
                        className="rounded border border-slate-300 bg-white px-2.5 py-1 font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                      >
                        Sebelumnya
                      </button>
                      <button
                        type="button"
                        disabled={page >= totalPages}
                        onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                        className="rounded border border-slate-300 bg-white px-2.5 py-1 font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                      >
                        Berikutnya
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setShowAllRows((v) => !v);
                      setPage(1);
                    }}
                    className="rounded border border-slate-300 bg-white px-2.5 py-1 font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    {showAllRows ? 'Paginasi (50/hal)' : 'Tampilkan Semua'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        /* TAB 2: Sorting Komoditas di Wilayah Kalbar + Kolom Ranking Nasionalnya */
        <div className="space-y-4">
          <div className="rounded-lg border border-slate-200 bg-white p-5 space-y-4">
            <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
              <div>
                <h3 className="text-sm font-bold text-slate-900">
                  Sorting Inflasi Komoditas Wilayah Kalimantan Barat
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Pilih wilayah Kalbar untuk mengurutkan komoditas berdasarkan INF(MoM) sekaligus melihat posisi ranking nasionalnya. Klik baris komoditas untuk membandingkan dengan seluruh wilayah Indonesia.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {index.kalbarRegions.map((reg) => {
                  const isActive = reg.kdKota === selectedKalbarRegion;
                  return (
                    <button
                      key={reg.kdKota}
                      type="button"
                      onClick={() => setSelectedKalbarRegion(reg.kdKota)}
                      className={`rounded-md border px-2.5 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                        isActive
                          ? 'border-slate-900 bg-slate-900 text-white'
                          : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      <span className="font-mono mr-1 opacity-80">{reg.kdKota}</span>
                      <span>{reg.namaKota}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-col sm:flex-row gap-3">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                <input
                  type="text"
                  value={kalbarCommoditySearch}
                  onChange={(e) => setKalbarCommoditySearch(e.target.value)}
                  placeholder="Filter nama atau kode komoditas di wilayah ini..."
                  className="w-full rounded-md border border-slate-300 bg-white pl-9 pr-3 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none"
                />
              </div>

              <select
                aria-label="Filter level flag"
                value={kalbarFlagLevel}
                onChange={(e) => setKalbarFlagLevel(e.target.value as FlagFilter)}
                className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-900 focus:border-slate-900 focus:outline-none"
              >
                <option value="3">Komoditas (Flag 3)</option>
                <option value="ALL">Semua Level (Flag 0–3)</option>
                <option value="0">Umum (Flag 0)</option>
                <option value="1">Kelompok (Flag 1)</option>
                <option value="2">Subkelompok (Flag 2)</option>
              </select>
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
            <div className="border-b border-slate-200 px-5 py-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
              <div className="flex items-center gap-2">
                <span className="font-bold text-slate-900">
                  {activeKalbarRegionInfo?.kdKota} — {activeKalbarRegionInfo?.namaKota}
                </span>
                {activeKalbarRegionInfo && renderKalbarFlagTag(activeKalbarRegionInfo.kalbarFlag)}
              </div>
              <span className="tabular-nums">{kalbarCommodityRows.length} item ditampilkan</span>
            </div>

            <div className="overflow-y-auto overflow-x-hidden max-h-[68vh]">
              <table className="w-full table-fixed text-left border-collapse text-[11px]">
                <colgroup>
                  <col className="w-[5%]" />
                  <col className="w-[9%]" />
                  <col className="w-[29%]" />
                  <col className="w-[8%]" />
                  <col className="w-[10%]" />
                  <col className="w-[13%]" />
                  <col className="w-[9%]" />
                  <col className="w-[8.5%]" />
                  <col className="w-[8.5%]" />
                </colgroup>
                <thead className="sticky top-0 z-10">
                  <tr className="border-b border-slate-200 bg-slate-50 text-slate-600 leading-tight">
                    <th className="py-2 px-2 font-semibold">No.</th>
                    <th className="py-2 px-2 font-semibold">
                      <button
                        type="button"
                        onClick={() => handleKalbarSort('KODE')}
                        className="inline-flex items-center gap-0.5 hover:text-slate-900"
                      >
                        <span>Kode</span>
                        {renderKalbarSortIcon('KODE')}
                      </button>
                    </th>
                    <th className="py-2 px-2 font-semibold">
                      <button
                        type="button"
                        onClick={() => handleKalbarSort('NAMA')}
                        className="inline-flex items-center gap-1 hover:text-slate-900"
                      >
                        <span>Nama Komoditas</span>
                        {renderKalbarSortIcon('NAMA')}
                      </button>
                    </th>
                    <th className="py-2 px-2 font-semibold text-right">
                      <button
                        type="button"
                        onClick={() => handleKalbarSort('IHK')}
                        className="inline-flex items-center gap-0.5 hover:text-slate-900"
                      >
                        <span>IHK</span>
                        {renderKalbarSortIcon('IHK')}
                      </button>
                    </th>
                    <th className="py-2 px-2 font-semibold text-right">
                      <button
                        type="button"
                        onClick={() => handleKalbarSort('INF_MOM')}
                        className="inline-flex items-center gap-0.5 hover:text-slate-900"
                      >
                        <span>INF(MoM)</span>
                        {renderKalbarSortIcon('INF_MOM')}
                      </button>
                    </th>
                    <th className="py-2 px-2 font-semibold text-right">
                      <button
                        type="button"
                        onClick={() => handleKalbarSort('RANK_NASIONAL')}
                        className="inline-flex items-center gap-0.5 hover:text-slate-900"
                      >
                        <span>Rank Nas.</span>
                        {renderKalbarSortIcon('RANK_NASIONAL')}
                      </button>
                    </th>
                    <th className="py-2 px-2 font-semibold text-right">
                      <button
                        type="button"
                        onClick={() => handleKalbarSort('ANDIL_MOM')}
                        className="inline-flex items-center gap-0.5 hover:text-slate-900"
                      >
                        <span>Andil</span>
                        {renderKalbarSortIcon('ANDIL_MOM')}
                      </button>
                    </th>
                    <th className="py-2 px-2 font-semibold text-right">
                      <button
                        type="button"
                        onClick={() => handleKalbarSort('INF_YTD')}
                        className="inline-flex items-center gap-0.5 hover:text-slate-900"
                      >
                        <span>INF(YtD)</span>
                        {renderKalbarSortIcon('INF_YTD')}
                      </button>
                    </th>
                    <th className="py-2 px-2 font-semibold text-right">
                      <button
                        type="button"
                        onClick={() => handleKalbarSort('INF_YOY')}
                        className="inline-flex items-center gap-0.5 hover:text-slate-900"
                      >
                        <span>INF(YoY)</span>
                        {renderKalbarSortIcon('INF_YOY')}
                      </button>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {kalbarCommodityRows.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="py-8 text-center text-slate-500">
                        Tidak ada komoditas yang cocok dengan filter.
                      </td>
                    </tr>
                  ) : (
                    kalbarCommodityRows.map(({ row, rankLevel }, idx) => (
                      <tr
                        key={`${row.flag}-${row.kode}`}
                        onClick={() => {
                          setSelectedCommodityKey(`${row.flag}|${row.kode}`);
                          setSearchQuery(row.nama);
                          setScopeFilter(row.regionLevel);
                          setViewMode('CROSS_REGION');
                          setPage(1);
                        }}
                        className="cursor-pointer hover:bg-sky-50/60 transition-colors"
                        title="Klik untuk melihat posisi peringkat nasional komoditas ini"
                      >
                        <td className="py-2 px-2 font-mono text-slate-400 tabular-nums">
                          {idx + 1}
                        </td>
                        <td className="py-2 px-2 font-mono font-semibold text-slate-700 truncate">
                          {row.kode}
                        </td>
                        <td
                          className="py-2 px-2 font-semibold text-slate-900 truncate"
                          title={row.nama}
                        >
                          {row.nama}
                        </td>
                        <td className="py-2 px-2 text-right font-mono tabular-nums text-slate-700 truncate">
                          {formatIndex(row.ihk, 2)}
                        </td>
                        <td
                          className={`py-2 px-2 text-right font-mono font-extrabold tabular-nums truncate ${
                            row.infMom > 0
                              ? 'text-rose-700'
                              : row.infMom < 0
                                ? 'text-emerald-700'
                                : 'text-slate-700'
                          }`}
                        >
                          {formatSignedPct(row.infMom, 2)}
                        </td>
                        <td className="py-2 px-2 text-right font-mono font-bold text-sky-800 tabular-nums truncate">
                          #{rankLevel.rank}{' '}
                          <span className="text-[10px] font-normal text-slate-400">
                            /{rankLevel.total} {row.regionLevel === 'PROVINSI' ? 'Prov' : 'Kab'}
                          </span>
                        </td>
                        <td className="py-2 px-2 text-right font-mono tabular-nums text-slate-800 truncate">
                          {formatAndil(row.andilMom, 4)}
                        </td>
                        <td className="py-2 px-2 text-right font-mono tabular-nums text-slate-700 truncate">
                          {formatSignedPct(row.infYtd, 2)}
                        </td>
                        <td className="py-2 px-2 text-right font-mono tabular-nums text-slate-700 truncate">
                          {formatSignedPct(row.infYoy, 2)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
