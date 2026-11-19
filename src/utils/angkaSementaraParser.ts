import * as XLSX from 'xlsx';
import type {
  AngkaSementaraDataset,
  AngkaSementaraRegionLevel,
  AngkaSementaraRow,
  HierarchyFlag,
  KalbarFlagType,
} from '../types/inflasi';
import { parseFlexibleNumber } from './excelParser';

export interface CommodityCatalogItem {
  kode: string;
  nama: string;
  flag: HierarchyFlag;
  regionCount: number;
  kalbarCount: number;
}

export interface AngkaSementaraRankedRow extends AngkaSementaraRow {
  rankInScope: number;
  totalInScope: number;
  rankInAll: number;
  totalInAll: number;
}

export interface AngkaSementaraIndex {
  provCount: number;
  kabKotaCount: number;
  totalRegions: number;
  kalbarRegions: Array<{
    kdKota: string;
    namaKota: string;
    regionLevel: AngkaSementaraRegionLevel;
    kalbarFlag: KalbarFlagType;
  }>;
  catalog: CommodityCatalogItem[];
  byCommodity: Map<string, AngkaSementaraRow[]>;
  /** Key: `${kdKota}|${flag}|${kode}` -> rank within same regionLevel (1 = highest INF(MOM)) */
  rankInLevelMap: Map<string, { rank: number; total: number }>;
  /** Key: `${kdKota}|${flag}|${kode}` -> rank across all 188 regions (1 = highest INF(MOM)) */
  rankInAllMap: Map<string, { rank: number; total: number }>;
}

const KALBAR_KABKOTA_CODES = new Set(['6106', '6107', '6111', '6171', '6172']);

export function normalizeKodeByFlag(rawKode: string, flag: HierarchyFlag): string {
  const cleaned = String(rawKode ?? '').trim().replace(/\.0+$/, '');
  if (flag === 0 || cleaned === '0') return '0';
  if (/^\d+$/.test(cleaned)) {
    if (flag === 1) return cleaned.padStart(2, '0');
    if (flag === 2) return cleaned.padStart(3, '0');
    if (flag === 3) return cleaned.padStart(7, '0');
  }
  return cleaned;
}

export function classifyRegion(
  rawKdKota: string,
  namaKota: string
): { kdKota: string; regionLevel: AngkaSementaraRegionLevel; kalbarFlag: KalbarFlagType } {
  const kdKota = String(rawKdKota ?? '').trim().replace(/\.0+$/, '');
  const upperNama = namaKota.toUpperCase();

  const isProv =
    kdKota.length <= 2 ||
    kdKota === '6100' ||
    upperNama.startsWith('PROV ') ||
    upperNama.startsWith('PROV.');

  const regionLevel: AngkaSementaraRegionLevel = isProv ? 'PROVINSI' : 'KABKOTA';

  let kalbarFlag: KalbarFlagType = 'NON_KALBAR';
  if (
    kdKota === '61' ||
    kdKota === '6100' ||
    (isProv && upperNama.includes('KALIMANTAN BARAT'))
  ) {
    kalbarFlag = 'PROV_KALBAR';
  } else if (
    KALBAR_KABKOTA_CODES.has(kdKota) ||
    (!isProv && kdKota.startsWith('61') && kdKota.length === 4)
  ) {
    kalbarFlag = 'KABKOTA_KALBAR';
  }

  return { kdKota, regionLevel, kalbarFlag };
}

function splitDelimitedLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

/**
 * Handles standard comma/semicolon/tab CSV as well as quoted-tab lines exported by some BPS tools
 * (e.g. "2026\t10\t61\tPROV KALIMANTAN BARAT\t1\t""MAKANAN""," MINUMAN""\t...").
 */
function parseCsvTextToMatrix(rawText: string): string[][] {
  const cleanText = rawText.replace(/^\uFEFF/, '');
  const lines = cleanText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];

  const sample = lines.slice(0, Math.min(lines.length, 15));
  const hasTabs = sample.some((l) => l.includes('\t'));

  if (hasTabs) {
    return lines.map((line) => {
      let normalized = line.trim();
      if (normalized.startsWith('"') && normalized.includes('\t')) {
        // Strip trailing commas outside quotes (e.g. `"...data...",`)
        const withoutTrailingComma = normalized.replace(/,+$/, '').trim();
        if (withoutTrailingComma.startsWith('"') && withoutTrailingComma.endsWith('"')) {
          normalized = withoutTrailingComma.slice(1, -1).replace(/""/g, '"');
        }
      }
      return normalized.split('\t').map((cell) => {
        const trimmed = cell.trim();
        return trimmed
          .replace(/^"+|"+$/g, '')
          .replace(/""/g, '"')
          .replace(/",\s*"/g, ', ')
          .trim();
      });
    });
  }

  const sampleJoined = sample.join('\n');
  const semiCount = (sampleJoined.match(/;/g) || []).length;
  const commaCount = (sampleJoined.match(/,/g) || []).length;
  const delimiter = semiCount > commaCount ? ';' : ',';

  return lines.map((line) => splitDelimitedLine(line, delimiter));
}

async function readAngkaSementaraMatrix(fileOrText: File | string, fileName: string): Promise<unknown[][]> {
  if (typeof fileOrText === 'string') {
    return parseCsvTextToMatrix(fileOrText);
  }
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.csv') || lower.endsWith('.tsv') || lower.endsWith('.txt')) {
    const text = await fileOrText.text();
    return parseCsvTextToMatrix(text);
  }
  const buffer = await fileOrText.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });
  const firstSheet = workbook.SheetNames[0];
  if (!firstSheet) return [];
  const sheet = workbook.Sheets[firstSheet];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }) as unknown[][];
}

function normalizeHeaderCell(val: unknown): string {
  return String(val ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export async function parseAngkaSementaraFile(
  fileOrText: File | string,
  fileName: string
): Promise<AngkaSementaraDataset> {
  const matrix = await readAngkaSementaraMatrix(fileOrText, fileName);
  if (matrix.length === 0) {
    throw new Error('File kosong atau tidak dapat dibaca.');
  }

  let headerIdx = -1;
  let colMap = {
    tahun: -1,
    bulan: -1,
    kdKota: -1,
    namaKota: -1,
    kode: -1,
    nama: -1,
    flag: -1,
    ihk: -1,
    infMom: -1,
    infYtd: -1,
    infYoy: -1,
    andilMom: -1,
    andilYtd: -1,
    andilYoy: -1,
  };

  for (let i = 0; i < Math.min(matrix.length, 20); i++) {
    const row = matrix[i].map(normalizeHeaderCell);
    const kdKotaIdx = row.findIndex(
      (h) => h === 'kd.kota' || h === 'kd kota' || h === 'kdkota' || h === 'kode kota'
    );
    const namaKotaIdx = row.findIndex(
      (h) => h === 'nama kota' || h === 'namakota' || h === 'wilayah'
    );
    const kodeIdx = row.findIndex((h) => h === 'kode' || h === 'kode komoditas');
    const namaIdx = row.findIndex((h) => h === 'nama' || h === 'nama komoditas');
    const infMomIdx = row.findIndex((h) => h === 'inf(mom)' || h === 'inf mom' || h === 'inflasi mom');

    if (kdKotaIdx !== -1 && kodeIdx !== -1 && infMomIdx !== -1) {
      headerIdx = i;
      colMap = {
        tahun: row.findIndex((h) => h === 'tahun'),
        bulan: row.findIndex((h) => h === 'bulan'),
        kdKota: kdKotaIdx,
        namaKota: namaKotaIdx,
        kode: kodeIdx,
        nama: namaIdx,
        flag: row.findIndex((h) => h === 'flag'),
        ihk: row.findIndex((h) => h === 'ihk'),
        infMom: infMomIdx,
        infYtd: row.findIndex((h) => h === 'inf(ytd)' || h === 'inf ytd'),
        infYoy: row.findIndex((h) => h === 'inf(yoy)' || h === 'inf yoy'),
        andilMom: row.findIndex((h) => h === 'andil(mom)' || h === 'andil mom'),
        andilYtd: row.findIndex((h) => h === 'andil(ytd)' || h === 'andil ytd'),
        andilYoy: row.findIndex((h) => h === 'andil(yoy)' || h === 'andil yoy'),
      };
      break;
    }
  }

  if (headerIdx === -1) {
    throw new Error(
      'Header template Angka Sementara ("Kd.Kota", "Kode", "INF(MOM)") tidak ditemukan pada file.'
    );
  }

  let title = '';
  for (let i = 0; i < headerIdx; i++) {
    const candidate = String(matrix[i]?.[0] ?? '')
      .replace(/^"+|"+$/g, '')
      .trim();
    if (candidate) {
      title = candidate;
      break;
    }
  }

  const rows: AngkaSementaraRow[] = [];
  let detectedTahun: number | null = null;
  let detectedBulan: number | null = null;

  for (let r = headerIdx + 1; r < matrix.length; r++) {
    const cells = matrix[r];
    if (!cells || cells.length === 0) continue;

    const rawKdKota = String(cells[colMap.kdKota] ?? '').trim();
    const rawKode = String(cells[colMap.kode] ?? '').trim();
    if (!rawKdKota || !rawKode) continue;

    const namaKota = colMap.namaKota >= 0 ? String(cells[colMap.namaKota] ?? '').trim() : rawKdKota;
    const nama = colMap.nama >= 0 ? String(cells[colMap.nama] ?? '').trim() : rawKode;
    const flagNum = colMap.flag >= 0 ? parseFlexibleNumber(cells[colMap.flag]) : null;
    const flag: HierarchyFlag =
      flagNum === 0 || flagNum === 1 || flagNum === 2 || flagNum === 3
        ? flagNum
        : rawKode === '0'
          ? 0
          : rawKode.length <= 2
            ? 1
            : rawKode.length === 3
              ? 2
              : 3;

    const infMom = parseFlexibleNumber(cells[colMap.infMom]);
    if (infMom === null) continue;

    const tahun = (colMap.tahun >= 0 ? parseFlexibleNumber(cells[colMap.tahun]) : null) ?? 0;
    const bulan = (colMap.bulan >= 0 ? parseFlexibleNumber(cells[colMap.bulan]) : null) ?? 0;
    if (!detectedTahun && tahun > 0) detectedTahun = tahun;
    if (!detectedBulan && bulan > 0) detectedBulan = bulan;

    const ihk = (colMap.ihk >= 0 ? parseFlexibleNumber(cells[colMap.ihk]) : null) ?? 0;
    const infYtd = (colMap.infYtd >= 0 ? parseFlexibleNumber(cells[colMap.infYtd]) : null) ?? 0;
    const infYoy = (colMap.infYoy >= 0 ? parseFlexibleNumber(cells[colMap.infYoy]) : null) ?? 0;
    const andilMom = (colMap.andilMom >= 0 ? parseFlexibleNumber(cells[colMap.andilMom]) : null) ?? 0;
    const andilYtd = (colMap.andilYtd >= 0 ? parseFlexibleNumber(cells[colMap.andilYtd]) : null) ?? 0;
    const andilYoy = (colMap.andilYoy >= 0 ? parseFlexibleNumber(cells[colMap.andilYoy]) : null) ?? 0;

    const kode = normalizeKodeByFlag(rawKode, flag);
    const { kdKota, regionLevel, kalbarFlag } = classifyRegion(rawKdKota, namaKota);

    rows.push({
      tahun,
      bulan,
      kdKota,
      namaKota,
      kode,
      rawKode,
      nama: nama.replace(/^"+|"+$/g, '').replace(/""/g, '"').trim(),
      flag,
      ihk,
      infMom,
      infYtd,
      infYoy,
      andilMom,
      andilYtd,
      andilYoy,
      regionLevel,
      kalbarFlag,
    });
  }

  if (rows.length === 0) {
    throw new Error('Tidak ada baris data inflasi valid yang ditemukan pada file.');
  }

  return {
    fileName,
    uploadedAt: new Date().toISOString(),
    title: title || 'INFLASI DAN ANDIL SEMENTARA',
    tahun: detectedTahun,
    bulan: detectedBulan,
    rows,
  };
}

export function buildAngkaSementaraIndex(dataset: AngkaSementaraDataset): AngkaSementaraIndex {
  const provSet = new Set<string>();
  const kabSet = new Set<string>();
  const kalbarMap = new Map<
    string,
    { kdKota: string; namaKota: string; regionLevel: AngkaSementaraRegionLevel; kalbarFlag: KalbarFlagType }
  >();
  const byCommodity = new Map<string, AngkaSementaraRow[]>();
  const catalogMap = new Map<string, CommodityCatalogItem>();

  for (const row of dataset.rows) {
    if (row.regionLevel === 'PROVINSI') provSet.add(row.kdKota);
    else kabSet.add(row.kdKota);

    if (row.kalbarFlag !== 'NON_KALBAR' && !kalbarMap.has(row.kdKota)) {
      kalbarMap.set(row.kdKota, {
        kdKota: row.kdKota,
        namaKota: row.namaKota,
        regionLevel: row.regionLevel,
        kalbarFlag: row.kalbarFlag,
      });
    }

    const cKey = `${row.flag}|${row.kode}`;
    let list = byCommodity.get(cKey);
    if (!list) {
      list = [];
      byCommodity.set(cKey, list);
    }
    list.push(row);

    let cat = catalogMap.get(cKey);
    if (!cat) {
      cat = {
        kode: row.kode,
        nama: row.nama,
        flag: row.flag,
        regionCount: 0,
        kalbarCount: 0,
      };
      catalogMap.set(cKey, cat);
    }
    cat.regionCount += 1;
    if (row.kalbarFlag !== 'NON_KALBAR') cat.kalbarCount += 1;
  }

  // Compute exact INF(MOM) ranks (1 = highest INF(MOM))
  // Standard competition ranking (1, 2, 2, 4) or dense/ordinal? Standard competition ranking handles ties cleanly!
  const rankInLevelMap = new Map<string, { rank: number; total: number }>();
  const rankInAllMap = new Map<string, { rank: number; total: number }>();

  const assignCompetitionRanks = (
    items: AngkaSementaraRow[],
    targetMap: Map<string, { rank: number; total: number }>
  ) => {
    if (items.length === 0) return;
    const sorted = [...items].sort((a, b) => b.infMom - a.infMom);
    const total = sorted.length;
    let prevVal: number | null = null;
    let currentRank = 1;
    for (let i = 0; i < sorted.length; i++) {
      const item = sorted[i];
      if (prevVal === null || Math.abs(item.infMom - prevVal) > 1e-9) {
        currentRank = i + 1;
        prevVal = item.infMom;
      }
      targetMap.set(`${item.kdKota}|${item.flag}|${item.kode}`, {
        rank: currentRank,
        total,
      });
    }
  };

  for (const list of byCommodity.values()) {
    assignCompetitionRanks(list, rankInAllMap);
    const provRows = list.filter((r) => r.regionLevel === 'PROVINSI');
    const kabRows = list.filter((r) => r.regionLevel === 'KABKOTA');
    assignCompetitionRanks(provRows, rankInLevelMap);
    assignCompetitionRanks(kabRows, rankInLevelMap);
  }

  const catalog = Array.from(catalogMap.values()).sort((a, b) => {
    if (a.flag !== b.flag) return a.flag - b.flag;
    return a.kode.localeCompare(b.kode);
  });

  const kalbarRegions = Array.from(kalbarMap.values()).sort((a, b) => {
    if (a.kalbarFlag !== b.kalbarFlag) {
      return a.kalbarFlag === 'PROV_KALBAR' ? -1 : 1;
    }
    return a.kdKota.localeCompare(b.kdKota);
  });

  return {
    provCount: provSet.size,
    kabKotaCount: kabSet.size,
    totalRegions: provSet.size + kabSet.size,
    kalbarRegions,
    catalog,
    byCommodity,
    rankInLevelMap,
    rankInAllMap,
  };
}
