-- Parche: la tabla club_member_dues_payments existe sin shift_id
-- (CREATE TABLE IF NOT EXISTS no la regenera). Ejecuta ESTO primero.

alter table public.club_member_dues_payments
  add column if not exists shift_id uuid references public.shifts (id) on delete set null;

alter table public.club_member_dues_payments
  add column if not exists notes text not null default '';

alter table public.club_member_dues_payments
  add column if not exists created_by uuid references auth.users (id) on delete set null;

alter table public.club_member_dues_payments
  add column if not exists created_at timestamptz not null default now();

alter table public.club_member_dues_payments
  add column if not exists wallet_eur numeric(12, 2) not null default 0;

alter table public.club_member_dues_payments
  add column if not exists club_eur numeric(12, 2) not null default 0;

alter table public.club_member_dues_payments
  add column if not exists payment_method text not null default 'cash';

alter table public.club_member_dues_payments
  drop constraint if exists club_member_dues_payments_split_check;

alter table public.club_member_dues_payments
  add constraint club_member_dues_payments_split_check
  check (abs((coalesce(wallet_eur, 0) + coalesce(club_eur, 0)) - coalesce(total_eur, 0)) < 0.005);

create index if not exists club_member_dues_payments_member_idx
  on public.club_member_dues_payments (member_id, created_at desc);

create index if not exists club_member_dues_payments_club_idx
  on public.club_member_dues_payments (club_id, created_at desc);

create index if not exists club_member_dues_payments_shift_idx
  on public.club_member_dues_payments (shift_id, created_at desc)
  where shift_id is not null;
