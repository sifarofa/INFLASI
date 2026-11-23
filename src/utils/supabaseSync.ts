import { supabase } from '../lib/supabase';
import { getRegionInfo, KAB_KOTA_CODES } from '../data/regions';
import { HIERARCHY_NODES } from '../data/masterHierarchy';
import type {
  AngkaSementaraDataset,
  AngkaSementaraRegionLevel,
  AngkaSementaraRow,
  CommodityInputRow,
  HierarchyFlag,
  HierarchyNodeMeta,
  KabKotaCode,
  KalbarFlagType,
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
    .not('jenis_upload', 'like', 'ANGKA_SEMENTARA%')
    .not('jenis_upload', 'like', 'RESP_SNAPSHOT%')
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

const RESP_SNAPSHOT_META_PREFIX = 'RESP_SNAPSHOT_META|';
const RESP_SNAPSHOT_CHUNK_PREFIX = 'RESP_SNAPSHOT_CHUNK|';

interface RespondentSnapshotMeta {
  regionCode: KabKotaCode;
  frequency: RespondentFrequency;
  tahun: number;
  bulan: number;
  fileName: string | null;
  loadedAt: string | null;
  rowCount: number;
  encoding: 'gzip-v1' | 'plain-v1';
}

function padPricesForFrequency(
  avgPrice: number | null,
  freq: RespondentFrequency
): (number | null)[] {
  const expectedLen = freq === 'MINGGUAN' ? 5 : freq === 'DWIMINGGUAN' ? 2 : 1;
  const arr: (number | null)[] = new Array(expectedLen).fill(null);
  arr[0] = avgPrice;
  return arr;
}

export async function saveRespondentSnapshotToSupabase(
  dataset: RespondentRHDataset
): Promise<void> {
  if (!supabase) return;

  const { year, month } = dataset.period;
  const payloadText = JSON.stringify({
    v: 1,
    observations: dataset.observations,
  });
  const { encoding, payload } = await compressTextForSupabase(payloadText);

  const chunks: string[] = [];
  for (let i = 0; i < payload.length; i += ANGKA_SEMENTARA_CHUNK_CHARS) {
    chunks.push(payload.slice(i, i + ANGKA_SEMENTARA_CHUNK_CHARS));
  }
  if (chunks.length === 0) chunks.push('');

  const batchId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  for (let i = 0; i < chunks.length; i++) {
    const { error: chunkErr } = await supabase.from('inflasi_upload_logs').insert({
      tahun: year,
      bulan: month,
      jenis_upload: `${RESP_SNAPSHOT_CHUNK_PREFIX}${batchId}|${i}|${chunks.length}`,
      nama_file: chunks[i],
      jumlah_baris: chunks[i].length,
    });
    if (chunkErr) {
      throw new Error(chunkErr.message || `Gagal menyimpan potongan snapshot responden #${i + 1}.`);
    }
  }

  const meta: RespondentSnapshotMeta = {
    regionCode: dataset.regionCode,
    frequency: dataset.frequency,
    tahun: year,
    bulan: month,
    fileName: dataset.fileName,
    loadedAt: dataset.loadedAt,
    rowCount: dataset.observations.length,
    encoding,
  };

  const metaPrefix = `${RESP_SNAPSHOT_META_PREFIX}${year}|${month}|${dataset.regionCode}|${dataset.frequency}|`;
  const { error: metaErr } = await supabase.from('inflasi_upload_logs').insert({
    tahun: year,
    bulan: month,
    jenis_upload: `${metaPrefix}${batchId}|${chunks.length}`,
    nama_file: JSON.stringify(meta),
    jumlah_baris: dataset.observations.length,
  });

  if (metaErr) {
    throw new Error(metaErr.message || 'Gagal menyimpan metadata snapshot responden ke Supabase.');
  }

  // Bersihkan snapshot META lama untuk kombinasi (tahun, bulan, wilayah, frekuensi) secara best-effort
  try {
    const { data: oldMetas } = await supabase
      .from('inflasi_upload_logs')
      .select('id,jenis_upload')
      .eq('tahun', year)
      .eq('bulan', month)
      .like('jenis_upload', `${metaPrefix}%`);

    for (const oldRow of oldMetas ?? []) {
      const j = String(oldRow.jenis_upload ?? '');
      if (j.includes(`|${batchId}|`)) continue;
      const parts = j.split('|');
      const oldBatchId = parts[5];
      if (oldBatchId) {
        await supabase
          .from('inflasi_upload_logs')
          .delete()
          .like('jenis_upload', `${RESP_SNAPSHOT_CHUNK_PREFIX}${oldBatchId}|%`);
      }
      if (oldRow.id) {
        await supabase.from('inflasi_upload_logs').delete().eq('id', oldRow.id);
      }
    }
  } catch {
    // Abaikan jika RLS tidak mengizinkan DELETE
  }
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

  // Simpan juga snapshot lossless (rincian M1-M5, pasar, bobot BPS, catatan & perbaikan)
  await saveRespondentSnapshotToSupabase(dataset);

  return rows.length;
}

export async function fetchRespondentDatasetsFromSupabase(
  period: PeriodSelection,
  customNodes: Record<string, HierarchyNodeMeta> = {}
): Promise<Record<string, RespondentRHDataset>> {
  if (!supabase) return {};

  const datasets: Record<string, RespondentRHDataset> = {};

  // 1. Prioritaskan snapshot lossless (memuat M1-M5, Pasar, Bobot BPS, Catatan, Perbaikan Harga)
  try {
    const { data: metaRows } = await supabase
      .from('inflasi_upload_logs')
      .select('id,tahun,bulan,jenis_upload,nama_file,created_at')
      .eq('tahun', period.year)
      .eq('bulan', period.month)
      .like('jenis_upload', `${RESP_SNAPSHOT_META_PREFIX}${period.year}|${period.month}|%`)
      .order('created_at', { ascending: false })
      .limit(60);

    const seenKeys = new Set<string>();
    for (const metaRow of (metaRows ?? []) as RawSupabaseUploadLogRow[]) {
      const parts = String(metaRow.jenis_upload ?? '').split('|');
      const regionCode = parts[3] ?? '';
      const freqUpper = parts[4] ?? '';
      const batchId = parts[5] ?? '';
      const totalChunks = Number(parts[6] ?? 0);
      if (
        !isKabKotaCode(regionCode) ||
        (freqUpper !== 'MINGGUAN' && freqUpper !== 'DWIMINGGUAN' && freqUpper !== 'BULANAN') ||
        !batchId ||
        !Number.isFinite(totalChunks) ||
        totalChunks <= 0
      ) {
        continue;
      }

      const scopedKey = `${regionCode}_${freqUpper}`;
      if (seenKeys.has(scopedKey)) continue;

      let meta: RespondentSnapshotMeta;
      try {
        meta = JSON.parse(String(metaRow.nama_file ?? '{}')) as RespondentSnapshotMeta;
      } catch {
        continue;
      }

      const chunkStrings: string[] = [];
      let missing = false;
      for (let i = 0; i < totalChunks; i++) {
        const expectedJenis = `${RESP_SNAPSHOT_CHUNK_PREFIX}${batchId}|${i}|${totalChunks}`;
        const { data: chunkData, error: chunkErr } = await supabase
          .from('inflasi_upload_logs')
          .select('nama_file')
          .eq('jenis_upload', expectedJenis)
          .limit(1);
        if (chunkErr || !chunkData || chunkData.length === 0) {
          missing = true;
          break;
        }
        chunkStrings.push(String(chunkData[0].nama_file ?? ''));
      }
      if (missing) continue;

      try {
        const jsonText = await decompressTextFromSupabase(
          chunkStrings.join(''),
          meta.encoding ?? 'plain-v1'
        );
        const parsed = JSON.parse(jsonText) as {
          v: number;
          observations: RespondentPriceObservation[];
        };
        if (Array.isArray(parsed.observations)) {
          const freq = freqUpper as RespondentFrequency;
          datasets[scopedKey] = {
            regionCode,
            period,
            frequency: freq,
            fileName: meta.fileName ?? 'Supabase Snapshot',
            loadedAt: meta.loadedAt ?? metaRow.created_at ?? null,
            observations: parsed.observations,
            commoditySummaries: summarizeRespondentRH(parsed.observations, freq),
          };
          seenKeys.add(scopedKey);
        }
      } catch {
        // Lewati jika snapshot korup, fallback ke inflasi_harga_responden di bawah
      }
    }
  } catch {
    // Fallback tetap berjalan melalui inflasi_harga_responden
  }

  // 2. Fallback dari tabel inflasi_harga_responden untuk dataset yang belum memiliki snapshot lossless
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
    if (datasets[scopedKey]) continue;

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
      prevPrices: padPricesForFrequency(prevAvg, freq),
      currPrices: padPricesForFrequency(currAvg, freq),
      prevAvgPrice: prevAvg,
      currAvgPrice: currAvg,
      priceRelative: rhVal,
    });
  }

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

// ============================================================================
// SINKRONISASI DATASET RANKING INFLASI (ANGKA SEMENTARA) VIA SUPABASE
// ============================================================================

const ANGKA_SEMENTARA_CHUNK_CHARS = 320_000;
const ANGKA_META_PREFIX = 'ANGKA_SEMENTARA_META|';
const ANGKA_CHUNK_PREFIX = 'ANGKA_SEMENTARA_CHUNK|';
const ANGKA_CLEAR_PREFIX = 'ANGKA_SEMENTARA_CLEAR|';

interface CompactAngkaSementaraPayload {
  v: 1;
  regions: Array<[string, string, AngkaSementaraRegionLevel, KalbarFlagType]>;
  commodities: Array<[string, string, string, HierarchyFlag]>;
  rows: Array<
    [number, number, number, number, number, number, number, number, number, number, number]
  >;
}

interface AngkaSementaraMetaPayload {
  fileName: string;
  uploadedAt: string;
  title: string;
  tahun: number | null;
  bulan: number | null;
  rowCount: number;
  encoding: 'gzip-v1' | 'plain-v1';
}

function uint8ToBase64(bytes: Uint8Array): string {
  const SLICE = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += SLICE) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + SLICE)));
  }
  return btoa(parts.join(''));
}

function base64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

async function compressTextForSupabase(
  text: string
): Promise<{ encoding: 'gzip-v1' | 'plain-v1'; payload: string }> {
  if (typeof CompressionStream !== 'undefined') {
    try {
      const encoded = new TextEncoder().encode(text);
      const copy = new Uint8Array(encoded.length);
      copy.set(encoded);
      const stream = new Blob([copy.buffer]).stream().pipeThrough(new CompressionStream('gzip'));
      const buf = await new Response(stream).arrayBuffer();
      return { encoding: 'gzip-v1', payload: uint8ToBase64(new Uint8Array(buf)) };
    } catch {
      // Fallback to plain JSON string
    }
  }
  return { encoding: 'plain-v1', payload: text };
}

async function decompressTextFromSupabase(
  payload: string,
  encoding: 'gzip-v1' | 'plain-v1'
): Promise<string> {
  if (encoding === 'gzip-v1') {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('Browser tidak mendukung DecompressionStream untuk membuka dataset Angka Sementara.');
    }
    const bytes = base64ToUint8(payload);
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    const stream = new Blob([copy.buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
    return await new Response(stream).text();
  }
  return payload;
}

function encodeAngkaSementaraDataset(dataset: AngkaSementaraDataset): CompactAngkaSementaraPayload {
  const regionMap = new Map<string, number>();
  const commMap = new Map<string, number>();
  const regions: CompactAngkaSementaraPayload['regions'] = [];
  const commodities: CompactAngkaSementaraPayload['commodities'] = [];
  const rows: CompactAngkaSementaraPayload['rows'] = [];

  for (const r of dataset.rows) {
    const rKey = `${r.kdKota}|${r.namaKota}|${r.regionLevel}|${r.kalbarFlag}`;
    let rIdx = regionMap.get(rKey);
    if (rIdx === undefined) {
      rIdx = regions.length;
      regionMap.set(rKey, rIdx);
      regions.push([r.kdKota, r.namaKota, r.regionLevel, r.kalbarFlag]);
    }

    const cKey = `${r.flag}|${r.kode}|${r.rawKode}|${r.nama}`;
    let cIdx = commMap.get(cKey);
    if (cIdx === undefined) {
      cIdx = commodities.length;
      commMap.set(cKey, cIdx);
      commodities.push([r.kode, r.rawKode, r.nama, r.flag]);
    }

    rows.push([
      rIdx,
      cIdx,
      r.tahun,
      r.bulan,
      r.ihk,
      r.infMom,
      r.infYtd,
      r.infYoy,
      r.andilMom,
      r.andilYtd,
      r.andilYoy,
    ]);
  }

  return { v: 1, regions, commodities, rows };
}

function decodeAngkaSementaraDataset(
  meta: AngkaSementaraMetaPayload,
  compact: CompactAngkaSementaraPayload
): AngkaSementaraDataset {
  const rows: AngkaSementaraRow[] = compact.rows.map((tuple) => {
    const reg = compact.regions[tuple[0]];
    const comm = compact.commodities[tuple[1]];
    return {
      tahun: tuple[2],
      bulan: tuple[3],
      kdKota: reg?.[0] ?? '',
      namaKota: reg?.[1] ?? '',
      kode: comm?.[0] ?? '',
      rawKode: comm?.[1] ?? '',
      nama: comm?.[2] ?? '',
      flag: (comm?.[3] ?? 3) as HierarchyFlag,
      ihk: tuple[4],
      infMom: tuple[5],
      infYtd: tuple[6],
      infYoy: tuple[7],
      andilMom: tuple[8],
      andilYtd: tuple[9],
      andilYoy: tuple[10],
      regionLevel: reg?.[2] ?? 'KABKOTA',
      kalbarFlag: reg?.[3] ?? 'NON_KALBAR',
    };
  });

  return {
    fileName: meta.fileName,
    uploadedAt: meta.uploadedAt,
    title: meta.title,
    tahun: meta.tahun,
    bulan: meta.bulan,
    rows,
  };
}

function resolveLogPeriod(tahun: number | null, bulan: number | null): { tahun: number; bulan: number } {
  const now = new Date();
  const safeTahun =
    tahun && Number.isFinite(tahun) && tahun >= 2000 && tahun <= 2100
      ? Math.trunc(tahun)
      : now.getFullYear();
  const safeBulan =
    bulan && Number.isFinite(bulan) && bulan >= 1 && bulan <= 12
      ? Math.trunc(bulan)
      : now.getMonth() + 1;
  return { tahun: safeTahun, bulan: safeBulan };
}

export async function saveAngkaSementaraToSupabase(
  dataset: AngkaSementaraDataset
): Promise<{ totalChunks: number; rowCount: number }> {
  if (!supabase) {
    throw new Error('Supabase belum terhubung.');
  }

  const compact = encodeAngkaSementaraDataset(dataset);
  const compactJson = JSON.stringify(compact);
  const { encoding, payload } = await compressTextForSupabase(compactJson);

  const chunks: string[] = [];
  for (let i = 0; i < payload.length; i += ANGKA_SEMENTARA_CHUNK_CHARS) {
    chunks.push(payload.slice(i, i + ANGKA_SEMENTARA_CHUNK_CHARS));
  }
  if (chunks.length === 0) chunks.push('');

  const batchId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { tahun, bulan } = resolveLogPeriod(dataset.tahun, dataset.bulan);

  // 1. Upload semua chunk terlebih dahulu agar batch bersifat atomik sebelum META muncul
  for (let i = 0; i < chunks.length; i++) {
    const { error: chunkErr } = await supabase.from('inflasi_upload_logs').insert({
      tahun,
      bulan,
      jenis_upload: `${ANGKA_CHUNK_PREFIX}${batchId}|${i}|${chunks.length}`,
      nama_file: chunks[i],
      jumlah_baris: chunks[i].length,
    });
    if (chunkErr) {
      throw new Error(chunkErr.message || `Gagal menyimpan potongan data #${i + 1} ke Supabase.`);
    }
  }

  // 2. Simpan row META terakhir sebagai penanda bahwa seluruh chunk sudah siap dibaca device lain
  const metaPayload: AngkaSementaraMetaPayload = {
    fileName: dataset.fileName,
    uploadedAt: dataset.uploadedAt,
    title: dataset.title,
    tahun: dataset.tahun,
    bulan: dataset.bulan,
    rowCount: dataset.rows.length,
    encoding,
  };

  const { error: metaErr } = await supabase.from('inflasi_upload_logs').insert({
    tahun,
    bulan,
    jenis_upload: `${ANGKA_META_PREFIX}${batchId}|${chunks.length}`,
    nama_file: JSON.stringify(metaPayload),
    jumlah_baris: dataset.rows.length,
  });

  if (metaErr) {
    throw new Error(metaErr.message || 'Gagal menyimpan metadata Ranking Inflasi ke Supabase.');
  }

  // 3. Bersihkan snapshot ANGKA_SEMENTARA lama secara best-effort agar tabel tetap ringkas
  try {
    await supabase
      .from('inflasi_upload_logs')
      .delete()
      .like('jenis_upload', 'ANGKA_SEMENTARA_%')
      .not('jenis_upload', 'like', `%${batchId}%`);
  } catch {
    // Abaikan jika kebijakan RLS hanya mengizinkan SELECT/INSERT
  }

  return { totalChunks: chunks.length, rowCount: dataset.rows.length };
}

export type FetchAngkaSementaraResult =
  | { status: 'EMPTY' }
  | { status: 'CLEARED'; clearedAt: string }
  | { status: 'FOUND'; dataset: AngkaSementaraDataset; syncedAt: string };

export async function fetchAngkaSementaraFromSupabase(): Promise<FetchAngkaSementaraResult> {
  if (!supabase) return { status: 'EMPTY' };

  const { data: metaRows, error: metaErr } = await supabase
    .from('inflasi_upload_logs')
    .select('id,tahun,bulan,jenis_upload,nama_file,jumlah_baris,created_at')
    .or(`jenis_upload.like.${ANGKA_META_PREFIX}%,jenis_upload.like.${ANGKA_CLEAR_PREFIX}%`)
    .order('created_at', { ascending: false })
    .limit(5);

  if (metaErr) {
    throw new Error(metaErr.message || 'Gagal memeriksa data Ranking Inflasi di Supabase.');
  }

  if (!metaRows || metaRows.length === 0) {
    return { status: 'EMPTY' };
  }

  for (const candidate of metaRows as RawSupabaseUploadLogRow[]) {
    const jenis = String(candidate.jenis_upload ?? '');
    if (jenis.startsWith(ANGKA_CLEAR_PREFIX)) {
      return {
        status: 'CLEARED',
        clearedAt: candidate.created_at ?? new Date().toISOString(),
      };
    }

    if (!jenis.startsWith(ANGKA_META_PREFIX)) continue;

    const parts = jenis.split('|');
    const batchId = parts[1];
    const totalChunks = Number(parts[2] ?? 0);
    if (!batchId || !Number.isFinite(totalChunks) || totalChunks <= 0) continue;

    let meta: AngkaSementaraMetaPayload;
    try {
      meta = JSON.parse(String(candidate.nama_file ?? '{}')) as AngkaSementaraMetaPayload;
    } catch {
      continue;
    }

    const chunkStrings: string[] = [];
    let missingChunk = false;
    for (let i = 0; i < totalChunks; i++) {
      const expectedJenis = `${ANGKA_CHUNK_PREFIX}${batchId}|${i}|${totalChunks}`;
      const { data: chunkData, error: chunkErr } = await supabase
        .from('inflasi_upload_logs')
        .select('nama_file')
        .eq('jenis_upload', expectedJenis)
        .limit(1);

      if (chunkErr || !chunkData || chunkData.length === 0) {
        missingChunk = true;
        break;
      }
      chunkStrings.push(String(chunkData[0].nama_file ?? ''));
    }

    if (missingChunk) continue;

    const joined = chunkStrings.join('');
    const jsonText = await decompressTextFromSupabase(joined, meta.encoding ?? 'plain-v1');
    const compact = JSON.parse(jsonText) as CompactAngkaSementaraPayload;
    const dataset = decodeAngkaSementaraDataset(meta, compact);

    return {
      status: 'FOUND',
      dataset,
      syncedAt: candidate.created_at ?? meta.uploadedAt ?? new Date().toISOString(),
    };
  }

  return { status: 'EMPTY' };
}

export async function clearAngkaSementaraInSupabase(): Promise<void> {
  if (!supabase) return;

  const batchId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date();

  try {
    await supabase
      .from('inflasi_upload_logs')
      .delete()
      .like('jenis_upload', 'ANGKA_SEMENTARA_%');
  } catch {
    // Abaikan jika DELETE dibatasi RLS; marker CLEAR tetap menandai status terbaru
  }

  const { error } = await supabase.from('inflasi_upload_logs').insert({
    tahun: now.getFullYear(),
    bulan: now.getMonth() + 1,
    jenis_upload: `${ANGKA_CLEAR_PREFIX}${batchId}`,
    nama_file: JSON.stringify({ clearedAt: now.toISOString() }),
    jumlah_baris: 0,
  });

  if (error) {
    throw new Error(error.message || 'Gagal menghapus snapshot Ranking Inflasi di Supabase.');
  }
}

