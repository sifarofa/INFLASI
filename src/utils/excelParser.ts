import * as XLSX from 'xlsx';
import type {
  CommodityInputRow,
  HierarchyNodeMeta,
  MappingChangePreview,
  ParsedValueRow,
  RespondentCommoditySummary,
  RespondentFrequency,
  RespondentPriceObservation,
  UnmatchedUploadRow,
  UploadFileKind,
  UploadMappingResult,
} from '../types/inflasi';

export function normalizeName(name: string): string {
  return String(name ?? '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*\/\s*/g, '/')
    .trim();
}

export function normalizeCommodityCode(raw: string | number): string {
  const cleaned = String(raw ?? '').trim().replace(/\.0+$/, '');
  if (!cleaned) return '';
  if (/^\d+$/.test(cleaned)) {
    if (cleaned.length === 6 || cleaned.length === 7) {
      return cleaned.padStart(7, '0');
    }
  }
  return cleaned;
}

export function parseFlexibleNumber(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null;
  }
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^\.\d+$/.test(s)) {
    const n = Number(`0${s}`);
    return Number.isFinite(n) ? n : null;
  }
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  // English thousand commas with dot decimal: 2,212,703,889,314.46
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) {
    const n = Number(s.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  // Indonesian thousand dots with comma decimal: 2.212.703,46
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) {
    const n = Number(s.replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  // Comma decimal fallback: 100,45
  if (/^-?\d+,\d+$/.test(s)) {
    const n = Number(s.replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  const fallback = Number(s.replace(/,/g, ''));
  return Number.isFinite(fallback) ? fallback : null;
}

function splitCsvLine(line: string, delimiter: string): string[] {
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

export async function readSpreadsheetRows(fileOrText: File | string, fileName = 'data.csv'): Promise<unknown[][]> {
  let isCsv = fileName.toLowerCase().endsWith('.csv');
  let textContent: string | null = null;

  if (typeof fileOrText === 'string') {
    isCsv = true;
    textContent = fileOrText;
  } else if (isCsv) {
    textContent = await fileOrText.text();
  }

  if (isCsv && textContent !== null) {
    const cleanText = textContent.replace(/^\uFEFF/, '');
    const sampleLines = cleanText.split(/\r?\n/).slice(0, 10).join('\n');
    const semiCount = (sampleLines.match(/;/g) || []).length;
    const commaCount = (sampleLines.match(/,/g) || []).length;
    const delimiter = semiCount >= commaCount ? ';' : ',';
    return cleanText
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .map((line) => splitCsvLine(line, delimiter));
  }

  const buffer = await (fileOrText as File).arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return [];
  const sheet = workbook.Sheets[firstSheetName];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }) as unknown[][];
}

function findHeaderRow(rows: unknown[][], kind: UploadFileKind): {
  headerIndex: number;
  codeIdx: number;
  nameIdx: number;
  flagIdx: number;
  valueIdx: number;
  kuesIdx: number;
} {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const row = rows[i].map((c) => String(c ?? '').trim().toLowerCase());
    const codeIdx = row.findIndex(
      (h) =>
        h === 'kode komoditas' ||
        h === 'kode_komoditas' ||
        h === 'kel' ||
        h === 'kode'
    );
    const nameIdx = row.findIndex(
      (h) =>
        h === 'nama komoditas' ||
        h === 'nama_komoditas' ||
        h === 'kelompok' ||
        h === 'komoditas'
    );
    const flagIdx = row.findIndex((h) => h === 'flag' || h === 'in');
    const kuesIdx = row.findIndex((h) => h === 'kuesioner');

    let valueIdx = -1;
    if (kind === 'NK0') {
      valueIdx = row.findIndex(
        (h) =>
          h === 'nk0=sbh2022' ||
          h === 'nk0=sbh' ||
          h === 'nk0' ||
          h.startsWith('nk0')
      );
    } else if (kind === 'NK_PREV') {
      valueIdx = row.findIndex(
        (h) =>
          h === 'nk' ||
          h === 'nk (n-1)' ||
          h === 'nk bulan sebelumnya' ||
          h === 'nk september'
      );
    } else {
      valueIdx = row.findIndex(
        (h) =>
          h === 'rh' ||
          h === 'rh (n)' ||
          h === 'rh oktober' ||
          h.startsWith('rh ')
      );
    }

    if ((codeIdx !== -1 || nameIdx !== -1) && valueIdx !== -1) {
      return { headerIndex: i, codeIdx, nameIdx, flagIdx, valueIdx, kuesIdx };
    }
  }

  if (kind === 'NK0') {
    throw new Error('Header kolom "Kel"/"Kode Komoditas" dan "NK0=SBH2022"/"NK0" tidak ditemukan pada file.');
  }
  throw new Error(
    kind === 'NK_PREV'
      ? 'Header kolom "Kode Komoditas" dan "NK" tidak ditemukan pada file.'
      : 'Header kolom "Kode Komoditas" dan "RH" tidak ditemukan pada file.'
  );
}

export function mapUploadedRowsToRegion(
  rawRows: unknown[][],
  kind: UploadFileKind,
  fileName: string,
  currentInputs: Record<string, CommodityInputRow>,
  allNodes: HierarchyNodeMeta[],
  options?: { fillEmptyRhWith100?: boolean }
): UploadMappingResult {
  const fillEmptyRhWith100 = options?.fillEmptyRhWith100 ?? true;
  const { headerIndex, codeIdx, nameIdx, flagIdx, valueIdx, kuesIdx } = findHeaderRow(rawRows, kind);

  const commodityNodes = allNodes.filter((n) => n.flag === 3);
  const byPaddedCode = new Map(commodityNodes.map((n) => [n.kode, n]));
  const byNormName = new Map(commodityNodes.map((n) => [normalizeName(n.nama), n]));
  const existingNodeMap = new Map(allNodes.map((n) => [n.kode, n]));

  const parsedRows: ParsedValueRow[] = [];
  const unmatchedRows: UnmatchedUploadRow[] = [];
  const changes: MappingChangePreview[] = [];
  const updatesMap: Record<string, number> = {};
  const newHierarchyNodes: HierarchyNodeMeta[] = [];
  const pakomCodes: string[] = [];
  const seenPakom = new Set<string>();
  let replacedEmptyCount = 0;

  // If NK0, also capture Flag 1 & Flag 2 labels so new subkelompok/kelompok get proper names
  const extraGroupNames = new Map<string, { nama: string; flag: 1 | 2 }>();

  for (let r = headerIndex + 1; r < rawRows.length; r++) {
    const cells = rawRows[r];
    if (!cells || cells.every((c) => String(c ?? '').trim() === '')) continue;

    const rawCode = codeIdx >= 0 ? String(cells[codeIdx] ?? '').trim() : '';
    const namaKomoditas = nameIdx >= 0 ? String(cells[nameIdx] ?? '').trim() : '';
    const rawFlag = flagIdx >= 0 ? parseFlexibleNumber(cells[flagIdx]) : null;
    const rawVal = parseFlexibleNumber(cells[valueIdx]);
    const kuesioner = kuesIdx >= 0 ? String(cells[kuesIdx] ?? '').trim() : undefined;

    if (!rawCode && !namaKomoditas) continue;

    const digitsOnly = rawCode.replace(/\.0+$/, '');
    const isSummaryFlag =
      (rawFlag !== null && rawFlag !== 3) ||
      (/^\d{1,3}$/.test(digitsOnly) && digitsOnly.length <= 3) ||
      namaKomoditas.toUpperCase() === 'UMUM' ||
      namaKomoditas.toUpperCase() === 'TOTAL';

    if (isSummaryFlag) {
      if (kind === 'NK0' && (rawFlag === 1 || rawFlag === 2) && digitsOnly) {
        const paddedGroup = rawFlag === 1 ? digitsOnly.padStart(2, '0') : digitsOnly.padStart(3, '0');
        extraGroupNames.set(paddedGroup, { nama: namaKomoditas, flag: rawFlag });
      }
      continue;
    }

    const isEmptyOrZeroRh = kind === 'RH_CURRENT' && (rawVal === null || rawVal <= 0);
    let effectiveVal = rawVal;
    let replacedEmpty = false;

    if (isEmptyOrZeroRh && fillEmptyRhWith100) {
      effectiveVal = 100;
      replacedEmpty = true;
    }

    if (effectiveVal === null) {
      unmatchedRows.push({
        sourceRowIndex: r + 1,
        rawCode,
        namaKomoditas,
        value: NaN,
        reason: `Nilai kolom ${kind === 'NK0' ? 'NK0' : kind === 'NK_PREV' ? 'NK' : 'RH'} kosong atau tidak valid`,
      });
      continue;
    }

    const normalizedCode = normalizeCommodityCode(rawCode);
    parsedRows.push({
      rawCode,
      normalizedCode,
      namaKomoditas,
      flag: rawFlag ?? undefined,
      value: effectiveVal,
      sourceRowIndex: r + 1,
      kuesioner,
    });

    if (kind === 'NK0') {
      if (!normalizedCode) {
        unmatchedRows.push({
          sourceRowIndex: r + 1,
          rawCode,
          namaKomoditas,
          value: effectiveVal,
          reason: 'Kode komoditas kosong pada file NK0',
        });
        continue;
      }

      if (!seenPakom.has(normalizedCode)) {
        seenPakom.add(normalizedCode);
        pakomCodes.push(normalizedCode);
      }

      const existingMeta = byPaddedCode.get(normalizedCode);
      if (!existingMeta) {
        // Register new commodity (plus parent subkelompok/kelompok if missing)
        const kelCode = normalizedCode.slice(0, 2);
        const subCode = normalizedCode.slice(0, 3);

        if (!existingNodeMap.has(kelCode) && !newHierarchyNodes.some((n) => n.kode === kelCode)) {
          const grp = extraGroupNames.get(kelCode);
          newHierarchyNodes.push({
            kode: kelCode,
            lkKode: kelCode,
            nama: grp?.nama ?? `KELOMPOK ${kelCode}`,
            flag: 1,
            parentCode: '0',
            kelompokCode: kelCode,
            subkelompokCode: null,
            kuesioner: null,
          });
        }

        if (!existingNodeMap.has(subCode) && !newHierarchyNodes.some((n) => n.kode === subCode)) {
          const subGrp = extraGroupNames.get(subCode);
          newHierarchyNodes.push({
            kode: subCode,
            lkKode: subCode,
            nama: subGrp?.nama ?? `SUBKELOMPOK ${subCode}`,
            flag: 2,
            parentCode: kelCode,
            kelompokCode: kelCode,
            subkelompokCode: subCode,
            kuesioner: null,
          });
        }

        newHierarchyNodes.push({
          kode: normalizedCode,
          lkKode: normalizedCode.replace(/^0+/, '') || normalizedCode,
          nama: namaKomoditas || `KOMODITAS ${normalizedCode}`,
          flag: 3,
          parentCode: subCode,
          kelompokCode: kelCode,
          subkelompokCode: subCode,
          kuesioner: kuesioner ?? null,
        });
      }

      const existingInput = currentInputs[normalizedCode];
      const oldValue = existingInput ? existingInput.nk0 : null;
      const newValue = effectiveVal;
      const diff = oldValue !== null ? newValue - oldValue : newValue;
      const diffPct = oldValue && oldValue !== 0 ? (diff / oldValue) * 100 : 0;

      updatesMap[normalizedCode] = newValue;
      changes.push({
        kode: normalizedCode,
        nama: existingMeta?.nama ?? (namaKomoditas || normalizedCode),
        matchedBy: existingInput ? 'CODE' : 'NEW_PAKOM',
        oldValue,
        newValue,
        diff,
        diffPct,
        pakomStatus: existingInput ? 'TETAP' : 'BARU',
      });
      continue;
    }

    // NK_PREV or RH_CURRENT mapping
    let matchedNode = normalizedCode ? byPaddedCode.get(normalizedCode) : undefined;
    let matchedBy: 'CODE' | 'NAME' = 'CODE';

    if (!matchedNode && namaKomoditas) {
      matchedNode = byNormName.get(normalizeName(namaKomoditas));
      matchedBy = 'NAME';
    }

    if (!matchedNode) {
      unmatchedRows.push({
        sourceRowIndex: r + 1,
        rawCode,
        namaKomoditas,
        value: effectiveVal,
        reason: 'Kode/nama komoditas tidak terdaftar pada master katalog IHK',
      });
      continue;
    }

    const existing = currentInputs[matchedNode.kode];
    if (!existing) {
      unmatchedRows.push({
        sourceRowIndex: r + 1,
        rawCode: matchedNode.kode,
        namaKomoditas: matchedNode.nama,
        value: effectiveVal,
        reason: 'Komoditas tidak termasuk dalam Pakom (NK0) wilayah ini',
      });
      continue;
    }

    if (replacedEmpty) replacedEmptyCount++;

    const oldValue = kind === 'NK_PREV' ? existing.nkPrev : existing.rhCurrent;
    const newValue = effectiveVal;
    const diff = newValue - oldValue;
    const diffPct = oldValue !== 0 ? (diff / oldValue) * 100 : 0;

    updatesMap[matchedNode.kode] = newValue;
    changes.push({
      kode: matchedNode.kode,
      nama: matchedNode.nama,
      matchedBy,
      oldValue,
      newValue,
      diff,
      diffPct,
      ...(replacedEmpty ? { replacedEmpty: true } : {}),
    });
  }

  let addedToPakomCount = 0;
  let removedFromPakomCount = 0;
  if (kind === 'NK0') {
    addedToPakomCount = pakomCodes.filter((k) => !currentInputs[k]).length;
    const newSet = new Set(pakomCodes);
    for (const [kode, row] of Object.entries(currentInputs)) {
      if (!newSet.has(kode)) {
        removedFromPakomCount++;
        const nodeMeta = byPaddedCode.get(kode);
        changes.push({
          kode,
          nama: nodeMeta?.nama ?? kode,
          matchedBy: 'CODE',
          oldValue: row.nk0,
          newValue: 0,
          diff: -row.nk0,
          diffPct: -100,
          pakomStatus: 'DIHAPUS',
        });
      }
    }
  }

  return {
    kind,
    fileName,
    detectedHeaderRow: headerIndex + 1,
    totalParsedRows: parsedRows.length,
    matchedCount: Object.keys(updatesMap).length,
    unmatchedCount: unmatchedRows.length,
    changes,
    unmatchedRows,
    updatesMap,
    ...(kind === 'RH_CURRENT' ? { replacedEmptyCount } : {}),
    ...(kind === 'NK0'
      ? {
          pakomCodes,
          addedToPakomCount,
          removedFromPakomCount,
          newHierarchyNodes,
        }
      : {}),
  };
}

export function fillMissingPakomRhWith100(
  currentMapping: UploadMappingResult | null,
  currentInputs: Record<string, CommodityInputRow>,
  allNodes: HierarchyNodeMeta[]
): UploadMappingResult {
  const nodeByCode = new Map(allNodes.filter((n) => n.flag === 3).map((n) => [n.kode, n]));
  const baseUpdates = currentMapping ? { ...currentMapping.updatesMap } : {};
  const baseChanges = currentMapping ? [...currentMapping.changes] : [];
  let replacedCount = currentMapping?.replacedEmptyCount ?? 0;

  for (const [kode, row] of Object.entries(currentInputs)) {
    const existingUpdate = baseUpdates[kode];
    if (existingUpdate === undefined || !Number.isFinite(existingUpdate) || existingUpdate <= 0) {
      const oldValue = row.rhCurrent;
      const newValue = 100;
      baseUpdates[kode] = newValue;
      replacedCount++;

      const idx = baseChanges.findIndex((c) => c.kode === kode);
      const changeEntry: MappingChangePreview = {
        kode,
        nama: nodeByCode.get(kode)?.nama ?? kode,
        matchedBy: 'CODE',
        oldValue,
        newValue,
        diff: newValue - oldValue,
        diffPct: oldValue !== 0 ? ((newValue - oldValue) / oldValue) * 100 : 0,
        replacedEmpty: true,
      };
      if (idx >= 0) {
        baseChanges[idx] = changeEntry;
      } else {
        baseChanges.push(changeEntry);
      }
    }
  }

  return {
    kind: 'RH_CURRENT',
    fileName: currentMapping?.fileName ?? 'Replace_RH_Kosong_100',
    detectedHeaderRow: currentMapping?.detectedHeaderRow ?? 1,
    totalParsedRows: Math.max(currentMapping?.totalParsedRows ?? 0, Object.keys(baseUpdates).length),
    matchedCount: Object.keys(baseUpdates).length,
    unmatchedCount: currentMapping?.unmatchedCount ?? 0,
    changes: baseChanges,
    unmatchedRows: currentMapping?.unmatchedRows ?? [],
    updatesMap: baseUpdates,
    replacedEmptyCount: replacedCount,
  };
}

// ============================================================================
// MODULAR STAGE-2 PARSER: RESPONDENT PRICE OBSERVATIONS
// ============================================================================

function geometricMean(values: number[]): number | null {
  const valid = values.filter((v) => Number.isFinite(v) && v > 0);
  if (valid.length === 0) return null;
  const sumLog = valid.reduce((acc, v) => acc + Math.log(v), 0);
  return Math.exp(sumLog / valid.length);
}

export function parseRespondentObservations(
  rawRows: unknown[][],
  frequency: RespondentFrequency
): RespondentPriceObservation[] {
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rawRows.length, 15); i++) {
    const row = rawRows[i].map((c) => String(c ?? '').trim().toLowerCase());
    if (row.includes('kode komoditas') && row.includes('nama responden')) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    throw new Error('Header template harga responden (Kode Komoditas / Nama Responden) tidak ditemukan.');
  }

  const headers = rawRows[headerIdx].map((c) => String(c ?? '').trim());
  const idx = (name: string) => headers.findIndex((h) => h.toLowerCase() === name.toLowerCase());

  const colKode = idx('Kode Komoditas');
  const colKomoditas = idx('Komoditas');
  const colKodeKual = idx('Kode Kualitas');
  const colBobotKual = idx('Bobot Kualitas');
  const colKual = idx('Kualitas');
  const colBobotJenis = idx('Bobot Jenis Pasar');
  const colJenis = idx('Jenis Pasar');
  const colBobotPasar = idx('Bobot Pasar');
  const colPasar = idx('Pasar');
  const colResp = idx('Nama Responden');

  const priceStartIdx = colResp + 1;
  const priceColsPerPeriod = frequency === 'MINGGUAN' ? 5 : frequency === 'DWIMINGGUAN' ? 2 : 1;

  const observations: RespondentPriceObservation[] = [];

  for (let r = headerIdx + 1; r < rawRows.length; r++) {
    const row = rawRows[r];
    if (!row || row.every((c) => String(c ?? '').trim() === '')) continue;

    const kodeKomoditas = normalizeCommodityCode(String(row[colKode] ?? ''));
    if (!kodeKomoditas) continue;

    const prevPrices: (number | null)[] = [];
    const currPrices: (number | null)[] = [];

    for (let p = 0; p < priceColsPerPeriod; p++) {
      const pv = parseFlexibleNumber(row[priceStartIdx + p]);
      prevPrices.push(pv && pv > 0 ? pv : null);
      const cv = parseFlexibleNumber(row[priceStartIdx + priceColsPerPeriod + p]);
      currPrices.push(cv && cv > 0 ? cv : null);
    }

    const prevAvgPrice = geometricMean(prevPrices.filter((v): v is number => v !== null));
    const currAvgPrice = geometricMean(currPrices.filter((v): v is number => v !== null));
    const priceRelative =
      prevAvgPrice && currAvgPrice && prevAvgPrice > 0
        ? (currAvgPrice / prevAvgPrice) * 100
        : null;

    observations.push({
      id: `${frequency}-${r}-${kodeKomoditas}-${String(row[colKodeKual] ?? '')}`,
      kodeKomoditas,
      komoditas: String(row[colKomoditas] ?? '').trim(),
      kodeKualitas: String(row[colKodeKual] ?? '').trim(),
      bobotKualitas: parseFlexibleNumber(row[colBobotKual]) ?? 0,
      kualitas: String(row[colKual] ?? '').trim(),
      bobotJenisPasar: parseFlexibleNumber(row[colBobotJenis]) ?? 0,
      jenisPasar: String(row[colJenis] ?? '').trim(),
      bobotPasar: parseFlexibleNumber(row[colBobotPasar]) ?? 0,
      pasar: String(row[colPasar] ?? '').trim(),
      namaResponden: String(row[colResp] ?? '').trim(),
      frequency,
      prevPrices,
      currPrices,
      prevAvgPrice,
      currAvgPrice,
      priceRelative,
    });
  }

  return observations;
}

export function summarizeRespondentRH(
  observations: RespondentPriceObservation[],
  frequency: RespondentFrequency
): RespondentCommoditySummary[] {
  const byCommodity = new Map<string, RespondentPriceObservation[]>();
  for (const obs of observations) {
    const arr = byCommodity.get(obs.kodeKomoditas) ?? [];
    arr.push(obs);
    byCommodity.set(obs.kodeKomoditas, arr);
  }

  const summaries: RespondentCommoditySummary[] = [];
  for (const [kodeKomoditas, list] of byCommodity.entries()) {
    const activeRelatives = list
      .map((o) => o.priceRelative)
      .filter((v): v is number => v !== null && v > 0);
    const qualities = new Set(list.map((o) => o.kodeKualitas));
    const calculatedRH = geometricMean(activeRelatives);

    summaries.push({
      kodeKomoditas,
      komoditas: list[0]?.komoditas ?? kodeKomoditas,
      frequency,
      observationCount: list.length,
      activeObservationCount: activeRelatives.length,
      qualityCount: qualities.size,
      calculatedRH,
      observations: list,
    });
  }

  return summaries.sort((a, b) => a.kodeKomoditas.localeCompare(b.kodeKomoditas));
}
