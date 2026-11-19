import React, { useState } from 'react';
import { Lock } from 'lucide-react';
import type { AuthSession, RegionCode } from '../types/inflasi';
import {
  authenticateUser,
  LOGIN_ACCOUNTS,
  resolveAccountFromUsername,
} from '../utils/authSession';

interface LoginLandingViewProps {
  onLoginSuccess: (session: AuthSession) => void;
}

export const LoginLandingView: React.FC<LoginLandingViewProps> = ({ onLoginSuccess }) => {
  const [selectedCode, setSelectedCode] = useState<RegionCode>('6100');
  const [username, setUsername] = useState<string>('admin6100');
  const [password, setPassword] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleSelectRole = (code: RegionCode) => {
    setSelectedCode(code);
    const acc = LOGIN_ACCOUNTS.find((a) => a.regionCode === code);
    if (acc) setUsername(acc.defaultUsername);
    setErrorMsg(null);
  };

  const handleUsernameChange = (val: string) => {
    setUsername(val);
    const matched = resolveAccountFromUsername(val);
    if (matched) setSelectedCode(matched.regionCode);
    setErrorMsg(null);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const res = authenticateUser(username, password, selectedCode);
    if (!res.ok) {
      setErrorMsg(res.error);
      return;
    }
    onLoginSuccess(res.session);
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-7">
          <h1 className="text-2xl font-extrabold tracking-tight text-slate-900">
            Monitoring Inflasi IHK Kalbar
          </h1>
        </div>

        <form
          onSubmit={handleSubmit}
          className="rounded-lg border border-slate-200 bg-white p-6 space-y-4"
        >
          <div>
            <label
              htmlFor="login-role"
              className="block text-xs font-semibold text-slate-700 mb-1.5"
            >
              Akses Wilayah
            </label>
            <select
              id="login-role"
              value={selectedCode}
              onChange={(e) => handleSelectRole(e.target.value as RegionCode)}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 focus:border-slate-900 focus:outline-none"
            >
              {LOGIN_ACCOUNTS.map((acc) => (
                <option key={acc.regionCode} value={acc.regionCode}>
                  {acc.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="login-username"
              className="block text-xs font-semibold text-slate-700 mb-1.5"
            >
              ID Pengguna
            </label>
            <input
              id="login-username"
              type="text"
              value={username}
              onChange={(e) => handleUsernameChange(e.target.value)}
              autoComplete="username"
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-mono text-slate-900 focus:border-slate-900 focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor="login-password"
              className="block text-xs font-semibold text-slate-700 mb-1.5"
            >
              Kata Sandi
            </label>
            <input
              id="login-password"
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setErrorMsg(null);
              }}
              autoComplete="current-password"
              placeholder="••••••••"
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
            />
          </div>

          {errorMsg && (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700">
              {errorMsg}
            </div>
          )}

          <button
            type="submit"
            className="w-full inline-flex items-center justify-center gap-2 rounded-md bg-slate-900 px-4 py-2.5 text-sm font-bold text-white hover:bg-slate-800 transition-colors"
          >
            <Lock className="h-4 w-4" />
            <span>Masuk</span>
          </button>
        </form>
      </div>
    </div>
  );
};
