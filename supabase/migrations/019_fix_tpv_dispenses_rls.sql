-- Fix RLS for TPV dispenses visibility and inserts.
-- Execute after 008_inventory_tpv.sql and 018_fix_rls_policies.sql.

alter table public.tpv_dispenses enable row level security;

drop policy if exists "tpv_dispenses_select" on public.tpv_dispenses;
drop policy if exists "tpv_dispenses_insert" on public.tpv_dispenses;

create policy "tpv_dispenses_select"
  on public.tpv_dispenses
  for select
  using (
    public.is_superadmin()
    or created_by = auth.uid()
    or exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and u.club_id = tpv_dispenses.club_id
    )
    or exists (
      select 1
      from public.club_access ca
      where ca.auth_user_id = auth.uid()
        and ca.club_id = tpv_dispenses.club_id
    )
  );

create policy "tpv_dispenses_insert"
  on public.tpv_dispenses
  for insert
  with check (
    public.is_superadmin()
    or (
      created_by = auth.uid()
      and exists (
        select 1
        from public.users u
        join public.clubs c on c.id = u.club_id
        where u.id = auth.uid()
          and u.club_id = tpv_dispenses.club_id
          and c.is_active = true
      )
    )
    or (
      created_by = auth.uid()
      and exists (
        select 1
        from public.club_access ca
        join public.clubs c on c.id = ca.club_id
        where ca.auth_user_id = auth.uid()
          and ca.club_id = tpv_dispenses.club_id
          and c.is_active = true
      )
    )
  );

grant select, insert on public.tpv_dispenses to authenticated;
