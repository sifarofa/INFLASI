import type {
  CommodityInputRow,
  HierarchyNodeMeta,
  KabKotaCode,
  LKCalculatedRow,
  PeriodSelection,
  RegionCode,
  RegionLKResult,
  TabelJejerCell,
  TabelJejerRow,
} from '../types/inflasi';
import { HIERARCHY_NODES } from '../data/masterHierarchy';
import { EXTRA_KALBAR_NODES, getRegionInfo, KAB_KOTA_CODES } from '../data/regions';

export function buildMergedHierarchy(
  customNodes: Record<string, HierarchyNodeMeta> = {}
): HierarchyNodeMeta[] {
  const byCode = new Map<string, HierarchyNodeMeta>();
  for (const n of HIERARCHY_NODES) {
    byCode.set(n.kode, n);
  }
  for (const n of EXTRA_KALBAR_NODES) {
    if (!byCode.has(n.kode)) byCode.set(n.kode, n);
  }
  for (const n of Object.values(customNodes)) {
    byCode.set(n.kode, n);
  }

  // Keep canonical hierarchy sort order by code ('0' first, then hierarchical lexicographical order)
  return Array.from(byCode.values()).sort((a, b) => {
    if (a.kode === '0') return -1;
    if (b.kode === '0') return 1;
    return a.kode.localeCompare(b.kode);
  });
}

export function buildLKFromCommodityTotals(
  regionCode: RegionCode,
  period: PeriodSelection,
  commodityValues: Record<string, { nk0: number; nkPrev: number; nkCurrent: number }>,
  allNodes: HierarchyNodeMeta[],
  activeCommodityCodes: Set<string>
): RegionLKResult {
  const regionInfo = getRegionInfo(regionCode);

  const subkelompokSums = new Map<string, { nk0: number; nkPrev: number; nkCurrent: number }>();
  const kelompokSums = new Map<string, { nk0: number; nkPrev: number; nkCurrent: number }>();
  const activeSubkelompok = new Set<string>();
  const activeKelompok = new Set<string>();

  let totalNk0 = 0;
  let totalNkPrev = 0;
  let totalNkCurrent = 0;

  for (const node of allNodes) {
    if (node.flag !== 3) continue;
    if (!activeCommodityCodes.has(node.kode)) continue;
    const val = commodityValues[node.kode] ?? { nk0: 0, nkPrev: 0, nkCurrent: 0 };

    totalNk0 += val.nk0;
    totalNkPrev += val.nkPrev;
    totalNkCurrent += val.nkCurrent;

    if (node.subkelompokCode) {
      activeSubkelompok.add(node.subkelompokCode);
      const prevSub = subkelompokSums.get(node.subkelompokCode) ?? {
        nk0: 0,
        nkPrev: 0,
        nkCurrent: 0,
      };
      prevSub.nk0 += val.nk0;
      prevSub.nkPrev += val.nkPrev;
      prevSub.nkCurrent += val.nkCurrent;
      subkelompokSums.set(node.subkelompokCode, prevSub);
    }

    if (node.kelompokCode) {
      activeKelompok.add(node.kelompokCode);
      const prevKel = kelompokSums.get(node.kelompokCode) ?? {
        nk0: 0,
        nkPrev: 0,
        nkCurrent: 0,
      };
      prevKel.nk0 += val.nk0;
      prevKel.nkPrev += val.nkPrev;
      prevKel.nkCurrent += val.nkCurrent;
      kelompokSums.set(node.kelompokCode, prevKel);
    }
  }

  const computeRowMetrics = (
    node: HierarchyNodeMeta,
    nk0: number,
    nkPrev: number,
    nkCurrent: number
  ): LKCalculatedRow => {
    const pctNkPrev = totalNkPrev > 0 ? (nkPrev / totalNkPrev) * 100 : 0;
    const pctNkCurrent = totalNkCurrent > 0 ? (nkCurrent / totalNkCurrent) * 100 : 0;
    const rhCurrent = nkPrev > 0 ? (nkCurrent / nkPrev) * 100 : 100;
    const ihkPrev = nk0 > 0 ? (nkPrev / nk0) * 100 : 0;
    const ihkCurrent = nk0 > 0 ? (nkCurrent / nk0) * 100 : 0;
    const inflasi = nkPrev > 0 ? ((nkCurrent / nkPrev) - 1) * 100 : 0;
    const andilInflasi = totalNkPrev > 0 ? ((nkCurrent - nkPrev) / totalNkPrev) * 100 : 0;

    return {
      kode: node.kode,
      lkKode: node.lkKode,
      nama: node.nama,
      flag: node.flag,
      parentCode: node.parentCode,
      kelompokCode: node.kelompokCode,
      subkelompokCode: node.subkelompokCode,
      kuesioner: node.kuesioner,
      nk0,
      nkPrev,
      nkCurrent,
      pctNkPrev,
      pctNkCurrent,
      rhCurrent,
      andilInflasi,
      ihkPrev,
      ihkCurrent,
      inflasi,
    };
  };

  const rows: LKCalculatedRow[] = [];
  const commodities: LKCalculatedRow[] = [];
  const kelompokList: LKCalculatedRow[] = [];
  const subkelompokList: LKCalculatedRow[] = [];
  let umumRow: LKCalculatedRow | null = null;

  for (const node of allNodes) {
    let vals = { nk0: 0, nkPrev: 0, nkCurrent: 0 };
    if (node.flag === 0) {
      vals = { nk0: totalNk0, nkPrev: totalNkPrev, nkCurrent: totalNkCurrent };
    } else if (node.flag === 1) {
      if (!activeKelompok.has(node.kode)) continue;
      vals = kelompokSums.get(node.kode) ?? vals;
    } else if (node.flag === 2) {
      if (!activeSubkelompok.has(node.kode)) continue;
      vals = subkelompokSums.get(node.kode) ?? vals;
    } else {
      if (!activeCommodityCodes.has(node.kode)) continue;
      vals = commodityValues[node.kode] ?? vals;
    }

    const row = computeRowMetrics(node, vals.nk0, vals.nkPrev, vals.nkCurrent);
    rows.push(row);

    if (node.flag === 0) umumRow = row;
    else if (node.flag === 1) kelompokList.push(row);
    else if (node.flag === 2) subkelompokList.push(row);
    else commodities.push(row);
  }

  const positiveContributors = [...commodities]
    .filter((c) => c.andilInflasi > 0.0000001)
    .sort((a, b) => b.andilInflasi - a.andilInflasi)
    .slice(0, 5);

  const negativeContributors = [...commodities]
    .filter((c) => c.andilInflasi < -0.0000001)
    .sort((a, b) => a.andilInflasi - b.andilInflasi)
    .slice(0, 5);

  const fallbackRoot = allNodes.find((n) => n.flag === 0) ?? HIERARCHY_NODES[0];

  return {
    regionCode,
    regionName: regionInfo.name,
    period,
    umum: umumRow ?? computeRowMetrics(fallbackRoot, totalNk0, totalNkPrev, totalNkCurrent),
    rows,
    commodities,
    kelompokList,
    subkelompokList,
    topInflation: positiveContributors,
    topDeflation: negativeContributors,
    pakomCount: activeCommodityCodes.size,
  };
}

export function calculateRegionLK(
  regionCode: KabKotaCode,
  period: PeriodSelection,
  inputs: Record<string, CommodityInputRow>,
  allNodes: HierarchyNodeMeta[]
): RegionLKResult {
  const commodityValues: Record<string, { nk0: number; nkPrev: number; nkCurrent: number }> = {};
  const activeCodes = new Set<string>();

  for (const node of allNodes) {
    if (node.flag !== 3) continue;
    const item = inputs[node.kode];
    if (!item) continue;
    activeCodes.add(node.kode);
    commodityValues[node.kode] = {
      nk0: item.nk0,
      nkPrev: item.nkPrev,
      nkCurrent: item.nkPrev * (item.rhCurrent / 100),
    };
  }

  return buildLKFromCommodityTotals(regionCode, period, commodityValues, allNodes, activeCodes);
}

export function calculateProvince6100(
  period: PeriodSelection,
  kabKotaInputs: Record<KabKotaCode, Record<string, CommodityInputRow>>,
  allNodes: HierarchyNodeMeta[]
): RegionLKResult {
  const aggregatedCommodities: Record<string, { nk0: number; nkPrev: number; nkCurrent: number }> =
    {};
  const unionCodes = new Set<string>();

  for (const node of allNodes) {
    if (node.flag !== 3) continue;
    let sumNk0 = 0;
    let sumNkPrev = 0;
    let sumNkCurrent = 0;
    let hasAny = false;

    for (const code of KAB_KOTA_CODES) {
      const item = kabKotaInputs[code]?.[node.kode];
      if (item) {
        hasAny = true;
        sumNk0 += item.nk0;
        sumNkPrev += item.nkPrev;
        sumNkCurrent += item.nkPrev * (item.rhCurrent / 100);
      }
    }

    if (hasAny) {
      unionCodes.add(node.kode);
      aggregatedCommodities[node.kode] = {
        nk0: sumNk0,
        nkPrev: sumNkPrev,
        nkCurrent: sumNkCurrent,
      };
    }
  }

  return buildLKFromCommodityTotals('6100', period, aggregatedCommodities, allNodes, unionCodes);
}

export function calculateAllRegions(
  period: PeriodSelection,
  kabKotaInputs: Record<KabKotaCode, Record<string, CommodityInputRow>>,
  customHierarchyNodes: Record<string, HierarchyNodeMeta> = {}
): {
  allNodes: HierarchyNodeMeta[];
  results: Record<RegionCode, RegionLKResult>;
  jejerRows: TabelJejerRow[];
} {
  const allNodes = buildMergedHierarchy(customHierarchyNodes);
  const results = {} as Record<RegionCode, RegionLKResult>;

  for (const code of KAB_KOTA_CODES) {
    results[code] = calculateRegionLK(code, period, kabKotaInputs[code] ?? {}, allNodes);
  }
  results['6100'] = calculateProvince6100(period, kabKotaInputs, allNodes);

  // Build lookup maps per region for Tabel Jejer
  const rowMaps: Record<RegionCode, Map<string, LKCalculatedRow>> = {
    '6100': new Map(results['6100'].rows.map((r) => [r.kode, r])),
    '6106': new Map(results['6106'].rows.map((r) => [r.kode, r])),
    '6107': new Map(results['6107'].rows.map((r) => [r.kode, r])),
    '6111': new Map(results['6111'].rows.map((r) => [r.kode, r])),
    '6171': new Map(results['6171'].rows.map((r) => [r.kode, r])),
    '6172': new Map(results['6172'].rows.map((r) => [r.kode, r])),
  };

  const emptyCell: TabelJejerCell = {
    inPakom: false,
    andilInflasi: null,
    inflasi: null,
    rhCurrent: null,
    ihkCurrent: null,
    nkCurrent: null,
  };

  const allRegionsList: RegionCode[] = ['6106', '6107', '6111', '6171', '6172', '6100'];
  const jejerRows: TabelJejerRow[] = [];

  for (const provRow of results['6100'].rows) {
    const cells = {} as Record<RegionCode, TabelJejerCell>;
    let upCount = 0;
    let downCount = 0;
    let flatCount = 0;
    let activeRegionCount = 0;

    for (const rCode of allRegionsList) {
      const match = rowMaps[rCode].get(provRow.kode);
      if (!match) {
        cells[rCode] = { ...emptyCell };
      } else {
        cells[rCode] = {
          inPakom: true,
          andilInflasi: match.andilInflasi,
          inflasi: match.inflasi,
          rhCurrent: match.rhCurrent,
          ihkCurrent: match.ihkCurrent,
          nkCurrent: match.nkCurrent,
        };
        if (rCode !== '6100') {
          activeRegionCount++;
          if (match.inflasi > 0.0001) upCount++;
          else if (match.inflasi < -0.0001) downCount++;
          else flatCount++;
        }
      }
    }

    jejerRows.push({
      kode: provRow.kode,
      nama: provRow.nama,
      flag: provRow.flag,
      kelompokCode: provRow.kelompokCode,
      subkelompokCode: provRow.subkelompokCode,
      cells,
      upCount,
      downCount,
      flatCount,
      activeRegionCount,
    });
  }

  return { allNodes, results, jejerRows };
}
