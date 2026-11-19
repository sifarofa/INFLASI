import type {
  CommodityInputRow,
  HierarchyNodeMeta,
  KabKotaCode,
  PeriodSelection,
  RegionCode,
  RegionInfo,
} from '../types/inflasi';
import { SINTANG_BASELINE_INPUTS } from './masterHierarchy';

export const BULAN_OPTIONS = [
  { value: 1, label: 'Januari' },
  { value: 2, label: 'Februari' },
  { value: 3, label: 'Maret' },
  { value: 4, label: 'April' },
  { value: 5, label: 'Mei' },
  { value: 6, label: 'Juni' },
  { value: 7, label: 'Juli' },
  { value: 8, label: 'Agustus' },
  { value: 9, label: 'September' },
  { value: 10, label: 'Oktober' },
  { value: 11, label: 'November' },
  { value: 12, label: 'Desember' },
];

export const DEFAULT_PERIOD: PeriodSelection = {
  month: 10,
  year: 2025,
};

export const REGIONS: RegionInfo[] = [
  {
    code: '6100',
    name: 'Provinsi Kalimantan Barat',
    shortName: 'Kalbar',
    type: 'PROVINSI',
    isAggregated: true,
    scaleFactor: 1,
  },
  {
    code: '6106',
    name: 'Kabupaten Ketapang',
    shortName: 'Ketapang',
    type: 'KABUPATEN',
    isAggregated: false,
    scaleFactor: 1.24,
  },
  {
    code: '6107',
    name: 'Kabupaten Sintang',
    shortName: 'Sintang',
    type: 'KABUPATEN',
    isAggregated: false,
    scaleFactor: 1.0,
  },
  {
    code: '6111',
    name: 'Kabupaten Kayong Utara',
    shortName: 'KKU',
    type: 'KABUPATEN',
    isAggregated: false,
    scaleFactor: 0.48,
  },
  {
    code: '6171',
    name: 'Kota Pontianak',
    shortName: 'Pontianak',
    type: 'KOTA',
    isAggregated: false,
    scaleFactor: 2.75,
  },
  {
    code: '6172',
    name: 'Kota Singkawang',
    shortName: 'Singkawang',
    type: 'KOTA',
    isAggregated: false,
    scaleFactor: 1.08,
  },
];

export const KAB_KOTA_CODES: KabKotaCode[] = ['6106', '6107', '6111', '6171', '6172'];
export const JEJER_COLUMN_ORDER: RegionCode[] = ['6106', '6107', '6111', '6171', '6172', '6100'];

/**
 * Additional real-world Kalbar commodities (outside Sintang's 277 Pakom)
 * so cross-regional Tabel Jejer showcases authentic Pakom differences ('—' vs numeric)
 * on initial load as well.
 */
export const EXTRA_KALBAR_NODES: HierarchyNodeMeta[] = [
  {
    kode: '0119085',
    lkKode: '119085',
    nama: 'KUNYIT',
    flag: 3,
    parentCode: '011',
    kelompokCode: '01',
    subkelompokCode: '011',
    kuesioner: 'HK-1.2',
  },
];

/**
 * Realistic regional Pakom exclusions for dummy Kab/Kota (Sintang 6107 stays 100% exact 277).
 */
const PAKOM_EXCLUSIONS: Record<Exclude<KabKotaCode, '6107'>, Set<string>> = {
  '6106': new Set(['0117097', '0116006', '0452032']), // Ketapang: example Pakom differences
  '6111': new Set(['0633001', '0112001', '0116006', '0452032']), // Kayong Utara: no commercial airport (0633001)
  '6171': new Set([]), // Pontianak: full urban basket
  '6172': new Set(['0633001', '0452032']), // Singkawang: no commercial airport (0633001)
};

export function getRegionInfo(code: RegionCode): RegionInfo {
  return REGIONS.find((r) => r.code === code) ?? REGIONS[0];
}

export function formatPeriodLabel(period: PeriodSelection): string {
  const bulan = BULAN_OPTIONS.find((b) => b.value === period.month)?.label ?? String(period.month);
  return `${bulan} ${period.year}`;
}

export function getPrevMonthLabel(period: PeriodSelection): string {
  const prevMonth = period.month === 1 ? 12 : period.month - 1;
  return BULAN_OPTIONS.find((b) => b.value === prevMonth)?.label ?? 'Bulan Sebelum';
}

export function getCurrentMonthLabel(period: PeriodSelection): string {
  return BULAN_OPTIONS.find((b) => b.value === period.month)?.label ?? 'Bulan Berjalan';
}

function seededNoise(seedStr: string): number {
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

interface RegionBiasProfile {
  scale: number;
  ihkShift: number;
  rhVolatility: number;
  rhDrift: number;
}

const DUMMY_PROFILES: Record<Exclude<KabKotaCode, '6107'>, RegionBiasProfile> = {
  '6106': { scale: 1.24, ihkShift: 1.008, rhVolatility: 0.85, rhDrift: 0.04 },
  '6111': { scale: 0.48, ihkShift: 1.012, rhVolatility: 1.05, rhDrift: 0.09 },
  '6171': { scale: 2.75, ihkShift: 0.996, rhVolatility: 0.72, rhDrift: 0.06 },
  '6172': { scale: 1.08, ihkShift: 1.003, rhVolatility: 0.9, rhDrift: -0.05 },
};

export function buildInitialKabKotaInputs(): Record<KabKotaCode, Record<string, CommodityInputRow>> {
  const result = {} as Record<KabKotaCode, Record<string, CommodityInputRow>>;

  // 6107 Sintang exact baseline (277 commodities)
  const sintangMap: Record<string, CommodityInputRow> = {};
  for (const item of SINTANG_BASELINE_INPUTS) {
    sintangMap[item.kode] = { ...item };
  }
  result['6107'] = sintangMap;

  const dummyCodes: Exclude<KabKotaCode, '6107'>[] = ['6106', '6111', '6171', '6172'];
  for (const regCode of dummyCodes) {
    const profile = DUMMY_PROFILES[regCode];
    const exclusions = PAKOM_EXCLUSIONS[regCode];
    const regMap: Record<string, CommodityInputRow> = {};

    for (const item of SINTANG_BASELINE_INPUTS) {
      if (exclusions.has(item.kode)) continue;

      const n1 = seededNoise(`${regCode}:${item.kode}:nk0`);
      const n2 = seededNoise(`${regCode}:${item.kode}:ihk`);
      const n3 = seededNoise(`${regCode}:${item.kode}:rh`);
      const n4 = seededNoise(`${regCode}:${item.kode}:active`);

      const kelompok = item.kode.slice(0, 2);
      let sectorWeightMult = 1.0;
      if (regCode === '6171') {
        if (kelompok === '03' || kelompok === '06' || kelompok === '09' || kelompok === '10') {
          sectorWeightMult = 1.18;
        } else if (kelompok === '01') {
          sectorWeightMult = 0.88;
        }
      } else if (regCode === '6111') {
        if (kelompok === '01') sectorWeightMult = 1.16;
        if (kelompok === '09' || kelompok === '10') sectorWeightMult = 0.82;
      }

      const nk0 = Number((item.nk0 * profile.scale * sectorWeightMult * (0.86 + n1 * 0.28)).toFixed(2));
      const baseIhkRatio = item.nk0 > 0 ? item.nkPrev / item.nk0 : 1;
      const regionalIhkRatio =
        baseIhkRatio === 1
          ? 1
          : Math.max(0.55, baseIhkRatio * profile.ihkShift * (0.97 + n2 * 0.06));
      const nkPrev = Number((nk0 * regionalIhkRatio).toFixed(2));

      const baseDelta = item.rhCurrent - 100;
      let rhCurrent = 100;
      if (Math.abs(baseDelta) > 0.0001) {
        const directionNoise = (n3 - 0.45) * 3.2 * profile.rhVolatility;
        rhCurrent = Number((100 + baseDelta * (0.65 + n4 * 0.6) + directionNoise + profile.rhDrift).toFixed(6));
      } else if (kelompok === '01' && n4 > 0.82) {
        rhCurrent = Number((100 + (n3 - 0.48) * 5.2 + profile.rhDrift).toFixed(6));
      } else if (item.kode === '0633001' || item.kode === '1121001') {
        rhCurrent = Number((100 + (n3 - 0.35) * 4.5).toFixed(6));
      }

      regMap[item.kode] = {
        kode: item.kode,
        nk0,
        nkPrev,
        rhCurrent,
      };
    }

    // Add Extra Kalbar Commodity (0119085 KUNYIT) to Ketapang, Pontianak, Singkawang
    if (regCode === '6106' || regCode === '6171' || regCode === '6172') {
      const kunyitBaseNk0 = 1450000000 * profile.scale * (0.9 + seededNoise(`${regCode}:0119085`) * 0.2);
      const kunyitPrev = kunyitBaseNk0 * 1.08;
      const kunyitRh = regCode === '6106' ? 105.4 : regCode === '6171' ? 102.3 : 100;
      regMap['0119085'] = {
        kode: '0119085',
        nk0: Number(kunyitBaseNk0.toFixed(2)),
        nkPrev: Number(kunyitPrev.toFixed(2)),
        rhCurrent: kunyitRh,
      };
    }

    result[regCode] = regMap;
  }

  return result;
}
