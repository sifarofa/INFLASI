-- Schema Supabase aktual untuk Monitoring Inflasi IHK Kalbar (6100)

create table if not exists public.inflasi_lk_data (
  id uuid default gen_random_uuid() primary key,
  tahun integer not null,
  bulan integer not null check (bulan between 1 and 12),
  kode_wilayah text not null,
  nama_wilayah text not null,
  kode_kelompok text not null,
  kode_komoditas text not null,
  nama_komoditas text not null,
  bobot numeric not null default 0,
  nk_dasar numeric not null default 0,
  nk_des numeric not null default 0,
  nk_n12 numeric not null default 0,
  nk_n1 numeric not null default 0,
  rh_n numeric not null default 100,
  updated_at timestamptz not null default now(),
  constraint inflasi_lk_data_unique_key unique (tahun, bulan, kode_wilayah, kode_komoditas)
);

-- Juga digunakan untuk snapshot sinkronisasi lintas perangkat Ranking Inflasi (ANGKA_SEMENTARA_*) dan rincian penuh RH Responden (RESP_SNAPSHOT_*)
create table if not exists public.inflasi_upload_logs (
  id uuid default gen_random_uuid() primary key,
  tahun integer not null,
  bulan integer not null check (bulan between 1 and 12),
  jenis_upload text not null,
  nama_file text not null,
  jumlah_baris integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.inflasi_harga_responden (
  id uuid default gen_random_uuid() primary key,
  tahun integer not null,
  bulan integer not null check (bulan between 1 and 12),
  kode_wilayah text not null,
  kode_komoditas text not null,
  kode_responden text not null,
  nama_responden text not null default '',
  kualitas text not null default '',
  frekuensi text not null check (frekuensi in ('mingguan', 'dwimingguan', 'bulanan')),
  harga_lalu numeric,
  harga_berjalan numeric,
  rh_responden numeric,
  updated_at timestamptz not null default now(),
  constraint inflasi_harga_responden_unique_key unique (tahun, bulan, kode_wilayah, kode_komoditas, kode_responden)
);
