import { supabase } from '../lib/supabase';
import { getRegionInfo, KAB_KOTA_CODES } from '../data/regions';
import { HIERARCHY_NODES } from '../data/masterHierarchy';
import type {
  CommodityInputRow,
  HierarchyNodeMeta,
  KabKotaCode,
  PeriodSelection,
  RespondentFrequency,
  RespondentPriceObservation,
  RespondentRHDataset,
  UpdateHistoryEntry,
  UploadFileKind,
} from '../types/inflasi';
import { summarizeRespondentRH } from './excelParser';

export interface SupabaseLKRow {
  tahun: number;
  bulan: number;
  kode_wilayah: string;
  nama_wilayah: string;
  kode_kelompok: string;
  kode_komoditas: string;
  nama_komoditas: string;
  bobot: number;
  nk_dasar: number;
  nk_n1: number;
  rh_n: number;
}

interface RawSupabaseLKRow {
  tahun: number;
  bulan: number;
  kode_wilayah: string;
  nama_wilayah?: string | null;
  kode_kelompok?: string | null;
  kode_komoditas: string;
  nama_komoditas?: string | null;
  bobot?: number | null;
  nk_dasar: number;
  nk_n1: number;
  rh_n: number;
}

interface RawSupabaseUploadLogRow {
  id?: string | number;
  tahun: number;
  bulan: number;
  jenis_upload: string;
  nama_file: string;
  jumlah_baris: number;
  created_at?: string;
}

interface RawSupabaseRespondentRow {
  id?: string;
  tahun: number;
  bulan: number;
  kode_wilayah: string;
  kode_komoditas: string;
  kode_responden: string;
  nama_responden: string;
  kualitas: string;
  frekuensi: string;
  harga_lalu: number | null;
  harga_berjalan: number | null;
  rh_responden: number | null;
  updated_at?: string;
}

const BATCH_SIZE = 500;
const PAGE_SIZE = 1000;
const KABKOTA_SET = new Set<string>(KAB_KOTA_CODES);

const DEFAULT_NODE_NAMES = new Map<string, string>(
  HIERARCHY_NODES.filter((n) => n.flag === 3).map((n) => [n.kode, n.nama])
);

function isKabKotaCode(code: string): code is KabKotaCode {
  return KABKOTA_SET.has(code);
}

function normalizeKode7(raw: unknown): string {
  const s = String(raw ?? '').trim().replace(/\.0+$/, '');
  if (!s) return '';
  if (/^\d+$/.test(s) && (s.length === 6 || s.length === 7)) {
    return s.padStart(7, '0');
  }
  return s;
}

export async function fetchPeriodLKFromSupabase(period: PeriodSelection): Promise<{
  byRegion: Partial<Record<KabKotaCode, Record<string, CommodityInputRow>>>;
  totalRows: number;
  extraNames: Record<string, string>;
}> {
  if (!supabase) {
    return { byRegion: {}, totalRows: 0, extraNames: {} };
  }

  const allRows: RawSupabaseLKRow[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from('inflasi_lk_data')
      .select('tahun,bulan,kode_wilayah,kode_komoditas,nama_komoditas,nk_dasar,nk_n1,rh_n')
      .eq('tahun', period.year)
      .eq('bulan', period.month)
      .in('kode_wilayah', KAB_KOTA_CODES)
      .order('kode_wilayah', { ascending: true })
      .order('kode_komoditas', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) {
      throw new Error(error.message || 'Gagal memuat data LK dari Supabase.');
    }

    const chunk = (data ?? []) as RawSupabaseLKRow[];
    allRows.push(...chunk);
    if (chunk.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  const byRegion: Partial<Record<KabKotaCode, Record<string, CommodityInputRow>>> = {};
  const extraNames: Record<string, string> = {};

  for (const row of allRows) {
    const regionCode = String(row.kode_wilayah ?? '').trim();
    if (!isKabKotaCode(regionCode)) continue;

    const kode = normalizeKode7(row.kode_komoditas);
    if (!kode) continue;

    if (!byRegion[regionCode]) {
      byRegion[regionCode] = {};
    }

    const nk0 = Number(row.nk_dasar);
    const nkPrev = Number(row.nk_n1);
    const rhCurrent = Number(row.rh_n);

    byRegion[regionCode]![kode] = {
      kode,
      nk0: Number.isFinite(nk0) ? nk0 : 0,
      nkPrev: Number.isFinite(nkPrev) ? nkPrev : 0,
      rhCurrent: Number.isFinite(rhCurrent) && rhCurrent > 0 ? rhCurrent : 100,
    };

    if (row.nama_komoditas) {
      extraNames[kode] = String(row.nama_komoditas);
    }
  }

  return { byRegion, totalRows: allRows.length, extraNames };
}

/**
 * Ambil daftar periode (tahun, bulan) unik yang sudah memiliki data di inflasi_lk_data,
 * diurutkan dari terbaru ke terlama.
 */
export async function fetchAvailablePeriodsFromSupabase(
  maxPeriods = 12
): Promise<PeriodSelection[]> {
  if (!supabase) return [];

  const periods: PeriodSelection[] = [];
  let cursor: PeriodSelection | null = null;

  for (let i = 0; i < maxPeriods; i++) {
    let query = supabase
      .from('inflasi_lk_data')
      .select('tahun,bulan')
      .in('kode_wilayah', KAB_KOTA_CODES)
      .order('tahun', { ascending: false })
      .order('bulan', { ascending: false })
      .limit(1);

    if (cursor) {
      query = query.or(
        `tahun.lt.${cursor.year},and(tahun.eq.${cursor.year},bulan.lt.${cursor.month})`
      );
    }

    const { data, error } = await query;
    if (error || !data || data.length === 0) break;

    const y = Number(data[0].tahun);
    const m = Number(data[0].bulan);
    if (!Number.isFinite(y) || !Number.isFinite(m)) break;

    const found: PeriodSelection = { year: y, month: m };
    periods.push(found);
    cursor = found;
  }

  return periods;
}

/**
 * Tarik Pakom & NK0 (nk_dasar) terbaru dari periode lain di Supabase bagi Kab/Kota
 * yang belum memiliki entri pada periode aktif (agar NK0 selalu tersimpan lintas bulan).
 */
export async function fetchLatestNk0BaselineForRegions(
  missingRegions: KabKotaCode[]
): Promise<Partial<Record<KabKotaCode, Record<string, CommodityInputRow>>>> {
  if (!supabase || missingRegions.length === 0) return {};

  const result: Partial<Record<KabKotaCode, Record<string, CommodityInputRow>>> = {};

  for (const regionCode of missingRegions) {
    const { data: latestMeta, error: latestErr } = await supabase
      .from('inflasi_lk_data')
      .select('tahun,bulan')
      .eq('kode_wilayah', regionCode)
      .order('tahun', { ascending: false })
      .order('bulan', { ascending: false })
      .limit(1);

    if (latestErr || !latestMeta || latestMeta.length === 0) continue;

    const latestYear = Number(latestMeta[0].tahun);
    const latestMonth = Number(latestMeta[0].bulan);

    const rows: RawSupabaseLKRow[] = [];
    let offset = 0;
    while (true) {
      const { data, error } = await supabase
        .from('inflasi_lk_data')
        .select('kode_komoditas,nk_dasar')
        .eq('tahun', latestYear)
        .eq('bulan', latestMonth)
        .eq('kode_wilayah', regionCode)
        .range(offset, offset + PAGE_SIZE - 1);

      if (error) break;
      const chunk = (data ?? []) as RawSupabaseLKRow[];
      rows.push(...chunk);
      if (chunk.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }

    if (rows.length > 0) {
      const map: Record<string, CommodityInputRow> = {};
      for (const r of rows) {
        const kode = normalizeKode7(r.kode_komoditas);
        if (!kode) continue;
        const nk0 = Number(r.nk_dasar);
        const safeNk0 = Number.isFinite(nk0) ? nk0 : 0;
        map[kode] = {
          kode,
          nk0: safeNk0,
          nkPrev: safeNk0,
          rhCurrent: 100,
        };
      }
      result[regionCode] = map;
    }
  }

  return result;
}

export async function upsertLKRowsBatchToSupabase(rows: SupabaseLKRow[]): Promise<number> {
  if (!supabase || rows.length === 0) return 0;

  // Deduplikasi kunci komposit untuk mencegah error PostgreSQL ON CONFLICT double-hit
  const deduped = new Map<string, SupabaseLKRow>();
  for (const r of rows) {
    const key = `${r.tahun}|${r.bulan}|${r.kode_wilayah}|${r.kode_komoditas}`;
    deduped.set(key, {
      tahun: r.tahun,
      bulan: r.bulan,
      kode_wilayah: r.kode_wilayah,
      nama_wilayah: r.nama_wilayah,
      kode_kelompok: r.kode_kelompok,
      kode_komoditas: r.kode_komoditas,
      nama_komoditas: r.nama_komoditas,
      bobot: Number.isFinite(r.bobot) ? r.bobot : 0,
      nk_dasar: Number.isFinite(r.nk_dasar) ? r.nk_dasar : 0,
      nk_n1: Number.isFinite(r.nk_n1) ? r.nk_n1 : 0,
      rh_n: Number.isFinite(r.rh_n) && r.rh_n > 0 ? r.rh_n : 100,
    });
  }

  const payload = Array.from(deduped.values());

  for (let i = 0; i < payload.length; i += BATCH_SIZE) {
    const chunk = payload.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from('inflasi_lk_data')
      .upsert(chunk, { onConflict: 'tahun,bulan,kode_wilayah,kode_komoditas' });
    if (error) {
      throw new Error(error.message || 'Gagal menyimpan data ke inflasi_lk_data.');
    }
  }

  return payload.length;
}

export async function insertUploadLogsToSupabase(
  entries: Array<{
    regionCode: KabKotaCode;
    period: PeriodSelection;
    kind: UpdateHistoryEntry['kind'];
    fileName: string;
    matchedCount: number;
    unmatchedCount: number;
  }>
): Promise<void> {
  if (!supabase || entries.length === 0) return;

  const payload = entries.map((e) => ({
    tahun: e.period.year,
    bulan: e.period.month,
    jenis_upload: `${e.regionCode} · ${e.kind}`,
    nama_file: e.fileName,
    jumlah_baris: e.matchedCount,
  }));

  const { error } = await supabase.from('inflasi_upload_logs').insert(payload);
  if (error) {
    throw new Error(error.message || 'Gagal mencatat riwayat ke inflasi_upload_logs.');
  }
}

export async function fetchUploadLogsFromSupabase(
  period: PeriodSelection
): Promise<UpdateHistoryEntry[]> {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from('inflasi_upload_logs')
    .select('id,tahun,bulan,jenis_upload,nama_file,jumlah_baris,created_at')
    .eq('tahun', period.year)
    .eq('bulan', period.month)
    .order('created_at', { ascending: false })
    .limit(60);

  if (error) {
    throw new Error(error.message || 'Gagal memuat riwayat unggahan dari Supabase.');
  }

  return ((data ?? []) as RawSupabaseUploadLogRow[]).map((r, idx) => {
    const rawJenis = String(r.jenis_upload ?? '');
    const parts = rawJenis.split('·').map((s) => s.trim());
    const maybeRegion = parts.length >= 2 && isKabKotaCode(parts[0]) ? (parts[0] as KabKotaCode) : '6107';
    const maybeKind = (parts.length >= 2 ? parts[1] : parts[0]) as UpdateHistoryEntry['kind'];
    const validKinds: UpdateHistoryEntry['kind'][] = [
      'NK0',
      'NK_PREV',
      'RH_CURRENT',
      'INLINE_EDIT',
      'ROLLOVER',
      'RESPONDEN_SYNC',
    ];
    return {
      id: String(r.id ?? `sb-${idx}`),
      timestamp: r.created_at ?? new Date().toISOString(),
      regionCode: maybeRegion,
      period: { year: Number(r.tahun), month: Number(r.bulan) },
      kind: validKinds.includes(maybeKind) ? maybeKind : 'NK_PREV',
      fileName: r.nama_file,
      matchedCount: Number(r.jumlah_baris ?? 0),
      unmatchedCount: 0,
    };
  });
}

export async function rolloverPrevMonthFromSupabase(params: {
  targetPeriod: PeriodSelection;
  targetRegions: KabKotaCode[];
  currentInputs: Record<KabKotaCode, Record<string, CommodityInputRow>>;
  customNodes?: Record<string, HierarchyNodeMeta>;
}): Promise<{
  updatedRegions: Partial<Record<KabKotaCode, Record<string, CommodityInputRow>>>;
  totalRolledRows: number;
  prevPeriod: PeriodSelection;
  perRegionCounts: Partial<Record<KabKotaCode, number>>;
}> {
  if (!supabase) {
    throw new Error('Supabase belum terhubung. Aktifkan VITE_SUPABASE_URL dan VITE_SUPABASE_ANON_KEY.');
  }

  const prevMonth = params.targetPeriod.month === 1 ? 12 : params.targetPeriod.month - 1;
  const prevYear = params.targetPeriod.month === 1 ? params.targetPeriod.year - 1 : params.targetPeriod.year;
  const prevPeriod: PeriodSelection = { month: prevMonth, year: prevYear };

  const prevRows: RawSupabaseLKRow[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from('inflasi_lk_data')
      .select('tahun,bulan,kode_wilayah,nama_wilayah,kode_kelompok,kode_komoditas,nama_komoditas,bobot,nk_dasar,nk_n1,rh_n')
      .eq('tahun', prevYear)
      .eq('bulan', prevMonth)
      .in('kode_wilayah', params.targetRegions)
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) {
      throw new Error(error.message || 'Gagal mengambil data periode sebelumnya dari Supabase.');
    }

    const chunk = (data ?? []) as RawSupabaseLKRow[];
    prevRows.push(...chunk);
    if (chunk.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  if (prevRows.length === 0) {
    throw new Error(
      `Tidak ditemukan data inflasi_lk_data pada periode sebelumnya (${String(prevMonth).padStart(
        2,
        '0'
      )}/${prevYear}) untuk wilayah target.`
    );
  }

  const upsertPayload: SupabaseLKRow[] = [];
  const updatedRegions: Partial<Record<KabKotaCode, Record<string, CommodityInputRow>>> = {};
  const perRegionCounts: Partial<Record<KabKotaCode, number>> = {};

  for (const row of prevRows) {
    const regionCode = String(row.kode_wilayah ?? '').trim();
    if (!isKabKotaCode(regionCode)) continue;
    const kode = normalizeKode7(row.kode_komoditas);
    if (!kode) continue;

    const prevNk0 = Number(row.nk_dasar);
    const prevNkN1 = Number(row.nk_n1);
    const prevRhN = Number(row.rh_n);

    // Hitung NK(N) bulan lalu = NK(N-1) * (RH(N) / 100) sebagai nk_n1 periode aktif
    const safePrevNk0 = Number.isFinite(prevNk0) ? prevNk0 : 0;
    const safePrevNkN1 = Number.isFinite(prevNkN1) ? prevNkN1 : 0;
    const safePrevRh = Number.isFinite(prevRhN) && prevRhN > 0 ? prevRhN : 100;
    const nkCalculated = safePrevNkN1 * (safePrevRh / 100);

    const existingCurrent = params.currentInputs[regionCode]?.[kode];
    const preservedRh =
      existingCurrent && Number.isFinite(existingCurrent.rhCurrent) && existingCurrent.rhCurrent > 0
        ? existingCurrent.rhCurrent
        : 100;

    if (!updatedRegions[regionCode]) {
      updatedRegions[regionCode] = { ...(params.currentInputs[regionCode] ?? {}) };
    }
    updatedRegions[regionCode]![kode] = {
      kode,
      nk0: safePrevNk0,
      nkPrev: nkCalculated,
      rhCurrent: preservedRh,
    };

    perRegionCounts[regionCode] = (perRegionCounts[regionCode] ?? 0) + 1;

    const regionInfo = getRegionInfo(regionCode);
    const namaKomoditas =
      row.nama_komoditas ??
      params.customNodes?.[kode]?.nama ??
      DEFAULT_NODE_NAMES.get(kode) ??
      kode;

    upsertPayload.push({
      tahun: params.targetPeriod.year,
      bulan: params.targetPeriod.month,
      kode_wilayah: regionCode,
      nama_wilayah: row.nama_wilayah ?? regionInfo.name,
      kode_kelompok: row.kode_kelompok ?? kode.slice(0, 2),
      kode_komoditas: kode,
      nama_komoditas: namaKomoditas,
      bobot: Number(row.bobot ?? 0),
      nk_dasar: safePrevNk0,
      nk_n1: nkCalculated,
      rh_n: preservedRh,
    });
  }

  const savedCount = await upsertLKRowsBatchToSupabase(upsertPayload);

  const logEntries = Object.entries(perRegionCounts).map(([reg, count]) => ({
    regionCode: reg as KabKotaCode,
    period: params.targetPeriod,
    kind: 'ROLLOVER' as const,
    fileName: `Rollover NK ${String(prevMonth).padStart(2, '0')}/${prevYear} → NK (N-1)`,
    matchedCount: Number(count ?? 0),
    unmatchedCount: 0,
  }));

  await insertUploadLogsToSupabase(logEntries);

  return {
    updatedRegions,
    totalRolledRows: savedCount,
    prevPeriod,
    perRegionCounts,
  };
}

export async function saveRespondentDatasetToSupabase(
  dataset: RespondentRHDataset
): Promise<number> {
  if (!supabase) return 0;

  const dbFrekuensi = dataset.frequency.toLowerCase();

  // Bersihkan snapshot lama untuk kombinasi (tahun, bulan, kode_wilayah, frekuensi) sebelum upsert
  const { error: delError } = await supabase
    .from('inflasi_harga_responden')
    .delete()
    .eq('tahun', dataset.period.year)
    .eq('bulan', dataset.period.month)
    .eq('kode_wilayah', dataset.regionCode)
    .eq('frekuensi', dbFrekuensi);

  if (delError) {
    throw new Error(delError.message || 'Gagal memperbarui data lama di inflasi_harga_responden.');
  }

  if (dataset.observations.length === 0) return 0;

  const rows = dataset.observations.map((obs, idx) => ({
    tahun: dataset.period.year,
    bulan: dataset.period.month,
    kode_wilayah: dataset.regionCode,
    kode_komoditas: obs.kodeKomoditas,
    kode_responden: `${obs.kodeKualitas || '0'}#${idx + 1}`,
    nama_responden: obs.namaResponden || `Responden ${idx + 1}`,
    kualitas: obs.kualitas || '-',
    frekuensi: dbFrekuensi,
    harga_lalu: obs.prevAvgPrice ?? 0,
    harga_berjalan: obs.currAvgPrice ?? 0,
    rh_responden: obs.priceRelative ?? 100,
  }));

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from('inflasi_harga_responden')
      .upsert(chunk, { onConflict: 'tahun,bulan,kode_wilayah,kode_komoditas,kode_responden' });
    if (error) {
      throw new Error(error.message || 'Gagal menyimpan data ke inflasi_harga_responden.');
    }
  }

  return rows.length;
}

export async function fetchRespondentDatasetsFromSupabase(
  period: PeriodSelection,
  customNodes: Record<string, HierarchyNodeMeta> = {}
): Promise<Record<string, RespondentRHDataset>> {
  if (!supabase) return {};

  const allRows: RawSupabaseRespondentRow[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from('inflasi_harga_responden')
      .select(
        'id,tahun,bulan,kode_wilayah,kode_komoditas,kode_responden,nama_responden,kualitas,frekuensi,harga_lalu,harga_berjalan,rh_responden,updated_at'
      )
      .eq('tahun', period.year)
      .eq('bulan', period.month)
      .in('kode_wilayah', KAB_KOTA_CODES)
      .order('kode_wilayah', { ascending: true })
      .order('frekuensi', { ascending: true })
      .order('kode_komoditas', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) {
      throw new Error(error.message || 'Gagal memuat harga responden dari Supabase.');
    }

    const chunk = (data ?? []) as RawSupabaseRespondentRow[];
    allRows.push(...chunk);
    if (chunk.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  const grouped = new Map<
    string,
    {
      regionCode: KabKotaCode;
      frequency: RespondentFrequency;
      loadedAt: string | null;
      observations: RespondentPriceObservation[];
    }
  >();

  for (const row of allRows) {
    const regionCode = String(row.kode_wilayah ?? '').trim();
    if (!isKabKotaCode(regionCode)) continue;
    const freqUpper = String(row.frekuensi ?? '').toUpperCase();
    if (freqUpper !== 'MINGGUAN' && freqUpper !== 'DWIMINGGUAN' && freqUpper !== 'BULANAN') {
      continue;
    }
    const freq = freqUpper as RespondentFrequency;
    const scopedKey = `${regionCode}_${freq}`;

    if (!grouped.has(scopedKey)) {
      grouped.set(scopedKey, {
        regionCode,
        frequency: freq,
        loadedAt: row.updated_at ?? null,
        observations: [],
      });
    }

    const kode = normalizeKode7(row.kode_komoditas);
    const namaKomoditas =
      customNodes[kode]?.nama ?? DEFAULT_NODE_NAMES.get(kode) ?? kode;
    const prevAvg = row.harga_lalu !== null && Number(row.harga_lalu) > 0 ? Number(row.harga_lalu) : null;
    const currAvg =
      row.harga_berjalan !== null && Number(row.harga_berjalan) > 0 ? Number(row.harga_berjalan) : null;
    const rhVal = row.rh_responden !== null ? Number(row.rh_responden) : null;
    const kodeKualitas = String(row.kode_responden ?? '').split('#')[0] ?? '';

    const bucket = grouped.get(scopedKey)!;
    bucket.observations.push({
      id: `${regionCode}-${freq}-${row.id ?? row.kode_responden}`,
      kodeKomoditas: kode,
      komoditas: namaKomoditas,
      kodeKualitas,
      bobotKualitas: 0,
      kualitas: String(row.kualitas ?? ''),
      bobotJenisPasar: 0,
      jenisPasar: 'Umum',
      bobotPasar: 0,
      pasar: '-',
      namaResponden: String(row.nama_responden ?? ''),
      frequency: freq,
      prevPrices: [prevAvg],
      currPrices: [currAvg],
      prevAvgPrice: prevAvg,
      currAvgPrice: currAvg,
      priceRelative: rhVal,
    });
  }

  const datasets: Record<string, RespondentRHDataset> = {};
  for (const [scopedKey, bucket] of grouped.entries()) {
    datasets[scopedKey] = {
      regionCode: bucket.regionCode,
      period,
      frequency: bucket.frequency,
      fileName: 'Supabase (inflasi_harga_responden)',
      loadedAt: bucket.loadedAt,
      observations: bucket.observations,
      commoditySummaries: summarizeRespondentRH(bucket.observations, bucket.frequency),
    };
  }

  return datasets;
}

export function buildRegionUpsertRows(
  period: PeriodSelection,
  regionCode: KabKotaCode,
  regionInputs: Record<string, CommodityInputRow>,
  customNodes: Record<string, HierarchyNodeMeta> = {}
): SupabaseLKRow[] {
  const regionInfo = getRegionInfo(regionCode);
  const items = Object.values(regionInputs);
  const totalNk0 = items.reduce((acc, it) => acc + (Number.isFinite(it.nk0) ? it.nk0 : 0), 0);

  return items.map((item) => {
    const namaKomoditas =
      customNodes[item.kode]?.nama ?? DEFAULT_NODE_NAMES.get(item.kode) ?? item.kode;
    return {
      tahun: period.year,
      bulan: period.month,
      kode_wilayah: regionCode,
      nama_wilayah: regionInfo.name,
      kode_kelompok: item.kode.slice(0, 2),
      kode_komoditas: item.kode,
      nama_komoditas: namaKomoditas,
      bobot: totalNk0 > 0 ? (item.nk0 / totalNk0) * 100 : 0,
      nk_dasar: item.nk0,
      nk_n1: item.nkPrev,
      rh_n: item.rhCurrent,
    };
  });
}

export type SupabaseUploadLogKind = UploadFileKind | 'INLINE_EDIT' | 'ROLLOVER' | 'RESPONDEN_SYNC';
