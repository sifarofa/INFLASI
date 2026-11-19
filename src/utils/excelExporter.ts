import * as XLSX from 'xlsx';
import type {
  AngkaSementaraRow,
  PeriodSelection,
  RegionCode,
  RegionLKResult,
  RespondentFrequency,
  RespondentPriceObservation,
  TabelJejerRow,
  UploadFileKind,
} from '../types/inflasi';
import {
  formatPeriodLabel,
  getCurrentMonthLabel,
  getPrevMonthLabel,
  JEJER_COLUMN_ORDER,
  REGIONS,
} from '../data/regions';

function buildLKSheetAoA(result: RegionLKResult, period: PeriodSelection): unknown[][] {
  const prevLabel = getPrevMonthLabel(period);
  const currLabel = getCurrentMonthLabel(period);
  const { umum } = result;

  const summaryRow: unknown[] = [
    result.regionCode,
    `TOTAL ${result.regionName.toUpperCase()}`,
    Number(umum.nk0.toFixed(2)),
    Number(umum.nkPrev.toFixed(2)),
    Number(umum.nkCurrent.toFixed(2)),
    100,
    100,
    Number(umum.rhCurrent.toFixed(6)),
    Number(umum.andilInflasi.toFixed(6)),
    Number(umum.ihkPrev.toFixed(4)),
    Number(umum.ihkCurrent.toFixed(4)),
    Number(umum.inflasi.toFixed(6)),
  ];

  const headerRow: unknown[] = [
    'Kode',
    'Komoditas / Hierarki',
    'Level',
    'NK0=SBH',
    `NK ${prevLabel}`,
    `NK ${currLabel}`,
    `%NK Thd Total ${prevLabel}`,
    `%NK Thd Total ${currLabel}`,
    `RH ${currLabel}`,
    'Andil Inflasi',
    `IHK ${prevLabel}`,
    `IHK ${currLabel}`,
    'Inflasi MtM (%)',
  ];

  const levelLabel = (flag: number) => {
    if (flag === 0) return 'UMUM';
    if (flag === 1) return 'KELOMPOK';
    if (flag === 2) return 'SUBKELOMPOK';
    return 'KOMODITAS';
  };

  const dataRows = result.rows.map((r) => [
    r.kode,
    r.nama,
    levelLabel(r.flag),
    Number(r.nk0.toFixed(2)),
    Number(r.nkPrev.toFixed(2)),
    Number(r.nkCurrent.toFixed(2)),
    Number(r.pctNkPrev.toFixed(6)),
    Number(r.pctNkCurrent.toFixed(6)),
    Number(r.rhCurrent.toFixed(6)),
    Number(r.andilInflasi.toFixed(6)),
    Number(r.ihkPrev.toFixed(6)),
    Number(r.ihkCurrent.toFixed(6)),
    Number(r.inflasi.toFixed(6)),
  ]);

  return [
    [`LEMBAR KERJA PENGHITUNGAN INFLASI IHK (2022=100) — ${result.regionCode} ${result.regionName.toUpperCase()} — ${formatPeriodLabel(period).toUpperCase()}`],
    [summaryRow[0], summaryRow[1], 'RINGKASAN', ...summaryRow.slice(2)],
    headerRow,
    ...dataRows,
  ];
}

function applyColumnWidths(ws: XLSX.WorkSheet) {
  ws['!cols'] = [
    { wch: 12 },
    { wch: 46 },
    { wch: 13 },
    { wch: 18 },
    { wch: 18 },
    { wch: 18 },
    { wch: 16 },
    { wch: 16 },
    { wch: 14 },
    { wch: 14 },
    { wch: 14 },
    { wch: 14 },
    { wch: 14 },
  ];
}

export function exportSingleRegionWorkbook(result: RegionLKResult, period: PeriodSelection): void {
  const wb = XLSX.utils.book_new();
  const aoa = buildLKSheetAoA(result, period);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  applyColumnWidths(ws);

  const safeSheetName = `${result.regionCode}_${result.regionName.replace(/[^a-zA-Z0-9 ]/g, '').slice(0, 24)}`;
  XLSX.utils.book_append_sheet(wb, ws, safeSheetName);

  const slug = formatPeriodLabel(period).replace(/\s+/g, '_');
  XLSX.writeFile(wb, `LK_IHK_${result.regionCode}_${slug}.xlsx`);
}

export function exportAllRegionsWorkbook(
  allResults: Record<RegionCode, RegionLKResult>,
  period: PeriodSelection
): void {
  const wb = XLSX.utils.book_new();
  const prevLabel = getPrevMonthLabel(period);
  const currLabel = getCurrentMonthLabel(period);

  const summaryAoA: unknown[][] = [
    [`RINGKASAN MONITORING INFLASI KALIMANTAN BARAT (6100) & 5 KAB/KOTA — ${formatPeriodLabel(period).toUpperCase()}`],
    [],
    [
      'Kode Wilayah',
      'Nama Wilayah',
      'Status',
      'Jml Pakom',
      'NK0 (SBH 2022)',
      `NK ${prevLabel}`,
      `NK ${currLabel}`,
      `IHK ${prevLabel}`,
      `IHK ${currLabel}`,
      'RH Agregat',
      'Inflasi MtM (%)',
    ],
    ...REGIONS.map((reg) => {
      const res = allResults[reg.code];
      const u = res.umum;
      return [
        reg.code,
        reg.name,
        reg.isAggregated ? 'Agregasi Tertimbang Provinsi' : 'Kab/Kota IHK',
        res.pakomCount,
        Number(u.nk0.toFixed(2)),
        Number(u.nkPrev.toFixed(2)),
        Number(u.nkCurrent.toFixed(2)),
        Number(u.ihkPrev.toFixed(4)),
        Number(u.ihkCurrent.toFixed(4)),
        Number(u.rhCurrent.toFixed(6)),
        Number(u.inflasi.toFixed(6)),
      ];
    }),
  ];

  const summaryWs = XLSX.utils.aoa_to_sheet(summaryAoA);
  summaryWs['!cols'] = [
    { wch: 14 },
    { wch: 28 },
    { wch: 28 },
    { wch: 12 },
    { wch: 20 },
    { wch: 20 },
    { wch: 20 },
    { wch: 14 },
    { wch: 14 },
    { wch: 14 },
    { wch: 15 },
  ];
  XLSX.utils.book_append_sheet(wb, summaryWs, 'Ringkasan_Kalbar');

  for (const reg of REGIONS) {
    const res = allResults[reg.code];
    const ws = XLSX.utils.aoa_to_sheet(buildLKSheetAoA(res, period));
    applyColumnWidths(ws);
    const sheetTitle = `${reg.code}_${reg.shortName.replace(/\s+/g, '')}`.slice(0, 31);
    XLSX.utils.book_append_sheet(wb, ws, sheetTitle);
  }

  const slug = formatPeriodLabel(period).replace(/\s+/g, '_');
  XLSX.writeFile(wb, `LK_IHK_Kalbar_6100_Lengkap_${slug}.xlsx`);
}

export type JejerMetricExport = 'andil' | 'andilBps' | 'inflasi' | 'rh' | 'ihk';

export function exportTabelJejerWorkbook(
  rows: TabelJejerRow[],
  period: PeriodSelection,
  metric: JejerMetricExport,
  allowedRegion?: RegionCode
): void {
  const wb = XLSX.utils.book_new();
  const labelMap: Record<JejerMetricExport, string> = {
    andil: 'Andil Inflasi (%)',
    andilBps: 'Andil Inflasi (bps / ×100)',
    inflasi: 'Inflasi MtM (%)',
    rh: 'Relatif Harga (RH)',
    ihk: 'IHK Berjalan',
  };

  const columnsToExport: RegionCode[] =
    allowedRegion && allowedRegion !== '6100' ? [allowedRegion] : JEJER_COLUMN_ORDER;

  const filteredRows =
    allowedRegion && allowedRegion !== '6100'
      ? rows.filter((r) => r.cells[allowedRegion]?.inPakom)
      : rows;

  const getCellVal = (cell: TabelJejerRow['cells'][RegionCode]): string | number => {
    if (!cell.inPakom) return '-';
    if (metric === 'andil') return Number((cell.andilInflasi ?? 0).toFixed(6));
    if (metric === 'andilBps') return Number(((cell.andilInflasi ?? 0) * 100).toFixed(4));
    if (metric === 'inflasi') return Number((cell.inflasi ?? 0).toFixed(6));
    if (metric === 'rh') return Number((cell.rhCurrent ?? 100).toFixed(6));
    return Number((cell.ihkCurrent ?? 0).toFixed(4));
  };

  const aoa: unknown[][] = [
    [
      `TABEL RINGKASAN ${labelMap[metric].toUpperCase()} (${allowedRegion ?? '6100 KALBAR'}) — ${formatPeriodLabel(
        period
      ).toUpperCase()}`,
    ],
    allowedRegion && allowedRegion !== '6100'
      ? ['Kode', 'Komoditas / Hierarki', 'Level', 'Andil (%)', 'Andil (bps)', 'Inflasi MtM (%)', 'RH (N)', 'IHK (N)']
      : [
          'Kode',
          'Komoditas / Hierarki',
          'Level',
          ...columnsToExport.map((c) => {
            const info = REGIONS.find((r) => r.code === c);
            return `${info?.shortName ?? c} (${c})`;
          }),
          'Kab Naik',
          'Kab Turun',
          'Kab Tetap',
        ],
    ...filteredRows.map((r) =>
      allowedRegion && allowedRegion !== '6100'
        ? [
            r.kode,
            r.nama,
            r.flag === 0 ? 'UMUM' : r.flag === 1 ? 'KELOMPOK' : r.flag === 2 ? 'SUBKELOMPOK' : 'KOMODITAS',
            Number((r.cells[allowedRegion]?.andilInflasi ?? 0).toFixed(6)),
            Number(((r.cells[allowedRegion]?.andilInflasi ?? 0) * 100).toFixed(4)),
            Number((r.cells[allowedRegion]?.inflasi ?? 0).toFixed(6)),
            Number((r.cells[allowedRegion]?.rhCurrent ?? 100).toFixed(6)),
            Number((r.cells[allowedRegion]?.ihkCurrent ?? 0).toFixed(4)),
          ]
        : [
            r.kode,
            r.nama,
            r.flag === 0 ? 'UMUM' : r.flag === 1 ? 'KELOMPOK' : r.flag === 2 ? 'SUBKELOMPOK' : 'KOMODITAS',
            ...columnsToExport.map((c) => getCellVal(r.cells[c])),
            r.upCount,
            r.downCount,
            r.flatCount,
          ]
    ),
  ];

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [
    { wch: 12 },
    { wch: 44 },
    { wch: 13 },
    { wch: 14 },
    { wch: 14 },
    { wch: 14 },
    { wch: 14 },
    { wch: 14 },
    { wch: 15 },
    { wch: 10 },
    { wch: 10 },
    { wch: 10 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Tabel_Ringkasan');
  const slug = formatPeriodLabel(period).replace(/\s+/g, '_');
  XLSX.writeFile(wb, `Ringkasan_${allowedRegion ?? 'Kalbar'}_${slug}.xlsx`);
}

export function exportRespondentAnalysisWorkbook(
  observations: RespondentPriceObservation[],
  period: PeriodSelection,
  frequency: RespondentFrequency,
  regionCode: string
): void {
  const wb = XLSX.utils.book_new();
  const prevHeaders =
    frequency === 'MINGGUAN'
      ? ['Prev M1', 'Prev M2', 'Prev M3', 'Prev M4', 'Prev M5']
      : frequency === 'DWIMINGGUAN'
      ? ['Prev M1', 'Prev M3']
      : ['Bulan Sebelum'];
  const currHeaders =
    frequency === 'MINGGUAN'
      ? ['Curr M1', 'Curr M2', 'Curr M3', 'Curr M4', 'Curr M5']
      : frequency === 'DWIMINGGUAN'
      ? ['Curr M1', 'Curr M3']
      : ['Bulan Berjalan'];

  const aoa: unknown[][] = [
    [`ANALISIS RH LEVEL RESPONDEN (${frequency}) — WILAYAH ${regionCode} — ${formatPeriodLabel(period).toUpperCase()}`],
    [
      'Kode Komoditas',
      'Komoditas',
      'Kode Kualitas',
      'Kualitas',
      'Bobot Kualitas',
      'Jenis Pasar',
      'Pasar',
      'Nama Responden',
      ...prevHeaders,
      ...currHeaders,
      'Rata2 Geometri N-1',
      'Rata2 Geometri N',
      'RH Responden',
      'Perubahan (%)',
    ],
    ...observations.map((o) => [
      o.kodeKomoditas,
      o.komoditas,
      o.kodeKualitas,
      o.kualitas,
      o.bobotKualitas,
      o.jenisPasar,
      o.pasar,
      o.namaResponden,
      ...o.prevPrices.map((p) => p ?? ''),
      ...o.currPrices.map((p) => p ?? ''),
      o.prevAvgPrice ? Number(o.prevAvgPrice.toFixed(2)) : '',
      o.currAvgPrice ? Number(o.currAvgPrice.toFixed(2)) : '',
      o.priceRelative ? Number(o.priceRelative.toFixed(4)) : '',
      o.priceRelative ? Number((o.priceRelative - 100).toFixed(4)) : '',
    ]),
  ];

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  XLSX.utils.book_append_sheet(wb, ws, `RH_Responden_${frequency}`);
  const slug = formatPeriodLabel(period).replace(/\s+/g, '_');
  XLSX.writeFile(wb, `Analisis_RH_Responden_${frequency}_${regionCode}_${slug}.xlsx`);
}

export function exportUploadTemplateWorkbook(
  kind: UploadFileKind,
  regionLK: RegionLKResult,
  period: PeriodSelection
): void {
  const wb = XLSX.utils.book_new();
  const cityLabel = regionLK.regionName
    .replace(/^(KABUPATEN|KOTA)\s+/i, '')
    .toUpperCase();

  if (kind === 'NK0') {
    const aoa: unknown[][] = [
      ['Kode Kota', 'Kota', 'Kel', 'Kelompok', 'IN', 'GAB', 'NK0=SBH2022'],
      ...regionLK.rows.map((r) => [
        regionLK.regionCode,
        cityLabel,
        r.kode,
        r.nama,
        r.flag,
        `${regionLK.regionCode}${r.flag}`,
        Number(r.nk0.toFixed(2)),
      ]),
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [
      { wch: 11 },
      { wch: 18 },
      { wch: 12 },
      { wch: 44 },
      { wch: 6 },
      { wch: 10 },
      { wch: 22 },
    ];
    XLSX.utils.book_append_sheet(wb, ws, `Template_NK0_${regionLK.regionCode}`);
    XLSX.writeFile(wb, `Template_NK0_${regionLK.regionCode}.xlsx`);
    return;
  }

  if (kind === 'NK_PREV') {
    const prevMonthNum = period.month === 1 ? 12 : period.month - 1;
    const prevYear = period.month === 1 ? period.year - 1 : period.year;
    const prevMonthStr = String(prevMonthNum).padStart(2, '0');

    const aoa: unknown[][] = [
      ['', '', '', 'Tabel Indeks Jejer Inflasi (2022=100)'],
      [],
      ['Tahun', 'Bulan', 'Kode Kota', 'Nama Kota', 'Kode Komoditas', 'Nama Komoditas', 'Flag', 'NK'],
      ...regionLK.rows.map((r) => [
        prevYear,
        prevMonthStr,
        regionLK.regionCode,
        cityLabel,
        r.kode,
        r.nama,
        r.flag,
        Number(r.nkPrev.toFixed(2)),
      ]),
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [
      { wch: 8 },
      { wch: 8 },
      { wch: 11 },
      { wch: 18 },
      { wch: 16 },
      { wch: 44 },
      { wch: 8 },
      { wch: 22 },
    ];
    XLSX.utils.book_append_sheet(wb, ws, `Template_NK_${regionLK.regionCode}`);
    XLSX.writeFile(wb, `Template_NK_${regionLK.regionCode}_${prevYear}_${prevMonthStr}.xlsx`);
    return;
  }

  const currMonthLabel = getCurrentMonthLabel(period);
  const aoa: unknown[][] = [
    ['Tabel RH per Komoditas'],
    ['Kuesioner', 'Kode Komoditas', 'Nama Komoditas', 'Bulan Sebelum', currMonthLabel, 'RH'],
    ...regionLK.commodities.map((c) => [
      c.kuesioner ?? 'HK-1.1',
      c.kode,
      c.nama,
      '',
      '',
      Number(c.rhCurrent.toFixed(6)),
    ]),
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [
    { wch: 12 },
    { wch: 16 },
    { wch: 44 },
    { wch: 16 },
    { wch: 16 },
    { wch: 16 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, `Template_RH_${regionLK.regionCode}`);
  const slug = formatPeriodLabel(period).replace(/\s+/g, '_');
  XLSX.writeFile(wb, `Template_RH_${regionLK.regionCode}_${slug}.xlsx`);
}

export function exportRespondentTemplateWorkbook(frequency: RespondentFrequency): void {
  const wb = XLSX.utils.book_new();
  const titleMap: Record<RespondentFrequency, string> = {
    MINGGUAN: 'Tabel Harga per Responden (Mingguan)',
    DWIMINGGUAN: 'Tabel Harga per Responden (Dwimingguan)',
    BULANAN: 'Tabel Harga per Responden (Bulanan)',
  };
  const periodHeaders =
    frequency === 'MINGGUAN'
      ? ['M1', 'M2', 'M3', 'M4', 'M5', 'M1', 'M2', 'M3', 'M4', 'M5']
      : frequency === 'DWIMINGGUAN'
      ? ['M1', 'M3', 'M1', 'M3']
      : ['Bulan Sebelum', 'Bulan Berjalan'];

  const sampleRow =
    frequency === 'MINGGUAN'
      ? ['0111001', 'BERAS', '0111001263', '0.00', 'CONTOH KUALITAS 1 KG', '1.00', 'Tradisional', '0.50', 'PASAR UTAMA', 'TOKO CONTOH', 18000, 18000, 18000, 18000, '', 18200, 18200, 18200, 18200, '']
      : frequency === 'DWIMINGGUAN'
      ? ['0111047', 'MIE KERING INSTANT', '0111047030', '0.00', 'CONTOH MIE 75 GR', '1.00', 'Tradisional', '0.50', 'PASAR UTAMA', 'TOKO CONTOH', 3300, 3300, 3400, 3400]
      : ['0111013', 'BISKUIT', '0111013009', '0.33', 'CONTOH BISKUIT 140 GR', '0.50', 'Modern/Swalayan', '0.00', 'SWALAYAN CONTOH', 'Toko Contoh', 8500, 8600];

  const aoa: unknown[][] = [
    [titleMap[frequency]],
    [
      'Kode Komoditas',
      'Komoditas',
      'Kode Kualitas',
      'Bobot Kualitas',
      'Kualitas',
      'Bobot Jenis Pasar',
      'Jenis Pasar',
      'Bobot Pasar',
      'Pasar',
      'Nama Responden',
      ...periodHeaders,
    ],
    sampleRow,
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  XLSX.utils.book_append_sheet(wb, ws, `Template_${frequency}`);
  XLSX.writeFile(wb, `Template_Harga_Responden_${frequency}.xlsx`);
}

export interface ExportRankingRow {
  rank: number;
  row: AngkaSementaraRow;
  rankLevelLabel: string;
  rankAllLabel: string;
}

export function exportAngkaSementaraRankingWorkbook(params: {
  title: string;
  commodityLabel: string;
  scopeLabel: string;
  rows: ExportRankingRow[];
  kalbarRows: ExportRankingRow[];
}): void {
  const wb = XLSX.utils.book_new();

  const kalbarSheetAoA: unknown[][] = [
    [`DETEKSI RANKING KALBAR — ${params.commodityLabel.toUpperCase()}`],
    [params.title],
    ['Rank Lingkup', 'Rank Gabungan', 'Kd.Kota', 'Nama Wilayah', 'Flag Kalbar', 'Kode', 'Komoditas', 'IHK', 'INF(MOM)', 'INF(YTD)', 'INF(YOY)', 'ANDIL(MOM)', 'ANDIL(YTD)', 'ANDIL(YOY)'],
    ...params.kalbarRows.map((item) => [
      item.rankLevelLabel,
      item.rankAllLabel,
      item.row.kdKota,
      item.row.namaKota,
      item.row.kalbarFlag === 'PROV_KALBAR' ? 'Provinsi Kalimantan Barat' : 'Kab/Kota Kalimantan Barat',
      item.row.kode,
      item.row.nama,
      item.row.ihk,
      item.row.infMom,
      item.row.infYtd,
      item.row.infYoy,
      item.row.andilMom,
      item.row.andilYtd,
      item.row.andilYoy,
    ]),
  ];
  const wsKalbar = XLSX.utils.aoa_to_sheet(kalbarSheetAoA);
  XLSX.utils.book_append_sheet(wb, wsKalbar, 'Kalbar_Highlight');

  const fullSheetAoA: unknown[][] = [
    [`PERINGKAT ${params.scopeLabel.toUpperCase()} — ${params.commodityLabel.toUpperCase()}`],
    [params.title],
    ['No. Urut', 'Rank Lingkup', 'Rank Gabungan', 'Kd.Kota', 'Nama Wilayah', 'Tingkat', 'Flag Kalbar', 'Kode', 'Nama', 'Flag', 'IHK', 'INF(MOM)', 'INF(YTD)', 'INF(YOY)', 'ANDIL(MOM)', 'ANDIL(YTD)', 'ANDIL(YOY)'],
    ...params.rows.map((item) => [
      item.rank,
      item.rankLevelLabel,
      item.rankAllLabel,
      item.row.kdKota,
      item.row.namaKota,
      item.row.regionLevel,
      item.row.kalbarFlag === 'PROV_KALBAR'
        ? 'Provinsi Kalbar'
        : item.row.kalbarFlag === 'KABKOTA_KALBAR'
          ? 'Kab/Kota Kalbar'
          : 'Luar Kalbar',
      item.row.kode,
      item.row.nama,
      item.row.flag,
      item.row.ihk,
      item.row.infMom,
      item.row.infYtd,
      item.row.infYoy,
      item.row.andilMom,
      item.row.andilYtd,
      item.row.andilYoy,
    ]),
  ];
  const wsFull = XLSX.utils.aoa_to_sheet(fullSheetAoA);
  XLSX.utils.book_append_sheet(wb, wsFull, 'Ranking_INF_MOM');

  const safeSlug = params.commodityLabel.replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 32);
  XLSX.writeFile(wb, `Ranking_INF_MOM_${safeSlug}.xlsx`);
}


