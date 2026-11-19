import * as XLSX from 'xlsx';
import type {
  CommodityInputRow,
  HierarchyNodeMeta,
  KabKotaCode,
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

function normalizeRegionCodeCell(raw: unknown): string {
  const cleaned = String(raw ?? '').trim().replace(/\.0+$/, '');
  if (!cleaned) return '';
  if (/^\d+$/.test(cleaned)) {
    return cleaned;
  }
  return cleaned.toUpperCase();
}

export function parseFlexibleNumber(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null;
  }
  let s = String(raw ?? '')
    .replace(/\u00A0/g, ' ')
    .trim();
  if (!s || s === '-' || s === '—' || s === 'N/A' || s.toLowerCase() === 'nan') return null;

  // Strip % suffix if present
  if (s.endsWith('%')) {
    s = s.slice(0, -1).trim();
  }

  // Accounting negative "(123.45)" -> "-123.45"
  let isAccountingNeg = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    isAccountingNeg = true;
    s = s.slice(1, -1).trim();
  }

  // Remove internal whitespace (e.g., "1 234.56")
  s = s.replace(/\s+/g, '');
  if (!s) return null;

  const applySign = (n: number): number | null => {
    if (!Number.isFinite(n)) return null;
    return isAccountingNeg ? -Math.abs(n) : n;
  };

  // Leading dot with optional sign: ".17", "-.17"
  if (/^-?\.\d+$/.test(s)) {
    const normalized = s.startsWith('-.') ? `-0${s.slice(1)}` : `0${s}`;
    return applySign(Number(normalized));
  }
  // Leading comma with optional sign: ",17", "-,17"
  if (/^-?,\d+$/.test(s)) {
    const normalized = s.startsWith('-,') ? `-0.${s.slice(2)}` : `0.${s.slice(1)}`;
    return applySign(Number(normalized));
  }
  // Standard JS number / scientific notation with dot
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) {
    return applySign(Number(s));
  }
  // Scientific notation with comma decimal: "2,2127E+12"
  if (/^-?\d+(,\d+)?[eE][+-]?\d+$/.test(s)) {
    return applySign(Number(s.replace(',', '.')));
  }
  // English thousand commas with dot decimal: 2,212,703,889,314.46
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) {
    return applySign(Number(s.replace(/,/g, '')));
  }
  // Indonesian thousand dots with optional comma decimal: 2.212.703,46
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) {
    return applySign(Number(s.replace(/\./g, '').replace(',', '.')));
  }
  // Comma decimal fallback: 100,45
  if (/^-?\d+,\d+$/.test(s)) {
    return applySign(Number(s.replace(',', '.')));
  }

  const fallback = Number(s.replace(/,/g, ''));
  return Number.isFinite(fallback) ? applySign(fallback) : null;
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

function detectCsvDelimiter(cleanText: string): string {
  const nonEmptyLines = cleanText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, 25);

  if (nonEmptyLines.length === 0) return ';';

  const candidates = [';', ',', '\t'];
  const headerKeywords = [
    'kode',
    'komoditas',
    'komoditi',
    'kelompok',
    'kel',
    'nk',
    'nk0',
    'rh',
    'kota',
    'flag',
    'nama responden',
    'kualitas',
  ];

  let bestDelimiter = ';';
  let bestScore = -1;

  for (const delim of candidates) {
    const colCounts = nonEmptyLines.map((l) => splitCsvLine(l, delim).length);
    const maxCols = Math.max(...colCounts);
    if (maxCols < 2) continue;

    let keywordHits = 0;
    let consistentRows = 0;
    for (const line of nonEmptyLines) {
      const cells = splitCsvLine(line, delim);
      if (cells.length >= 2 && cells.length === maxCols) {
        consistentRows++;
      }
      for (const cell of cells) {
        const norm = cell.trim().toLowerCase();
        if (headerKeywords.some((kw) => norm === kw || norm.startsWith(`${kw} `) || norm.startsWith(`${kw}=`))) {
          keywordHits++;
        }
      }
    }

    const score = keywordHits * 100 + consistentRows * 10 + maxCols;
    if (score > bestScore) {
      bestScore = score;
      bestDelimiter = delim;
    }
  }

  return bestDelimiter;
}

export async function readSpreadsheetRows(fileOrText: File | string, fileName = 'data.csv'): Promise<unknown[][]> {
  const lowerName = fileName.toLowerCase();
  let isTextDelimited = lowerName.endsWith('.csv') || lowerName.endsWith('.tsv') || lowerName.endsWith('.txt');
  let textContent: string | null = null;

  if (typeof fileOrText === 'string') {
    isTextDelimited = true;
    textContent = fileOrText;
  } else if (isTextDelimited) {
    textContent = await fileOrText.text();
  }

  if (isTextDelimited && textContent !== null) {
    const cleanText = textContent.replace(/^\uFEFF/, '');
    const lines = cleanText.split(/\r?\n/).filter((line) => line.length > 0);
    // Handle BPS quoted-tab lines if present
    if (lines.length > 0 && lines[0].startsWith('"') && lines[0].includes('\t')) {
      return lines.map((rawLine) => {
        let line = rawLine.trim();
        if (line.endsWith(',')) line = line.slice(0, -1).trim();
        if (line.startsWith('"') && line.endsWith('"') && line.length >= 2) {
          line = line.slice(1, -1);
        }
        return line.split('\t').map((cell) => cell.replace(/""/g, '"').trim());
      });
    }

    const delimiter = detectCsvDelimiter(cleanText);
    return lines.map((line) => splitCsvLine(line, delimiter));
  }

  const buffer = await (fileOrText as File).arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return [];
  const sheet = workbook.Sheets[firstSheetName];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }) as unknown[][];
}

function isNkPrevHeader(h: string): boolean {
  if (!h) return false;
  if (h.includes('%') || h.includes('thd') || h.startsWith('nk0')) return false;
  if (
    h === 'nk' ||
    h === 'nk (n-1)' ||
    h === 'nk(n-1)' ||
    h === 'nk_n-1' ||
    h === 'nk_prev' ||
    h === 'nk bulan sebelumnya' ||
    h === 'nk bulan lalu'
  ) {
    return true;
  }
  // Any "nk <month/period>" header (e.g., "nk september", "nk oktober", "nk okt", "nk nov")
  if (/^nk[\s_(-]+[a-z0-9]+/.test(h)) {
    return true;
  }
  return false;
}

function isRhCurrentHeader(h: string): boolean {
  if (!h) return false;
  if (h.includes('%')) return false;
  if (
    h === 'rh' ||
    h === 'rh (n)' ||
    h === 'rh(n)' ||
    h === 'rh_n' ||
    h === 'rh_current' ||
    h === 'rh bulan berjalan' ||
    h === 'relatif harga'
  ) {
    return true;
  }
  if (/^rh[\s_(-]+[a-z0-9]+/.test(h)) {
    return true;
  }
  return false;
}

function findHeaderRow(rows: unknown[][], kind: UploadFileKind): {
  headerIndex: number;
  codeIdx: number;
  nameIdx: number;
  flagIdx: number;
  valueIdx: number;
  kuesIdx: number;
  regionCodeIdx: number;
  ihkIdx: number;
} {
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const row = rows[i].map((c) => String(c ?? '').trim().toLowerCase());
    const codeIdx = row.findIndex(
      (h) =>
        h === 'kode komoditas' ||
        h === 'kode_komoditas' ||
        h === 'kd komoditas' ||
        h === 'kd.komoditas' ||
        h === 'kode komoditi' ||
        h === 'kel' ||
        h === 'kode'
    );
    const nameIdx = row.findIndex(
      (h) =>
        h === 'nama komoditas' ||
        h === 'nama_komoditas' ||
        h === 'nama komoditi' ||
        h === 'kelompok' ||
        h === 'komoditas' ||
        h === 'komoditi'
    );
    const flagIdx = row.findIndex((h) => h === 'flag' || h === 'in');
    const kuesIdx = row.findIndex((h) => h === 'kuesioner');
    const regionCodeIdx = row.findIndex(
      (h) =>
        h === 'kode kota' ||
        h === 'kode_kota' ||
        h === 'kd.kota' ||
        h === 'kd kota' ||
        h === 'kdkota' ||
        h === 'kode wilayah' ||
        h === 'kode_wilayah'
    );
    const ihkIdx = row.findIndex(
      (h) => h === 'ihk' || h === 'ihk (n-1)' || h.startsWith('ihk ') || h.startsWith('ihk_')
    );

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
      valueIdx = row.findIndex((h) => isNkPrevHeader(h));
    } else {
      valueIdx = row.findIndex((h) => isRhCurrentHeader(h));
    }

    if ((codeIdx !== -1 || nameIdx !== -1) && valueIdx !== -1) {
      return { headerIndex: i, codeIdx, nameIdx, flagIdx, valueIdx, kuesIdx, regionCodeIdx, ihkIdx };
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
  options?: {
    fillEmptyRhWith100?: boolean;
    targetRegion?: KabKotaCode;
    syncPakomFromNk?: boolean;
  }
): UploadMappingResult {
  const fillEmptyRhWith100 = options?.fillEmptyRhWith100 ?? true;
  const targetRegion = options?.targetRegion;
  const syncPakomFromNk = kind === 'NK_PREV' && Boolean(options?.syncPakomFromNk);

  const {
    headerIndex,
    codeIdx,
    nameIdx,
    flagIdx,
    valueIdx,
    kuesIdx,
    regionCodeIdx,
    ihkIdx,
  } = findHeaderRow(rawRows, kind);

  // Scan region codes if column exists so we can validate/filter cleanly
  const detectedRegionSet = new Set<string>();
  if (regionCodeIdx >= 0) {
    for (let r = headerIndex + 1; r < rawRows.length; r++) {
      const cells = rawRows[r];
      if (!cells) continue;
      const rc = normalizeRegionCodeCell(cells[regionCodeIdx]);
      if (rc && /^\d{4}$/.test(rc)) {
        detectedRegionSet.add(rc);
      }
    }
  }
  const detectedRegionCodes = Array.from(detectedRegionSet).sort();

  if (targetRegion && detectedRegionCodes.length > 0 && !detectedRegionCodes.includes(targetRegion)) {
    throw new Error(
      `File ini berisi data wilayah ${detectedRegionCodes.join(', ')}, tidak sesuai dengan wilayah target aktif (${targetRegion}). Pilih wilayah yang sesuai pada filter di atas atau unggah file untuk ${targetRegion}.`
    );
  }

  const shouldFilterByRegion = Boolean(targetRegion && regionCodeIdx >= 0 && detectedRegionCodes.length > 0);

  const commodityNodes = allNodes.filter((n) => n.flag === 3);
  const byPaddedCode = new Map(commodityNodes.map((n) => [n.kode, n]));
  const byNormName = new Map(commodityNodes.map((n) => [normalizeName(n.nama), n]));
  const existingNodeMap = new Map(allNodes.map((n) => [n.kode, n]));

  const parsedRows: ParsedValueRow[] = [];
  const unmatchedRows: UnmatchedUploadRow[] = [];
  const changes: MappingChangePreview[] = [];
  const updatesMap: Record<string, number> = {};
  const derivedNk0Map: Record<string, number> = {};
  const newHierarchyNodes: HierarchyNodeMeta[] = [];
  const pakomCodes: string[] = [];
  const seenPakom = new Set<string>();
  let replacedEmptyCount = 0;

  // Capture Flag 1 & Flag 2 labels so new subkelompok/kelompok get proper names
  const extraGroupNames = new Map<string, { nama: string; flag: 1 | 2 }>();

  const ensureNodeInHierarchy = (
    normalizedCode: string,
    namaKomoditas: string,
    kuesioner?: string
  ): HierarchyNodeMeta => {
    const existingMeta = byPaddedCode.get(normalizedCode);
    if (existingMeta) return existingMeta;

    const alreadyQueued = newHierarchyNodes.find((n) => n.kode === normalizedCode);
    if (alreadyQueued) return alreadyQueued;

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

    const created: HierarchyNodeMeta = {
      kode: normalizedCode,
      lkKode: normalizedCode.replace(/^0+/, '') || normalizedCode,
      nama: namaKomoditas || `KOMODITAS ${normalizedCode}`,
      flag: 3,
      parentCode: subCode,
      kelompokCode: kelCode,
      subkelompokCode: subCode,
      kuesioner: kuesioner ?? null,
    };
    newHierarchyNodes.push(created);
    return created;
  };

  for (let r = headerIndex + 1; r < rawRows.length; r++) {
    const cells = rawRows[r];
    if (!cells || cells.every((c) => String(c ?? '').trim() === '')) continue;

    if (shouldFilterByRegion && targetRegion) {
      const rowRegion = normalizeRegionCodeCell(cells[regionCodeIdx]);
      if (rowRegion && rowRegion !== targetRegion) continue;
    }

    const rawCode = codeIdx >= 0 ? String(cells[codeIdx] ?? '').trim() : '';
    const namaKomoditas = nameIdx >= 0 ? String(cells[nameIdx] ?? '').trim() : '';
    const rawFlag = flagIdx >= 0 ? parseFlexibleNumber(cells[flagIdx]) : null;
    const rawVal = parseFlexibleNumber(cells[valueIdx]);
    const ihkVal = ihkIdx >= 0 ? parseFlexibleNumber(cells[ihkIdx]) : null;
    const kuesioner = kuesIdx >= 0 ? String(cells[kuesIdx] ?? '').trim() : undefined;

    if (!rawCode && !namaKomoditas) continue;

    const digitsOnly = rawCode.replace(/\.0+$/, '');
    const isSummaryFlag =
      (rawFlag !== null && rawFlag !== 3) ||
      (/^\d{1,3}$/.test(digitsOnly) && digitsOnly.length <= 3) ||
      namaKomoditas.toUpperCase() === 'UMUM' ||
      namaKomoditas.toUpperCase() === 'TOTAL';

    if (isSummaryFlag) {
      if ((kind === 'NK0' || syncPakomFromNk) && (rawFlag === 1 || rawFlag === 2) && digitsOnly) {
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

      const meta = ensureNodeInHierarchy(normalizedCode, namaKomoditas, kuesioner);
      const existingInput = currentInputs[normalizedCode];
      const oldValue = existingInput ? existingInput.nk0 : null;
      const newValue = effectiveVal;
      const diff = oldValue !== null ? newValue - oldValue : newValue;
      const diffPct = oldValue && oldValue !== 0 ? (diff / oldValue) * 100 : 0;

      updatesMap[normalizedCode] = newValue;
      const existingChangeIdx = changes.findIndex((c) => c.kode === normalizedCode);
      const entry: MappingChangePreview = {
        kode: normalizedCode,
        nama: meta.nama || namaKomoditas || normalizedCode,
        matchedBy: existingInput ? 'CODE' : 'NEW_PAKOM',
        oldValue,
        newValue,
        diff,
        diffPct,
        pakomStatus: existingInput ? 'TETAP' : 'BARU',
      };
      if (existingChangeIdx >= 0) changes[existingChangeIdx] = entry;
      else changes.push(entry);
      continue;
    }

    // NK_PREV or RH_CURRENT mapping
    let matchedNode = normalizedCode ? byPaddedCode.get(normalizedCode) : undefined;
    let matchedBy: 'CODE' | 'NAME' | 'NEW_PAKOM' = 'CODE';

    if (!matchedNode && namaKomoditas) {
      matchedNode = byNormName.get(normalizeName(namaKomoditas));
      matchedBy = 'NAME';
    }

    if (syncPakomFromNk && normalizedCode) {
      if (!matchedNode) {
        matchedNode = ensureNodeInHierarchy(normalizedCode, namaKomoditas, kuesioner);
        matchedBy = 'NEW_PAKOM';
      }
      if (!seenPakom.has(matchedNode.kode)) {
        seenPakom.add(matchedNode.kode);
        pakomCodes.push(matchedNode.kode);
      }
      const existingInput = currentInputs[matchedNode.kode];
      const derivedNk0 =
        existingInput?.nk0 ??
        (ihkVal !== null && ihkVal > 0 ? Number(((effectiveVal / ihkVal) * 100).toFixed(2)) : effectiveVal);
      derivedNk0Map[matchedNode.kode] = derivedNk0;

      const oldValue = existingInput ? existingInput.nkPrev : null;
      const newValue = effectiveVal;
      const diff = oldValue !== null ? newValue - oldValue : newValue;
      const diffPct = oldValue && oldValue !== 0 ? (diff / oldValue) * 100 : 0;

      updatesMap[matchedNode.kode] = newValue;
      const existingChangeIdx = changes.findIndex((c) => c.kode === matchedNode!.kode);
      const entry: MappingChangePreview = {
        kode: matchedNode.kode,
        nama: matchedNode.nama,
        matchedBy: existingInput ? matchedBy : 'NEW_PAKOM',
        oldValue,
        newValue,
        diff,
        diffPct,
        pakomStatus: existingInput ? 'TETAP' : 'BARU',
      };
      if (existingChangeIdx >= 0) changes[existingChangeIdx] = entry;
      else changes.push(entry);
      continue;
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
    const existingChangeIdx = changes.findIndex((c) => c.kode === matchedNode!.kode);
    const entry: MappingChangePreview = {
      kode: matchedNode.kode,
      nama: matchedNode.nama,
      matchedBy,
      oldValue,
      newValue,
      diff,
      diffPct,
      ...(replacedEmpty ? { replacedEmpty: true } : {}),
    };
    if (existingChangeIdx >= 0) changes[existingChangeIdx] = entry;
    else changes.push(entry);
  }

  let addedToPakomCount = 0;
  let removedFromPakomCount = 0;
  if (kind === 'NK0' || syncPakomFromNk) {
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
          oldValue: kind === 'NK0' ? row.nk0 : row.nkPrev,
          newValue: 0,
          diff: -(kind === 'NK0' ? row.nk0 : row.nkPrev),
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
    ...(detectedRegionCodes.length > 0 ? { detectedRegionCodes } : {}),
    ...(shouldFilterByRegion && targetRegion ? { filteredRegionCode: targetRegion } : {}),
    ...(kind === 'RH_CURRENT' ? { replacedEmptyCount } : {}),
    ...(kind === 'NK0' || syncPakomFromNk
      ? {
          pakomCodes,
          addedToPakomCount,
          removedFromPakomCount,
          newHierarchyNodes,
          ...(syncPakomFromNk ? { derivedNk0Map } : {}),
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
    ...(currentMapping?.detectedRegionCodes
      ? { detectedRegionCodes: currentMapping.detectedRegionCodes }
      : {}),
    ...(currentMapping?.filteredRegionCode
      ? { filteredRegionCode: currentMapping.filteredRegionCode }
      : {}),
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

function weightedGeometricMean(items: Array<{ val: number | null; weight: number }>): number | null {
  const valid = items.filter(
    (item): item is { val: number; weight: number } =>
      item.val !== null && Number.isFinite(item.val) && item.val > 0
  );
  if (valid.length === 0) return null;

  const positiveWeighted = valid.filter((item) => Number.isFinite(item.weight) && item.weight > 0);
  if (positiveWeighted.length === 0) {
    return geometricMean(valid.map((item) => item.val));
  }

  const totalWeight = positiveWeighted.reduce((acc, item) => acc + item.weight, 0);
  if (totalWeight <= 0) {
    return geometricMean(valid.map((item) => item.val));
  }

  const weightedLogSum = positiveWeighted.reduce(
    (acc, item) => acc + (item.weight / totalWeight) * Math.log(item.val),
    0
  );
  return Math.exp(weightedLogSum);
}

export function parseRespondentObservations(
  rawRows: unknown[][],
  frequency: RespondentFrequency,
  targetRegion?: KabKotaCode
): RespondentPriceObservation[] {
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rawRows.length, 15); i++) {
    const row = rawRows[i].map((c) => String(c ?? '').trim().toLowerCase());
    if (
      (row.includes('kode komoditas') || row.includes('kd komoditas')) &&
      row.includes('nama responden')
    ) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    throw new Error('Header template harga responden (Kode Komoditas / Nama Responden) tidak ditemukan.');
  }

  const headers = rawRows[headerIdx].map((c) => String(c ?? '').trim());
  const idx = (names: string | string[]) => {
    const candidates = Array.isArray(names) ? names : [names];
    return headers.findIndex((h) => candidates.some((c) => h.toLowerCase() === c.toLowerCase()));
  };

  const colRegion = idx(['Kode Kota', 'Kode_Kota', 'Kd.Kota', 'Kd Kota', 'Kode Wilayah']);
  const colKode = idx(['Kode Komoditas', 'Kd Komoditas', 'Kode_Komoditas']);
  const colKomoditas = idx(['Komoditas', 'Nama Komoditas', 'Komoditi']);
  const colKodeKual = idx(['Kode Kualitas', 'Kd Kualitas']);
  const colBobotKual = idx('Bobot Kualitas');
  const colKual = idx('Kualitas');
  const colBobotJenis = idx('Bobot Jenis Pasar');
  const colJenis = idx('Jenis Pasar');
  const colBobotPasar = idx('Bobot Pasar');
  const colPasar = idx('Pasar');
  const colResp = idx('Nama Responden');

  // Optional region verification & filtering if Kode Kota column exists
  let shouldFilterByRegion = false;
  if (colRegion >= 0 && targetRegion) {
    const regionCodes = new Set<string>();
    for (let r = headerIdx + 1; r < rawRows.length; r++) {
      const rc = normalizeRegionCodeCell(rawRows[r]?.[colRegion]);
      if (rc && /^\d{4}$/.test(rc)) regionCodes.add(rc);
    }
    if (regionCodes.size > 0) {
      if (!regionCodes.has(targetRegion)) {
        throw new Error(
          `File responden ini berisi data wilayah ${Array.from(regionCodes).join(', ')}, tidak cocok dengan wilayah aktif (${targetRegion}).`
        );
      }
      shouldFilterByRegion = true;
    }
  }

  const priceStartIdx = colResp + 1;
  const priceColsPerPeriod = frequency === 'MINGGUAN' ? 5 : frequency === 'DWIMINGGUAN' ? 2 : 1;

  const observations: RespondentPriceObservation[] = [];

  for (let r = headerIdx + 1; r < rawRows.length; r++) {
    const row = rawRows[r];
    if (!row || row.every((c) => String(c ?? '').trim() === '')) continue;

    if (shouldFilterByRegion && targetRegion && colRegion >= 0) {
      const rc = normalizeRegionCodeCell(row[colRegion]);
      if (rc && rc !== targetRegion) continue;
    }

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

/**
 * BPS Hierarchical Geometric Mean RH Aggregation:
 * Respondent RH -> Pasar (geom mean) -> Jenis Pasar (weighted by Bobot Pasar)
 * -> Kualitas (weighted by Bobot Jenis Pasar) -> Komoditas (weighted by Bobot Kualitas).
 * At each weighted level, falls back to equal geometric mean only if all weights in that group are 0.
 */
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
    const qualities = new Set(list.map((o) => o.kodeKualitas || o.kualitas));

    // Group Level 1: Kualitas
    const byKualitas = new Map<string, { weight: number; items: RespondentPriceObservation[] }>();
    for (const o of list) {
      const kKey = o.kodeKualitas || o.kualitas || 'DEFAULT';
      const entry = byKualitas.get(kKey) ?? { weight: o.bobotKualitas, items: [] };
      if (o.bobotKualitas > 0 && entry.weight <= 0) entry.weight = o.bobotKualitas;
      entry.items.push(o);
      byKualitas.set(kKey, entry);
    }

    const kualitasEntries: Array<{ val: number | null; weight: number }> = [];
    for (const kualGroup of byKualitas.values()) {
      // Group Level 2: Jenis Pasar
      const byJenis = new Map<string, { weight: number; items: RespondentPriceObservation[] }>();
      for (const o of kualGroup.items) {
        const jKey = o.jenisPasar || 'DEFAULT';
        const entry = byJenis.get(jKey) ?? { weight: o.bobotJenisPasar, items: [] };
        if (o.bobotJenisPasar > 0 && entry.weight <= 0) entry.weight = o.bobotJenisPasar;
        entry.items.push(o);
        byJenis.set(jKey, entry);
      }

      const jenisEntries: Array<{ val: number | null; weight: number }> = [];
      for (const jenisGroup of byJenis.values()) {
        // Group Level 3: Pasar
        const byPasar = new Map<string, { weight: number; items: RespondentPriceObservation[] }>();
        for (const o of jenisGroup.items) {
          const pKey = o.pasar || 'DEFAULT';
          const entry = byPasar.get(pKey) ?? { weight: o.bobotPasar, items: [] };
          if (o.bobotPasar > 0 && entry.weight <= 0) entry.weight = o.bobotPasar;
          entry.items.push(o);
          byPasar.set(pKey, entry);
        }

        const pasarEntries: Array<{ val: number | null; weight: number }> = [];
        for (const pasarGroup of byPasar.values()) {
          const pasarRh = geometricMean(
            pasarGroup.items
              .map((o) => o.priceRelative)
              .filter((v): v is number => v !== null && v > 0)
          );
          pasarEntries.push({ val: pasarRh, weight: pasarGroup.weight });
        }

        jenisEntries.push({
          val: weightedGeometricMean(pasarEntries),
          weight: jenisGroup.weight,
        });
      }

      kualitasEntries.push({
        val: weightedGeometricMean(jenisEntries),
        weight: kualGroup.weight,
      });
    }

    const calculatedRH = weightedGeometricMean(kualitasEntries);

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
