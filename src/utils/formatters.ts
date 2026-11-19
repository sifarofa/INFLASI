export function formatNumber(val: number, decimals = 2): string {
  if (!Number.isFinite(val)) return '—';
  return new Intl.NumberFormat('id-ID', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(val);
}

export function formatNK(val: number): string {
  if (!Number.isFinite(val)) return '—';
  return new Intl.NumberFormat('id-ID', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(val);
}

export function formatNKCompact(val: number): string {
  if (!Number.isFinite(val)) return '—';
  const abs = Math.abs(val);
  if (abs >= 1e12) return `${formatNumber(val / 1e12, 2)} T`;
  if (abs >= 1e9) return `${formatNumber(val / 1e9, 2)} M`;
  if (abs >= 1e6) return `${formatNumber(val / 1e6, 2)} Jt`;
  return formatNK(val);
}

export function formatIndex(val: number, decimals = 2): string {
  if (!Number.isFinite(val)) return '—';
  return new Intl.NumberFormat('id-ID', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(val);
}

export function formatSignedPct(val: number, decimals = 2): string {
  if (!Number.isFinite(val)) return '—';
  const rounded = Math.abs(val) < Math.pow(10, -(decimals + 2)) ? 0 : val;
  const sign = rounded > 0 ? '+' : '';
  return `${sign}${formatNumber(rounded, decimals)}%`;
}

export function formatAndil(val: number, decimals = 4): string {
  if (!Number.isFinite(val)) return '—';
  const rounded = Math.abs(val) < 1e-9 ? 0 : val;
  const sign = rounded > 0 ? '+' : '';
  return `${sign}${formatNumber(rounded, decimals)}`;
}
