-- Membresías configurables por club (nombres, colores, umbral VIP, regalos).
-- Actualiza la regla VIP automática para leer umbral/ventana desde club_membership_tiers.

-- ---------------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------------
create table if not exists public.club_membership_tiers (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  tier_key text not null check (tier_key in ('standard', 'premium', 'vip')),
  display_name text not null,
  color_hex text not null default '#64748b',
  description text not null default '',
  benefits_text text not null default '',
  auto_upgrade_enabled boolean not null default false,
  spend_threshold_eur numeric(12, 2) not null default 0 check (spend_threshold_eur >= 0),
  spend_window_days integer not null default 7 check (spend_window_days >= 1 and spend_window_days <= 365),
  default_valid_days integer check (default_valid_days is null or default_valid_days >= 1),
  is_enabled boolean not null default true,
  sort_order integer not null default 0,
  updated_at timestamptz not null default now(),
  unique (club_id, tier_key)
);

comment on table public.club_membership_tiers is
  'Configuración de niveles de membresía por club (Estándar / Premium / VIP).';

create table if not exists public.club_membership_rewards (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  tier_key text check (tier_key is null or tier_key in ('standard', 'premium', 'vip')),
  title text not null,
  description text not null default '',
  trigger_type text not null default 'manual'
    check (trigger_type in ('on_upgrade', 'spend_threshold', 'birthday', 'manual')),
  trigger_spend_eur numeric(12, 2) check (trigger_spend_eur is null or trigger_spend_eur >= 0),
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

comment on table public.club_membership_rewards is
  'Regalos / objetivos de membresía (informativos para el equipo; se canjean manualmente).';

create index if not exists club_membership_rewards_club_idx
  on public.club_membership_rewards (club_id, sort_order);

-- ---------------------------------------------------------------------------
-- Seed defaults por club
-- ---------------------------------------------------------------------------
create or replace function public.ensure_club_membership_defaults(p_club_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform set_config('row_security', 'off', true);

  insert into public.club_membership_tiers (
    club_id, tier_key, display_name, color_hex, description, benefits_text,
    auto_upgrade_enabled, spend_threshold_eur, spend_window_days, sort_order
  )
  values
    (
      p_club_id, 'standard', 'Estándar', '#64748b',
      'Nivel base de socio del club.',
      'Acceso al club y consumo según normas internas.',
      false, 0, 7, 0
    ),
    (
      p_club_id, 'premium', 'Premium', '#0d9488',
      'Nivel intermedio con ventajas adicionales.',
      'Prioridad en atención y ventajas definidas por el club.',
      false, 50, 7, 1
    ),
    (
      p_club_id, 'vip', 'VIP', '#ca8a04',
      'Nivel alto. Puede activarse automáticamente por gasto en POS.',
      'Ventajas VIP definidas por el club. Auto-VIP según umbral configurado.',
      true, 100, 7, 2
    )
  on conflict (club_id, tier_key) do nothing;
end;
$$;

alter function public.ensure_club_membership_defaults(uuid) owner to postgres;
grant execute on function public.ensure_club_membership_defaults(uuid) to authenticated;

-- Sembrar clubs existentes
do $$
declare
  r record;
begin
  for r in select id from public.clubs loop
    perform public.ensure_club_membership_defaults(r.id);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.club_membership_tiers enable row level security;
alter table public.club_membership_rewards enable row level security;

drop policy if exists "membership_tiers_select" on public.club_membership_tiers;
drop policy if exists "membership_tiers_write" on public.club_membership_tiers;
drop policy if exists "membership_tiers_update" on public.club_membership_tiers;
drop policy if exists "membership_tiers_delete" on public.club_membership_tiers;

create policy "membership_tiers_select"
  on public.club_membership_tiers for select
  using (
    public.is_superadmin()
    or exists (
      select 1 from public.users u
      where u.id = auth.uid() and u.club_id = club_membership_tiers.club_id
    )
    or exists (
      select 1 from public.club_access ca
      where ca.auth_user_id = auth.uid() and ca.club_id = club_membership_tiers.club_id
    )
  );

create policy "membership_tiers_write"
  on public.club_membership_tiers for insert
  with check (
    public.is_superadmin()
    or exists (
      select 1 from public.users u
      where u.id = auth.uid()
        and u.club_id = club_membership_tiers.club_id
        and u.role = 'admin_club'::public.user_role
    )
  );

create policy "membership_tiers_update"
  on public.club_membership_tiers for update
  using (
    public.is_superadmin()
    or exists (
      select 1 from public.users u
      where u.id = auth.uid()
        and u.club_id = club_membership_tiers.club_id
        and u.role = 'admin_club'::public.user_role
    )
  )
  with check (
    public.is_superadmin()
    or exists (
      select 1 from public.users u
      where u.id = auth.uid()
        and u.club_id = club_membership_tiers.club_id
        and u.role = 'admin_club'::public.user_role
    )
  );

create policy "membership_tiers_delete"
  on public.club_membership_tiers for delete
  using (
    public.is_superadmin()
    or exists (
      select 1 from public.users u
      where u.id = auth.uid()
        and u.club_id = club_membership_tiers.club_id
        and u.role = 'admin_club'::public.user_role
    )
  );

drop policy if exists "membership_rewards_select" on public.club_membership_rewards;
drop policy if exists "membership_rewards_write" on public.club_membership_rewards;
drop policy if exists "membership_rewards_update" on public.club_membership_rewards;
drop policy if exists "membership_rewards_delete" on public.club_membership_rewards;

create policy "membership_rewards_select"
  on public.club_membership_rewards for select
  using (
    public.is_superadmin()
    or exists (
      select 1 from public.users u
      where u.id = auth.uid() and u.club_id = club_membership_rewards.club_id
    )
    or exists (
      select 1 from public.club_access ca
      where ca.auth_user_id = auth.uid() and ca.club_id = club_membership_rewards.club_id
    )
  );

create policy "membership_rewards_write"
  on public.club_membership_rewards for insert
  with check (
    public.is_superadmin()
    or exists (
      select 1 from public.users u
      where u.id = auth.uid()
        and u.club_id = club_membership_rewards.club_id
        and u.role = 'admin_club'::public.user_role
    )
  );

create policy "membership_rewards_update"
  on public.club_membership_rewards for update
  using (
    public.is_superadmin()
    or exists (
      select 1 from public.users u
      where u.id = auth.uid()
        and u.club_id = club_membership_rewards.club_id
        and u.role = 'admin_club'::public.user_role
    )
  )
  with check (
    public.is_superadmin()
    or exists (
      select 1 from public.users u
      where u.id = auth.uid()
        and u.club_id = club_membership_rewards.club_id
        and u.role = 'admin_club'::public.user_role
    )
  );

create policy "membership_rewards_delete"
  on public.club_membership_rewards for delete
  using (
    public.is_superadmin()
    or exists (
      select 1 from public.users u
      where u.id = auth.uid()
        and u.club_id = club_membership_rewards.club_id
        and u.role = 'admin_club'::public.user_role
    )
  );

grant select, insert, update, delete on public.club_membership_tiers to authenticated;
grant select, insert, update, delete on public.club_membership_rewards to authenticated;

-- ---------------------------------------------------------------------------
-- VIP rule: lee umbral y ventana desde config VIP del club
-- ---------------------------------------------------------------------------
create or replace function public.club_members_vip_rule_after_dispense(p_club_id uuid, p_member_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  m_type text;
  m_anchor timestamptz;
  v_win_sum numeric;
  v_roll_sum numeric;
  v_next timestamptz;
  v_guard int := 0;
  v_threshold numeric := 100;
  v_days int := 7;
  v_auto boolean := true;
  v_win interval;
begin
  perform set_config('row_security', 'off', true);

  select
    coalesce(t.spend_threshold_eur, 100),
    coalesce(t.spend_window_days, 7),
    coalesce(t.auto_upgrade_enabled, true)
  into v_threshold, v_days, v_auto
  from public.club_membership_tiers t
  where t.club_id = p_club_id
    and t.tier_key = 'vip';

  if not found then
    v_threshold := 100;
    v_days := 7;
    v_auto := true;
  end if;

  v_win := make_interval(days => v_days);

  perform 1
  from public.club_members m
  where m.id = p_member_id
    and m.club_id = p_club_id
    and m.is_active = true
  for update;

  if not found then
    return;
  end if;

  -- Si auto-VIP está desactivado: no subir ni bajar por regla (solo VIP manual)
  if not v_auto then
    return;
  end if;

  <<down_loop>>
  loop
    select m.member_type, m.vip_rule_period_start
    into m_type, m_anchor
    from public.club_members m
    where m.id = p_member_id
      and m.club_id = p_club_id
      and m.is_active = true;

    if not found then
      return;
    end if;

    if m_type is distinct from 'vip' or m_anchor is null then
      exit down_loop;
    end if;

    exit down_loop when now() < m_anchor + v_win;

    select coalesce(sum(d.price_charged_eur), 0)::numeric
    into v_win_sum
    from public.tpv_dispenses d
    where d.club_id = p_club_id
      and d.member_id = p_member_id
      and d.created_at >= m_anchor
      and d.created_at < m_anchor + v_win;

    if v_win_sum < v_threshold then
      update public.club_members m
      set
        member_type = 'standard',
        member_type_valid_until = null,
        vip_rule_period_start = null
      where m.id = p_member_id
        and m.club_id = p_club_id;
      exit down_loop;
    end if;

    v_next := m_anchor + v_win;
    update public.club_members m
    set vip_rule_period_start = v_next
    where m.id = p_member_id
      and m.club_id = p_club_id;

    v_guard := v_guard + 1;
    if v_guard > 520 then
      raise exception 'vip_rule_period: demasiados avances de ventana';
    end if;
  end loop;

  select m.member_type, m.vip_rule_period_start
  into m_type, m_anchor
  from public.club_members m
  where m.id = p_member_id
    and m.club_id = p_club_id
    and m.is_active = true;

  if not found then
    return;
  end if;

  select coalesce(sum(d.price_charged_eur), 0)::numeric
  into v_roll_sum
  from public.tpv_dispenses d
  where d.club_id = p_club_id
    and d.member_id = p_member_id
    and d.created_at >= (now() - v_win);

  if v_roll_sum > v_threshold then
    if m_type is distinct from 'vip' then
      update public.club_members m
      set
        member_type = 'vip',
        member_type_valid_until = null,
        vip_rule_period_start = now()
      where m.id = p_member_id
        and m.club_id = p_club_id
        and m.is_active = true;
    end if;
  end if;
end;
$$;

comment on function public.club_members_vip_rule_after_dispense(uuid, uuid) is
  'Recalcula VIP por regla TPV usando umbral/ventana de club_membership_tiers (tier vip).';
