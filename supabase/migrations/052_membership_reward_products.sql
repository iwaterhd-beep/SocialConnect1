-- Regalos de membresía enlazados a productos del TPV + entrega única al subir de nivel.

alter table public.club_membership_rewards
  add column if not exists product_id uuid references public.inventory_products (id) on delete set null;

create index if not exists club_membership_rewards_product_idx
  on public.club_membership_rewards (product_id)
  where product_id is not null;

comment on column public.club_membership_rewards.product_id is
  'Producto del inventario/TPV que se añade gratis al ticket en la primera venta tras subir de nivel.';

create table if not exists public.club_membership_reward_grants (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  member_id uuid not null references public.club_members (id) on delete cascade,
  reward_id uuid not null references public.club_membership_rewards (id) on delete cascade,
  product_id uuid not null references public.inventory_products (id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'fulfilled', 'cancelled')),
  created_at timestamptz not null default now(),
  fulfilled_at timestamptz,
  unique (member_id, reward_id)
);

create index if not exists club_membership_reward_grants_pending_idx
  on public.club_membership_reward_grants (club_id, member_id)
  where status = 'pending';

alter table public.club_membership_reward_grants enable row level security;

drop policy if exists "club_membership_reward_grants_select" on public.club_membership_reward_grants;
drop policy if exists "club_membership_reward_grants_insert" on public.club_membership_reward_grants;
drop policy if exists "club_membership_reward_grants_update" on public.club_membership_reward_grants;
drop policy if exists "club_membership_reward_grants_delete" on public.club_membership_reward_grants;

create policy "club_membership_reward_grants_select"
  on public.club_membership_reward_grants for select to authenticated
  using (
    exists (
      select 1 from public.users u
      where u.id = auth.uid() and u.club_id = club_membership_reward_grants.club_id
    )
    or exists (
      select 1 from public.club_access ca
      where ca.auth_user_id = auth.uid() and ca.club_id = club_membership_reward_grants.club_id
    )
    or exists (
      select 1 from public.users u where u.id = auth.uid() and u.is_superadmin = true
    )
  );

create policy "club_membership_reward_grants_insert"
  on public.club_membership_reward_grants for insert to authenticated
  with check (
    exists (
      select 1 from public.users u
      where u.id = auth.uid() and u.club_id = club_membership_reward_grants.club_id
    )
    or exists (
      select 1 from public.club_access ca
      where ca.auth_user_id = auth.uid() and ca.club_id = club_membership_reward_grants.club_id
    )
    or exists (
      select 1 from public.users u where u.id = auth.uid() and u.is_superadmin = true
    )
  );

create policy "club_membership_reward_grants_update"
  on public.club_membership_reward_grants for update to authenticated
  using (
    exists (
      select 1 from public.users u
      where u.id = auth.uid() and u.club_id = club_membership_reward_grants.club_id
    )
    or exists (
      select 1 from public.club_access ca
      where ca.auth_user_id = auth.uid() and ca.club_id = club_membership_reward_grants.club_id
    )
    or exists (
      select 1 from public.users u where u.id = auth.uid() and u.is_superadmin = true
    )
  )
  with check (
    exists (
      select 1 from public.users u
      where u.id = auth.uid() and u.club_id = club_membership_reward_grants.club_id
    )
    or exists (
      select 1 from public.club_access ca
      where ca.auth_user_id = auth.uid() and ca.club_id = club_membership_reward_grants.club_id
    )
    or exists (
      select 1 from public.users u where u.id = auth.uid() and u.is_superadmin = true
    )
  );

create policy "club_membership_reward_grants_delete"
  on public.club_membership_reward_grants for delete to authenticated
  using (
    exists (
      select 1 from public.users u
      where u.id = auth.uid() and u.club_id = club_membership_reward_grants.club_id
    )
    or exists (
      select 1 from public.club_access ca
      where ca.auth_user_id = auth.uid() and ca.club_id = club_membership_reward_grants.club_id
    )
    or exists (
      select 1 from public.users u where u.id = auth.uid() and u.is_superadmin = true
    )
  );

grant select, insert, update, delete on public.club_membership_reward_grants to authenticated;
