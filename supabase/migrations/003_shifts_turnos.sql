-- =============================================================================
-- Turnos de caja (shifts) — un turno abierto por club
-- Ejecutar después de 001_initial_schema.sql
-- (No uses DROP POLICY si la tabla aún no existe: Postgres devuelve 42P01.)
-- =============================================================================

drop table if exists public.shifts cascade;

create table public.shifts (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  opened_by uuid not null references auth.users (id) on delete set null,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_by uuid references auth.users (id) on delete set null,
  note_open text not null default '',
  note_close text not null default ''
);

-- Como máximo un turno abierto por club
create unique index shifts_one_open_per_club
  on public.shifts (club_id)
  where closed_at is null;

create index shifts_club_id_opened_at_idx on public.shifts (club_id, opened_at desc);

alter table public.shifts enable row level security;

create policy "shifts_select"
  on public.shifts for select
  using (
    public.is_superadmin()
    or exists (
      select 1 from public.users u
      where u.id = auth.uid()
        and u.club_id = shifts.club_id
    )
  );

create policy "shifts_insert"
  on public.shifts for insert
  with check (
    public.is_superadmin()
    or (
      opened_by = auth.uid()
      and club_id = (select u.club_id from public.users u where u.id = auth.uid())
      and exists (
        select 1 from public.clubs c
        where c.id = club_id
          and c.is_active = true
      )
    )
  );

create policy "shifts_update"
  on public.shifts for update
  using (
    public.is_superadmin()
    or exists (
      select 1 from public.users u
      where u.id = auth.uid()
        and u.club_id = shifts.club_id
    )
  )
  with check (
    public.is_superadmin()
    or exists (
      select 1 from public.users u
      where u.id = auth.uid()
        and u.club_id = shifts.club_id
    )
  );

grant select, insert, update on public.shifts to authenticated;
