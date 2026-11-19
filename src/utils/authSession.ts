import type { AuthSession, RegionCode } from '../types/inflasi';
import { REGIONS } from '../data/regions';

const AUTH_STORAGE_KEY = 'kalbar_ihk_auth_session_v1';

export interface LoginAccountOption {
  regionCode: RegionCode;
  role: 'PROVINSI' | 'KABKOTA';
  defaultUsername: string;
  label: string;
}

export const LOGIN_ACCOUNTS: LoginAccountOption[] = [
  {
    regionCode: '6100',
    role: 'PROVINSI',
    defaultUsername: 'admin6100',
    label: 'Admin Provinsi — Kalimantan Barat (6100)',
  },
  ...REGIONS.filter((r) => !r.isAggregated).map((r) => ({
    regionCode: r.code,
    role: 'KABKOTA' as const,
    defaultUsername: `admin${r.code}`,
    label: `Admin Kab/Kota — ${r.name} (${r.code})`,
  })),
];

const USERNAME_ALIAS_MAP: Record<string, RegionCode> = {
  '6100': '6100',
  admin6100: '6100',
  provinsi: '6100',
  kalbar: '6100',
  '6106': '6106',
  admin6106: '6106',
  ketapang: '6106',
  '6107': '6107',
  admin6107: '6107',
  sintang: '6107',
  '6111': '6111',
  admin6111: '6111',
  kku: '6111',
  kayong: '6111',
  kayongutara: '6111',
  '6171': '6171',
  admin6171: '6171',
  pontianak: '6171',
  '6172': '6172',
  admin6172: '6172',
  singkawang: '6172',
};

export function resolveAccountFromUsername(rawUsername: string): LoginAccountOption | null {
  const norm = rawUsername.trim().toLowerCase().replace(/\s+/g, '');
  const code = USERNAME_ALIAS_MAP[norm];
  if (!code) return null;
  return LOGIN_ACCOUNTS.find((a) => a.regionCode === code) ?? null;
}

export function authenticateUser(
  rawUsername: string,
  password: string,
  selectedAccountCode?: RegionCode
): { ok: true; session: AuthSession } | { ok: false; error: string } {
  const trimmedUser = rawUsername.trim();
  const trimmedPass = password.trim();

  const resolved =
    (trimmedUser ? resolveAccountFromUsername(trimmedUser) : null) ??
    (selectedAccountCode
      ? LOGIN_ACCOUNTS.find((a) => a.regionCode === selectedAccountCode) ?? null
      : null);

  if (!resolved) {
    return { ok: false, error: 'ID Pengguna atau wilayah tidak dikenali.' };
  }

  if (!trimmedPass) {
    return { ok: false, error: 'Kata sandi wajib diisi.' };
  }

  const reg = REGIONS.find((r) => r.code === resolved.regionCode);
  const displayLabel =
    resolved.role === 'PROVINSI'
      ? 'Admin Provinsi (6100)'
      : `Admin ${reg?.shortName ?? resolved.regionCode} (${resolved.regionCode})`;

  return {
    ok: true,
    session: {
      role: resolved.role,
      regionCode: resolved.regionCode,
      username: trimmedUser || resolved.defaultUsername,
      displayLabel,
      loggedInAt: new Date().toISOString(),
    },
  };
}

export function loadStoredSession(): AuthSession | null {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthSession;
    if (!parsed || !parsed.role || !parsed.regionCode) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveStoredSession(session: AuthSession): void {
  try {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Ignore storage errors
  }
}

export function clearStoredSession(): void {
  try {
    localStorage.removeItem(AUTH_STORAGE_KEY);
  } catch {
    // Ignore storage errors
  }
}
