export type KabKotaCode = '6106' | '6107' | '6111' | '6171' | '6172';
export type RegionCode = '6100' | KabKotaCode;

export type HierarchyFlag = 0 | 1 | 2 | 3;

export interface RegionInfo {
  code: RegionCode;
  name: string;
  shortName: string;
  type: 'PROVINSI' | 'KABUPATEN' | 'KOTA';
  isAggregated: boolean;
  /** Relative economic consumption scale vs Sintang (6107) for dummy seed generation */
  scaleFactor: number;
}

export interface PeriodSelection {
  month: number; // 1-12
  year: number;
}

export interface HierarchyNodeMeta {
  kode: string; // Zero-padded: '0', '01', '011', '0111001'
  lkKode: string; // Template LK style code (e.g. '111001' or '1121001')
  nama: string;
  flag: HierarchyFlag;
  parentCode: string | null;
  kelompokCode: string | null;
  subkelompokCode: string | null;
  kuesioner: string | null;
}

export interface CommodityInputRow {
  kode: string; // 7-digit zero-padded commodity code ('0111001')
  nk0: number; // Base consumption value (SBH 2022=100)
  nkPrev: number; // NK (N-1)
  rhCurrent: number; // RH (N) — index relative ~100
  ihkPrevRef?: number;
}

export interface LKCalculatedRow {
  kode: string;
  lkKode: string;
  nama: string;
  flag: HierarchyFlag;
  parentCode: string | null;
  kelompokCode: string | null;
  subkelompokCode: string | null;
  kuesioner: string | null;
  nk0: number;
  nkPrev: number;
  nkCurrent: number;
  pctNkPrev: number;
  pctNkCurrent: number;
  rhCurrent: number;
  andilInflasi: number;
  ihkPrev: number;
  ihkCurrent: number;
  inflasi: number;
}

export interface RegionLKResult {
  regionCode: RegionCode;
  regionName: string;
  period: PeriodSelection;
  umum: LKCalculatedRow;
  rows: LKCalculatedRow[];
  commodities: LKCalculatedRow[];
  kelompokList: LKCalculatedRow[];
  subkelompokList: LKCalculatedRow[];
  topInflation: LKCalculatedRow[];
  topDeflation: LKCalculatedRow[];
  pakomCount: number;
}

export interface TabelJejerCell {
  inPakom: boolean;
  andilInflasi: number | null;
  inflasi: number | null;
  rhCurrent: number | null;
  ihkCurrent: number | null;
  nkCurrent: number | null;
}

export interface TabelJejerRow {
  kode: string;
  nama: string;
  flag: HierarchyFlag;
  kelompokCode: string | null;
  subkelompokCode: string | null;
  cells: Record<RegionCode, TabelJejerCell>;
  upCount: number;
  downCount: number;
  flatCount: number;
  activeRegionCount: number;
}

export type UploadFileKind = 'NK0' | 'NK_PREV' | 'RH_CURRENT';

export interface ParsedValueRow {
  rawCode: string;
  normalizedCode: string;
  namaKomoditas: string;
  flag?: number;
  value: number;
  sourceRowIndex: number;
  kuesioner?: string;
}

export interface MappingChangePreview {
  kode: string;
  nama: string;
  matchedBy: 'CODE' | 'NAME' | 'NEW_PAKOM';
  oldValue: number | null;
  newValue: number;
  diff: number;
  diffPct: number;
  pakomStatus?: 'TETAP' | 'BARU' | 'DIHAPUS';
  replacedEmpty?: boolean;
}

export interface UnmatchedUploadRow {
  sourceRowIndex: number;
  rawCode: string;
  namaKomoditas: string;
  value: number;
  reason: string;
}

export interface UploadMappingResult {
  kind: UploadFileKind;
  fileName: string;
  detectedHeaderRow: number;
  totalParsedRows: number;
  matchedCount: number;
  unmatchedCount: number;
  changes: MappingChangePreview[];
  unmatchedRows: UnmatchedUploadRow[];
  updatesMap: Record<string, number>;
  /** Number of empty or <=0 RH rows automatically defaulted to 100 */
  replacedEmptyCount?: number;
  /** Populated when kind === 'NK0' to update regional Pakom + register any new nodes */
  pakomCodes?: string[];
  addedToPakomCount?: number;
  removedFromPakomCount?: number;
  newHierarchyNodes?: HierarchyNodeMeta[];
}

export interface UpdateHistoryEntry {
  id: string;
  timestamp: string;
  regionCode: KabKotaCode;
  period: PeriodSelection;
  kind: UploadFileKind | 'INLINE_EDIT';
  fileName: string;
  matchedCount: number;
  unmatchedCount: number;
}

// ============================================================================
// MODULAR STAGE-2 ARCHITECTURE: ANALISIS RH PER RESPONDEN
// ============================================================================

export type RespondentFrequency = 'MINGGUAN' | 'DWIMINGGUAN' | 'BULANAN';

export interface RespondentPriceObservation {
  id: string;
  kodeKomoditas: string; // 7-digit normalized
  komoditas: string;
  kodeKualitas: string;
  bobotKualitas: number;
  kualitas: string;
  bobotJenisPasar: number;
  jenisPasar: string;
  bobotPasar: number;
  pasar: string;
  namaResponden: string;
  frequency: RespondentFrequency;
  /** Bulan Sebelum: Mingguan [M1..M5], Dwimingguan [M1, M3], Bulanan [Bulan Sebelum] */
  prevPrices: (number | null)[];
  /** Bulan Berjalan: Mingguan [M1..M5], Dwimingguan [M1, M3], Bulanan [Bulan Berjalan] */
  currPrices: (number | null)[];
  prevAvgPrice: number | null;
  currAvgPrice: number | null;
  priceRelative: number | null; // (currAvg / prevAvg) * 100
}

export interface RespondentCommoditySummary {
  kodeKomoditas: string;
  komoditas: string;
  frequency: RespondentFrequency;
  observationCount: number;
  activeObservationCount: number;
  qualityCount: number;
  calculatedRH: number | null;
  observations: RespondentPriceObservation[];
}

export interface RespondentRHDataset {
  regionCode: KabKotaCode;
  period: PeriodSelection;
  frequency: RespondentFrequency;
  fileName: string | null;
  loadedAt: string | null;
  observations: RespondentPriceObservation[];
  commoditySummaries: RespondentCommoditySummary[];
}

export type AdminRole = 'PROVINSI' | 'KABKOTA';

export interface AuthSession {
  role: AdminRole;
  regionCode: RegionCode;
  username: string;
  displayLabel: string;
  loggedInAt: string;
}

export interface PersistedInflationState {
  version: number;
  period: PeriodSelection;
  kabKotaInputs: Record<KabKotaCode, Record<string, CommodityInputRow>>;
  customHierarchyNodes: Record<string, HierarchyNodeMeta>;
  history: UpdateHistoryEntry[];
  respondentDatasets: Record<string, RespondentRHDataset>;
}

// ============================================================================
// MODULAR STAGE-3: ANGKA SEMENTARA & RANKING INF(MOM) KALBAR
// ============================================================================

export type AngkaSementaraRegionLevel = 'PROVINSI' | 'KABKOTA';
export type KalbarFlagType = 'PROV_KALBAR' | 'KABKOTA_KALBAR' | 'NON_KALBAR';

export interface AngkaSementaraRow {
  tahun: number;
  bulan: number;
  kdKota: string;
  namaKota: string;
  kode: string; // Normalized by flag: '0', '01', '011', '0111001'
  rawKode: string;
  nama: string;
  flag: HierarchyFlag;
  ihk: number;
  infMom: number;
  infYtd: number;
  infYoy: number;
  andilMom: number;
  andilYtd: number;
  andilYoy: number;
  regionLevel: AngkaSementaraRegionLevel;
  kalbarFlag: KalbarFlagType;
}

export interface AngkaSementaraDataset {
  fileName: string;
  uploadedAt: string;
  title: string;
  tahun: number | null;
  bulan: number | null;
  rows: AngkaSementaraRow[];
}

