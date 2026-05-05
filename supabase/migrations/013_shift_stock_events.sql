-- Registro de contajes de stock por turno (báscula o manual).
-- Ejecutar después de 008_inventory_tpv.sql y 003_shifts_turnos.sql.

create table public.shift_stock_events (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  shift_id uuid not null references public.shifts (id) on delete cascade,
  product_id uuid not null references public.inventory_products (id) on delete cascade,
  stock_net_grams numeric(16, 3) not null check (stock_net_grams >= 0),
  source text not null default 'manual' check (source in ('manual', 'scale')),
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users (id) on delete set null
);

create index shift_stock_events_shift_idx on public.shift_stock_events (shift_id, created_at desc);
create index shift_stock_events_club_idx on public.shift_stock_events (club_id);

alter table public.shift_stock_events enable row level security;

create policy "shift_stock_events_select"
  on public.shift_stock_events for select
  using (
    public.is_superadmin()
    or exists (
      select 1 from public.users u
      where u.id = auth.uid()
        and u.club_id = shift_stock_events.club_id
    )
  );

create policy "shift_stock_events_insert"
  on public.shift_stock_events for insert
  with check (
    public.is_superadmin()
    or (
      club_id = (select u.club_id from public.users u where u.id = auth.uid())
      and exists (
        select 1 from public.clubs c
        where c.id = club_id and c.is_active = true
      )
      and exists (
        select 1 from public.shifts s
        where s.id = shift_id
          and s.club_id = shift_stock_events.club_id
          and s.closed_at is null
      )
    )
  );

grant select, insert on public.shift_stock_events to authenticated;
