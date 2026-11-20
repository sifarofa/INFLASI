import { useState } from 'react';
import {
  BarChart3,
  ChevronDown,
  Database,
  Download,
  FileSpreadsheet,
  HardDrive,
  Loader2,
  LogOut,
  Menu,
  RotateCcw,
  Table2,
  Trophy,
  UploadCloud,
  Users,
  X,
} from 'lucide-react';
import type { AuthSession, KabKotaCode, RegionCode } from './types/inflasi';
import { BULAN_OPTIONS, formatPeriodLabel, REGIONS } from './data/regions';
import { useInflationStore } from './hooks/useInflationStore';
import { clearStoredSession } from './utils/authSession';
import { exportAllRegionsWorkbook, exportSingleRegionWorkbook } from './utils/excelExporter';
import { LoginLandingView } from './components/LoginLandingView';
import { DashboardView } from './components/DashboardView';
import { LembarKerjaView } from './components/LembarKerjaView';
import { UpdateDataView } from './components/UpdateDataView';
import { RespondentRHView } from './components/RespondentRHView';
import { AngkaSementaraRankingView } from './components/AngkaSementaraRankingView';

type ActiveTab = 'dashboard' | 'lk' | 'update' | 'responden' | 'ranking';

export default function App() {
  const {
    period,
    kabKotaInputs,
    nk0Meta,
    allNodes,
    history,
    respondentDatasets,
    results,
    jejerRows,
    connectionStatus,
    supabaseError,
    availablePeriods,
    currentPeriodHasSupabaseData,
    setPeriod,
    applyMonthlyUpload,
    updateCommodityInput,
    rolloverPrevMonthNK,
    setRespondentDataset,
    updateRespondentAnnotation,
    updateRespondentPrice,
    resetRespondentPrice,
    resetToInitialData,
  } = useInflationStore();

  const [session, setSession] = useState<AuthSession | null>(() => {
    clearStoredSession();
    return null;
  });
  const [activeTab, setActiveTab] = useState<ActiveTab>('dashboard');
  const [selectedRegion, setSelectedRegion] = useState<RegionCode>('6100');
  const [lastKabKota, setLastKabKota] = useState<KabKotaCode>('6107');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [confirmResetOpen, setConfirmResetOpen] = useState(false);

  const handleLoginSuccess = (newSession: AuthSession) => {
    setSession(newSession);
    setSelectedRegion(newSession.regionCode);
    if (newSession.regionCode !== '6100') {
      setLastKabKota(newSession.regionCode as KabKotaCode);
    }
    setActiveTab('dashboard');
    setSidebarOpen(false);
    setExportMenuOpen(false);
    setConfirmResetOpen(false);
  };

  const handleLogout = () => {
    clearStoredSession();
    setSession(null);
    setSidebarOpen(false);
    setExportMenuOpen(false);
    setConfirmResetOpen(false);
  };

  if (!session) {
    return <LoginLandingView onLoginSuccess={handleLoginSuccess} />;
  }

  const isProvinsi = session.role === 'PROVINSI';

  const navItems: Array<{
    id: ActiveTab;
    label: string;
    subtitle: string;
    icon: typeof BarChart3;
  }> = isProvinsi
    ? [
        {
          id: 'dashboard',
          label: 'Dashboard',
          subtitle: 'Ringkasan & Tabel Jejer',
          icon: BarChart3,
        },
        {
          id: 'lk',
          label: 'Lembar Kerja',
          subtitle: 'Rincian IHK per Wilayah',
          icon: Table2,
        },
        {
          id: 'update',
          label: 'Update Data',
          subtitle: 'Unggah NK0, NK & RH',
          icon: UploadCloud,
        },
        {
          id: 'responden',
          label: 'RH Responden',
          subtitle: 'Harga Tingkat Responden',
          icon: Users,
        },
        {
          id: 'ranking',
          label: 'Ranking INF(MoM)',
          subtitle: 'Angka Sementara & Kalbar',
          icon: Trophy,
        },
      ]
    : [
        {
          id: 'dashboard',
          label: 'Dashboard',
          subtitle: 'Ringkasan Inflasi Wilayah',
          icon: BarChart3,
        },
        {
          id: 'lk',
          label: 'Lembar Kerja',
          subtitle: 'Rincian IHK Wilayah',
          icon: Table2,
        },
        {
          id: 'responden',
          label: 'RH Responden',
          subtitle: 'Data Responden Wilayah',
          icon: Users,
        },
      ];

  // Enforce RBAC guard on active tab for KABKOTA role
  const safeTab: ActiveTab =
    !isProvinsi && (activeTab === 'update' || activeTab === 'ranking')
      ? 'dashboard'
      : activeTab;

  const isKabKotaScopedTab = safeTab === 'update' || safeTab === 'responden';

  // Single Source of Truth for active region across top toolbar + active view
  const effectiveRegion: RegionCode = !isProvinsi
    ? session.regionCode
    : isKabKotaScopedTab && selectedRegion === '6100'
    ? lastKabKota
    : selectedRegion;

  const effectiveKabKota: KabKotaCode =
    effectiveRegion === '6100' ? lastKabKota : (effectiveRegion as KabKotaCode);

  const activeNavMeta = navItems.find((item) => item.id === safeTab) ?? navItems[0];

  const handleSelectRegion = (code: RegionCode) => {
    if (!isProvinsi) return;
    setSelectedRegion(code);
    if (code !== '6100') {
      setLastKabKota(code as KabKotaCode);
    }
  };

  const handleOpenLK = (code: RegionCode) => {
    if (isProvinsi) {
      setSelectedRegion(code);
      if (code !== '6100') setLastKabKota(code as KabKotaCode);
    } else {
      setSelectedRegion(session.regionCode);
    }
    setActiveTab('lk');
    setSidebarOpen(false);
  };

  const handleSelectTab = (tabId: ActiveTab) => {
    if (!isProvinsi && (tabId === 'update' || tabId === 'ranking')) {
      setActiveTab('dashboard');
      setSidebarOpen(false);
      return;
    }
    if (isProvinsi && (tabId === 'update' || tabId === 'responden') && selectedRegion === '6100') {
      setSelectedRegion(lastKabKota);
    }
    setActiveTab(tabId);
    setSidebarOpen(false);
  };

  const topbarRegionOptions = isKabKotaScopedTab
    ? REGIONS.filter((r) => !r.isAggregated)
    : REGIONS;

  const sidebarContent = (
    <div className="flex h-full flex-col bg-slate-900 text-slate-100">
      {/* Sidebar Brand Header */}
      <div className="flex h-14 items-center justify-between border-b border-slate-800 px-4">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="h-7 px-2 rounded bg-sky-600 text-white inline-flex items-center justify-center font-mono text-xs font-extrabold tracking-tight shrink-0">
            {session.regionCode}
          </span>
          <div className="min-w-0">
            <div className="text-sm font-extrabold text-white tracking-tight truncate">
              IHK Kalbar
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setSidebarOpen(false)}
          className="lg:hidden rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
          aria-label="Tutup menu"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Navigation Links */}
      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1" aria-label="Menu Utama">
        <div className="px-3 pb-1.5 text-[11px] font-semibold text-slate-400">
          Menu Navigasi
        </div>
        {navItems.map((tab) => {
          const Icon = tab.icon;
          const isActive = safeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => handleSelectTab(tab.id)}
              className={`w-full flex items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors ${
                isActive
                  ? 'bg-sky-600 text-white'
                  : 'text-slate-300 hover:bg-slate-800 hover:text-white'
              }`}
            >
              <Icon className={`h-4 w-4 shrink-0 ${isActive ? 'text-white' : 'text-slate-400'}`} />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-bold whitespace-nowrap truncate">{tab.label}</div>
                <div
                  className={`text-[11px] whitespace-nowrap truncate ${
                    isActive ? 'text-sky-100' : 'text-slate-400'
                  }`}
                >
                  {tab.subtitle}
                </div>
              </div>
            </button>
          );
        })}
      </nav>

      {/* Account & Logout Footer */}
      <div className="border-t border-slate-800 p-4 space-y-3">
        <div className="min-w-0">
          <div className="text-xs font-bold text-white truncate">{session.displayLabel}</div>
          <div className="text-[11px] text-slate-400 font-mono truncate">
            {session.username} · {session.role}
          </div>
        </div>
        <button
          type="button"
          onClick={handleLogout}
          className="w-full inline-flex items-center justify-center gap-2 rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-700 hover:text-white transition-colors"
        >
          <LogOut className="h-3.5 w-3.5" />
          <span>Keluar Akun</span>
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex">
      {/* Desktop Fixed Sidebar */}
      <aside className="hidden lg:block w-64 shrink-0 border-r border-slate-200 bg-slate-900">
        <div className="sticky top-0 h-screen">{sidebarContent}</div>
      </aside>

      {/* Mobile Slide-Over Sidebar */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-900/50"
            onClick={() => setSidebarOpen(false)}
            aria-hidden="true"
          />
          <aside className="relative w-64 max-w-[80vw] h-full z-10 shadow-xl">
            {sidebarContent}
          </aside>
        </div>
      )}

      {/* Right Workspace Column */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top Context Header: Breadcrumb + Period Selector + Connection Badge + Actions */}
        <header className="sticky top-0 z-30 min-h-14 border-b border-slate-200 bg-white">
          <div className="px-4 sm:px-6 py-2 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <button
                type="button"
                onClick={() => setSidebarOpen(true)}
                className="lg:hidden rounded-md border border-slate-300 bg-white p-1.5 text-slate-700 hover:bg-slate-50"
                aria-label="Buka menu sidebar"
              >
                <Menu className="h-4 w-4" />
              </button>

              <div className="min-w-0">
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <span className="font-semibold text-slate-700 whitespace-nowrap">
                    Monitoring Inflasi IHK Kalbar
                  </span>
                  <span aria-hidden="true">/</span>
                  <span className="font-bold text-slate-900 whitespace-nowrap truncate">
                    {activeNavMeta.label}
                  </span>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2.5 shrink-0 relative">
              {/* Pemilih Periode Aktif (Bulan & Tahun) di Header Utama */}
              <div className="flex items-center gap-1.5">
                <label htmlFor="global-month" className="text-xs font-semibold text-slate-500 whitespace-nowrap">
                  Periode:
                </label>
                <select
                  id="global-month"
                  value={period.month}
                  onChange={(e) => setPeriod({ ...period, month: Number(e.target.value) })}
                  className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-bold text-slate-900 focus:border-slate-900 focus:outline-none"
                >
                  {BULAN_OPTIONS.map((b) => (
                    <option key={b.value} value={b.value}>
                      {b.label}
                    </option>
                  ))}
                </select>
                <input
                  aria-label="Tahun periode"
                  type="number"
                  min={2020}
                  max={2035}
                  value={period.year}
                  onChange={(e) =>
                    setPeriod({ ...period, year: Number(e.target.value) || period.year })
                  }
                  className="w-16 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-mono font-bold text-slate-900 tabular-nums focus:border-slate-900 focus:outline-none"
                />
              </div>

              {/* Badge Status Koneksi Supabase / Mode Lokal */}
              <div
                title={
                  connectionStatus === 'connected'
                    ? 'Tersinkronisasi langsung dengan Supabase (inflasi_lk_data, inflasi_upload_logs, inflasi_harga_responden)'
                    : connectionStatus === 'syncing'
                    ? 'Sedang menyinkronkan data dengan Supabase...'
                    : supabaseError ?? 'Berjalan pada Mode Lokal (VITE_SUPABASE_URL belum diatur)'
                }
                className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-semibold whitespace-nowrap shrink-0 ${
                  connectionStatus === 'connected'
                    ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                    : connectionStatus === 'syncing'
                    ? 'border-sky-300 bg-sky-50 text-sky-800'
                    : 'border-amber-300 bg-amber-50 text-amber-800'
                }`}
              >
                {connectionStatus === 'connected' ? (
                  <>
                    <Database className="h-3.5 w-3.5 text-emerald-700 shrink-0" />
                    <span>Supabase Terhubung</span>
                  </>
                ) : connectionStatus === 'syncing' ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 text-sky-700 animate-spin shrink-0" />
                    <span>Sinkronisasi...</span>
                  </>
                ) : (
                  <>
                    <HardDrive className="h-3.5 w-3.5 text-amber-700 shrink-0" />
                    <span>Mode Lokal</span>
                  </>
                )}
              </div>

              {isProvinsi && safeTab !== 'ranking' && (
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => {
                      setExportMenuOpen(false);
                      setConfirmResetOpen((v) => !v);
                    }}
                    className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                    title="Reset ke Data Awal"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    <span className="hidden md:inline">Reset</span>
                  </button>

                  {confirmResetOpen && (
                    <div className="absolute right-0 mt-2 w-72 rounded-lg border border-slate-200 bg-white p-3.5 shadow-lg z-40">
                      <p className="text-xs font-bold text-slate-900">
                        Reset seluruh data ke baseline awal?
                      </p>
                      <p className="mt-1 text-[11px] text-slate-500">
                        Semua unggahan NK0/NK/RH dan edit manual akan dikembalikan ke data awal.
                      </p>
                      <div className="mt-3 flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setConfirmResetOpen(false)}
                          className="rounded border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        >
                          Batal
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            resetToInitialData();
                            setConfirmResetOpen(false);
                          }}
                          className="rounded bg-rose-700 px-2.5 py-1 text-xs font-semibold text-white hover:bg-rose-800"
                        >
                          Ya, Reset
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {safeTab !== 'ranking' && (
                <div className="relative">
                  {isProvinsi ? (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setConfirmResetOpen(false);
                          setExportMenuOpen((v) => !v);
                        }}
                        className="inline-flex items-center gap-1.5 rounded-md bg-sky-700 px-3 py-1 text-xs font-bold text-white hover:bg-sky-800 whitespace-nowrap"
                      >
                        <Download className="h-3.5 w-3.5" />
                        <span>Export Excel</span>
                        <ChevronDown className="h-3.5 w-3.5 opacity-80" />
                      </button>

                      {exportMenuOpen && (
                        <div className="absolute right-0 mt-2 w-64 rounded-lg border border-slate-200 bg-white py-1.5 shadow-lg z-40">
                          <button
                            type="button"
                            onClick={() => {
                              exportAllRegionsWorkbook(results, period);
                              setExportMenuOpen(false);
                            }}
                            className="w-full px-3.5 py-2 text-left text-xs hover:bg-slate-50 flex items-start gap-2.5"
                          >
                            <FileSpreadsheet className="h-4 w-4 text-emerald-700 shrink-0 mt-0.5" />
                            <div>
                              <p className="font-semibold text-slate-900">
                                Semua Wilayah (Multi-Sheet)
                              </p>
                              <p className="text-[11px] text-slate-500">
                                Ringkasan + 6100 + 5 Kab/Kota (.xlsx)
                              </p>
                            </div>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              exportSingleRegionWorkbook(results[effectiveRegion], period);
                              setExportMenuOpen(false);
                            }}
                            className="w-full px-3.5 py-2 text-left text-xs hover:bg-slate-50 flex items-start gap-2.5 border-t border-slate-100"
                          >
                            <FileSpreadsheet className="h-4 w-4 text-sky-700 shrink-0 mt-0.5" />
                            <div>
                              <p className="font-semibold text-slate-900">
                                Wilayah Aktif ({effectiveRegion})
                              </p>
                              <p className="text-[11px] text-slate-500">
                                {results[effectiveRegion].regionName} (.xlsx)
                              </p>
                            </div>
                          </button>
                        </div>
                      )}
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => exportSingleRegionWorkbook(results[effectiveRegion], period)}
                      className="inline-flex items-center gap-1.5 rounded-md bg-sky-700 px-3 py-1 text-xs font-bold text-white hover:bg-sky-800 whitespace-nowrap"
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>Export LK {effectiveRegion}</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Single Unified Context Toolbar (Source of truth for active Wilayah across Dashboard, LK, Update Data & Responden) */}
        {safeTab !== 'ranking' && (
          <div className="border-b border-slate-200 bg-white">
            <div className="px-4 sm:px-6 py-2 flex flex-wrap items-center justify-between gap-3 text-xs">
              <div className="flex flex-wrap items-center gap-2.5 text-slate-600 font-medium">
                <span>
                  Periode: <strong className="font-bold text-slate-900">{formatPeriodLabel(period)}</strong>
                </span>
                <span className="text-slate-300">·</span>
                <span>
                  Wilayah:{' '}
                  <strong className="font-mono font-bold text-slate-900">{effectiveRegion}</strong>{' '}
                  <strong className="font-bold text-slate-900">
                    {results[effectiveRegion].regionName}
                  </strong>
                </span>
                {connectionStatus === 'connected' && availablePeriods.length > 0 && (
                  <>
                    <span className="text-slate-300">·</span>
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                      <span className="text-slate-500">Data di DB:</span>
                      {availablePeriods.map((p) => {
                        const isActive = p.year === period.year && p.month === period.month;
                        return (
                          <button
                            key={`db-period-${p.year}-${p.month}`}
                            type="button"
                            onClick={() => setPeriod(p)}
                            className={`rounded px-2 py-0.5 text-[11px] font-bold transition-colors ${
                              isActive
                                ? 'bg-emerald-100 text-emerald-900 border border-emerald-300'
                                : 'bg-slate-100 text-slate-700 border border-slate-200 hover:bg-slate-200'
                            }`}
                          >
                            {formatPeriodLabel(p)}
                          </button>
                        );
                      })}
                    </span>
                  </>
                )}
              </div>

              {isProvinsi && (
                <div className="flex items-center gap-2">
                  <label htmlFor="global-region" className="text-xs font-semibold text-slate-500">
                    Wilayah Aktif:
                  </label>
                  <select
                    id="global-region"
                    value={effectiveRegion}
                    onChange={(e) => handleSelectRegion(e.target.value as RegionCode)}
                    className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-bold text-slate-900 focus:border-slate-900 focus:outline-none"
                  >
                    {topbarRegionOptions.map((r) => (
                      <option key={r.code} value={r.code}>
                        {r.code} — {r.shortName}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          </div>
        )}

        {safeTab !== 'ranking' &&
          connectionStatus === 'connected' &&
          currentPeriodHasSupabaseData === false &&
          availablePeriods.length > 0 && (
            <div className="border-b border-amber-200 bg-amber-50/90 px-4 sm:px-6 py-2.5 text-xs text-amber-950 flex flex-wrap items-center justify-between gap-2">
              <div>
                <strong>Periode {formatPeriodLabel(period)} belum memiliki data tersimpan di Supabase</strong>{' '}
                (hanya menampilkan kerangka Pakom NK0 dengan RH = 100 / Inflasi 0,00%). Klik periode
                berikut untuk membuka data yang sudah diunggah:
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {availablePeriods.map((p) => (
                  <button
                    key={`jump-period-${p.year}-${p.month}`}
                    type="button"
                    onClick={() => setPeriod(p)}
                    className="rounded-md bg-amber-900 px-2.5 py-1 text-xs font-bold text-white hover:bg-amber-950 transition-colors"
                  >
                    Buka {formatPeriodLabel(p)}
                  </button>
                ))}
              </div>
            </div>
          )}

        {/* Main Viewport */}
        <main className="w-full flex-1 px-3 sm:px-5 py-5">
          {safeTab === 'dashboard' && (
            <DashboardView
              results={results}
              jejerRows={jejerRows}
              period={period}
              selectedRegion={effectiveRegion}
              userRole={session.role}
              allowedRegion={session.regionCode}
              onSelectRegion={handleSelectRegion}
              onNavigateToLK={handleOpenLK}
            />
          )}

          {safeTab === 'lk' && (
            <LembarKerjaView
              results={results}
              period={period}
              selectedRegion={effectiveRegion}
              userRole={session.role}
              allowedRegion={session.regionCode}
              connectionStatus={connectionStatus}
              onRolloverPrevMonth={isProvinsi ? rolloverPrevMonthNK : undefined}
              onUpdateCommodityInput={updateCommodityInput}
            />
          )}

          {safeTab === 'update' && isProvinsi && (
            <UpdateDataView
              period={period}
              selectedRegion={effectiveKabKota}
              kabKotaInputs={kabKotaInputs}
              nk0Meta={nk0Meta}
              allNodes={allNodes}
              results={results}
              history={history}
              userRole={session.role}
              connectionStatus={connectionStatus}
              onSelectRegion={handleSelectRegion}
              onApplyMonthlyUpload={applyMonthlyUpload}
              onRolloverPrevMonth={rolloverPrevMonthNK}
              onNavigateToLK={handleOpenLK}
            />
          )}

          {safeTab === 'responden' && (
            <RespondentRHView
              period={period}
              selectedRegion={effectiveKabKota}
              datasets={respondentDatasets}
              userRole={session.role}
              allowedRegion={session.regionCode}
              onSetDataset={setRespondentDataset}
              onUpdateObservationAnnotation={updateRespondentAnnotation}
              onUpdateObservationPrice={updateRespondentPrice}
              onResetObservationPrice={resetRespondentPrice}
              onApplyCalculatedRhToLK={
                isProvinsi
                  ? (regionCode, rhUpdates, sourceLabel) =>
                      applyMonthlyUpload({
                        regionCode,
                        period,
                        rhUpdates,
                        logs: [
                          {
                            kind: 'RESPONDEN_SYNC',
                            fileName: sourceLabel,
                            matchedCount: Object.keys(rhUpdates).length,
                            unmatchedCount: 0,
                          },
                        ],
                      })
                  : undefined
              }
            />
          )}

          {safeTab === 'ranking' && isProvinsi && <AngkaSementaraRankingView />}
        </main>
      </div>
    </div>
  );
}
