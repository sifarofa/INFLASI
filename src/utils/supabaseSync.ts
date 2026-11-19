import { supabase } from '../lib/supabase';
import { KAB_KOTA_CODES } from '../data/regions';
import type {
  CommodityInputRow,
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
  kode_komoditas: string;
  nk0: number;
  nk_n1: number;
  rh_n: number;
}

interface RawSupabaseLKRow extends SupabaseLKRow {
  nama_komoditas?: string | null;
}

interface RawSupabaseUploadLogRow {
  id?: string | number;
  tahun: number;
  bulan: number;
  kode_wilayah: string;
  jenis_upload: string;
  nama_file: string;
  matched_count: number;
  unmatched_count: number;
  created_at?: string;
}

interface RawSupabaseRespondentRow {
  tahun: number;
  bulan: number;
  kode_wilayah: string;
  frekuensi: RespondentFrequency;
  obs_key: string;
  kode_komoditas: string;
  komoditas: string;
  kode_kualitas: string;
  bobot_kualitas: number;
  kualitas: string;
  bobot_jenis_pasar: number;
  jenis_pasar: string;
  bobot_pasar: number;
  pasar: string;
  nama_responden: string;
  prev_prices: (number | null)[];
  curr_prices: (number | null)[];
  prev_avg_price: number | null;
  curr_avg_price: number | null;
  price_relative: number | null;
  file_name: string | null;
  updated_at?: string;
}

const BATCH_SIZE = 500;
const PAGE_SIZE = 1000;
const KABKOTA_SET = new Set<string>(KAB_KOTA_CODES);

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
      .select('tahun,bulan,kode_wilayah,kode_komoditas,nk0,nk_n1,rh_n')
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

    const nk0 = Number(row.nk0);
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
 * Tarik Pakom & NK0 terbaru dari periode sebelumnya di Supabase bagi Kab/Kota
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
        .select('kode_komoditas,nk0')
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
        const nk0 = Number(r.nk0);
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

  // Deduplicate by composite conflict key to avoid PostgreSQL ON CONFLICT double-hit error
  const deduped = new Map<string, SupabaseLKRow>();
  for (const r of rows) {
    const key = `${r.tahun}|${r.bulan}|${r.kode_wilayah}|${r.kode_komoditas}`;
    deduped.set(key, {
      tahun: r.tahun,
      bulan: r.bulan,
      kode_wilayah: r.kode_wilayah,
      kode_komoditas: r.kode_komoditas,
      nk0: Number.isFinite(r.nk0) ? r.nk0 : 0,
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
    kode_wilayah: e.regionCode,
    jenis_upload: e.kind,
    nama_file: e.fileName,
    matched_count: e.matchedCount,
    unmatched_count: e.unmatchedCount,
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
    .select('id,tahun,bulan,kode_wilayah,jenis_upload,nama_file,matched_count,unmatched_count,created_at')
    .eq('tahun', period.year)
    .eq('bulan', period.month)
    .order('created_at', { ascending: false })
    .limit(60);

  if (error) {
    throw new Error(error.message || 'Gagal memuat riwayat unggahan dari Supabase.');
  }

  return ((data ?? []) as RawSupabaseUploadLogRow[])
    .filter((r) => isKabKotaCode(String(r.kode_wilayah ?? '')))
    .map((r, idx) => ({
      id: String(r.id ?? `sb-${idx}`),
      timestamp: r.created_at ?? new Date().toISOString(),
      regionCode: r.kode_wilayah as KabKotaCode,
      period: { year: Number(r.tahun), month: Number(r.bulan) },
      kind: (r.jenis_upload as UpdateHistoryEntry['kind']) ?? 'NK_PREV',
      fileName: r.nama_file,
      matchedCount: Number(r.matched_count ?? 0),
      unmatchedCount: Number(r.unmatched_count ?? 0),
    }));
}

export async function rolloverPrevMonthFromSupabase(params: {
  targetPeriod: PeriodSelection;
  targetRegions: KabKotaCode[];
  currentInputs: Record<KabKotaCode, Record<string, CommodityInputRow>>;
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
      .select('tahun,bulan,kode_wilayah,kode_komoditas,nk0,nk_n1,rh_n')
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

    const prevNk0 = Number(row.nk0);
    const prevNkN1 = Number(row.nk_n1);
    const prevRhN = Number(row.rh_n);

    // Hitung NK(N) bulan lalu = NK(N-1) * (RH(N) / 100) sebagai NK(N-1) periode aktif
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

    upsertPayload.push({
      tahun: params.targetPeriod.year,
      bulan: params.targetPeriod.month,
      kode_wilayah: regionCode,
      kode_komoditas: kode,
      nk0: safePrevNk0,
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

  // Bersihkan snapshot lama untuk kombinasi (tahun, bulan, kode_wilayah, frekuensi) sebelum upsert
  const { error: delError } = await supabase
    .from('inflasi_harga_responden')
    .delete()
    .eq('tahun', dataset.period.year)
    .eq('bulan', dataset.period.month)
    .eq('kode_wilayah', dataset.regionCode)
    .eq('frekuensi', dataset.frequency);

  if (delError) {
    throw new Error(delError.message || 'Gagal memperbarui data lama di inflasi_harga_responden.');
  }

  if (dataset.observations.length === 0) return 0;

  const rows = dataset.observations.map((obs, idx) => ({
    tahun: dataset.period.year,
    bulan: dataset.period.month,
    kode_wilayah: dataset.regionCode,
    frekuensi: dataset.frequency,
    obs_key: `${idx}_${obs.kodeKomoditas}_${obs.kodeKualitas || '0'}`,
    kode_komoditas: obs.kodeKomoditas,
    komoditas: obs.komoditas,
    kode_kualitas: obs.kodeKualitas,
    bobot_kualitas: Number.isFinite(obs.bobotKualitas) ? obs.bobotKualitas : 0,
    kualitas: obs.kualitas,
    bobot_jenis_pasar: Number.isFinite(obs.bobotJenisPasar) ? obs.bobotJenisPasar : 0,
    jenis_pasar: obs.jenisPasar,
    bobot_pasar: Number.isFinite(obs.bobotPasar) ? obs.bobotPasar : 0,
    pasar: obs.pasar,
    nama_responden: obs.namaResponden,
    prev_prices: obs.prevPrices,
    curr_prices: obs.currPrices,
    prev_avg_price: obs.prevAvgPrice,
    curr_avg_price: obs.currAvgPrice,
    price_relative: obs.priceRelative,
    file_name: dataset.fileName,
  }));

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from('inflasi_harga_responden')
      .upsert(chunk, { onConflict: 'tahun,bulan,kode_wilayah,frekuensi,obs_key' });
    if (error) {
      throw new Error(error.message || 'Gagal menyimpan data ke inflasi_harga_responden.');
    }
  }

  return rows.length;
}

export async function fetchRespondentDatasetsFromSupabase(
  period: PeriodSelection
): Promise<Record<string, RespondentRHDataset>> {
  if (!supabase) return {};

  const allRows: RawSupabaseRespondentRow[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from('inflasi_harga_responden')
      .select(
        'tahun,bulan,kode_wilayah,frekuensi,obs_key,kode_komoditas,komoditas,kode_kualitas,bobot_kualitas,kualitas,bobot_jenis_pasar,jenis_pasar,bobot_pasar,pasar,nama_responden,prev_prices,curr_prices,prev_avg_price,curr_avg_price,price_relative,file_name,updated_at'
      )
      .eq('tahun', period.year)
      .eq('bulan', period.month)
      .in('kode_wilayah', KAB_KOTA_CODES)
      .order('kode_wilayah', { ascending: true })
      .order('frekuensi', { ascending: true })
      .order('obs_key', { ascending: true })
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
      fileName: string | null;
      loadedAt: string | null;
      observations: RespondentPriceObservation[];
    }
  >();

  for (const row of allRows) {
    const regionCode = String(row.kode_wilayah ?? '').trim();
    if (!isKabKotaCode(regionCode)) continue;
    const freq = row.frekuensi;
    if (freq !== 'MINGGUAN' && freq !== 'DWIMINGGUAN' && freq !== 'BULANAN') continue;

    const scopedKey = `${regionCode}_${freq}`;
    if (!grouped.has(scopedKey)) {
      grouped.set(scopedKey, {
        regionCode,
        frequency: freq,
        fileName: row.file_name ?? null,
        loadedAt: row.updated_at ?? null,
        observations: [],
      });
    }

    const bucket = grouped.get(scopedKey)!;
    bucket.observations.push({
      id: `${regionCode}-${freq}-${row.obs_key}`,
      kodeKomoditas: normalizeKode7(row.kode_komoditas),
      komoditas: String(row.komoditas ?? ''),
      kodeKualitas: String(row.kode_kualitas ?? ''),
      bobotKualitas: Number(row.bobot_kualitas ?? 0),
      kualitas: String(row.kualitas ?? ''),
      bobotJenisPasar: Number(row.bobot_jenis_pasar ?? 0),
      jenisPasar: String(row.jenis_pasar ?? ''),
      bobotPasar: Number(row.bobot_pasar ?? 0),
      pasar: String(row.pasar ?? ''),
      namaResponden: String(row.nama_responden ?? ''),
      frequency: freq,
      prevPrices: Array.isArray(row.prev_prices) ? row.prev_prices : [],
      currPrices: Array.isArray(row.curr_prices) ? row.curr_prices : [],
      prevAvgPrice: row.prev_avg_price !== null ? Number(row.prev_avg_price) : null,
      currAvgPrice: row.curr_avg_price !== null ? Number(row.curr_avg_price) : null,
      priceRelative: row.price_relative !== null ? Number(row.price_relative) : null,
    });
  }

  const datasets: Record<string, RespondentRHDataset> = {};
  for (const [scopedKey, bucket] of grouped.entries()) {
    datasets[scopedKey] = {
      regionCode: bucket.regionCode,
      period,
      frequency: bucket.frequency,
      fileName: bucket.fileName,
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
  regionInputs: Record<string, CommodityInputRow>
): SupabaseLKRow[] {
  return Object.values(regionInputs).map((item) => ({
    tahun: period.year,
    bulan: period.month,
    kode_wilayah: regionCode,
    kode_komoditas: item.kode,
    nk0: item.nk0,
    nk_n1: item.nkPrev,
    rh_n: item.rhCurrent,
  }));
}

export type SupabaseUploadLogKind = UploadFileKind | 'INLINE_EDIT' | 'ROLLOVER' | 'RESPONDEN_SYNC';
