-- =============================================================================
-- Socios del club + ventas TPV vinculables (sin migración de datos históricos).
-- Ejecutar después de 008 (y 009 si la usas).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Socios (altas manuales desde el panel; tablas vacías al crear)
-- ---------------------------------------------------------------------------
create table public.club_members (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  display_name text not null,
  member_code text not null default '',
  phone text not null default '',
  notes text not null default '',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index club_members_club_id_idx on public.club_members (club_id);
create index club_members_club_active_idx on public.club_members (club_id, is_active);

create unique index club_members_unique_code_per_club
  on public.club_members (club_id, lower(btrim(member_code)))
  where length(btrim(member_code)) > 0;

alter table public.club_members enable row level security;

create policy "club_members_select"
  on public.club_members for select
  using (
    public.is_superadmin()
    or exists (
      select 1 from public.users u
      where u.id = auth.uid()
        and u.club_id = club_members.club_id
    )
  );

create policy "club_members_insert"
  on public.club_members for insert
  with check (
    public.is_superadmin()
    or (
      club_id = (select u.club_id from public.users u where u.id = auth.uid())
      and exists (
        select 1 from public.clubs c
        where c.id = club_id and c.is_active = true
      )
    )
  );

create policy "club_members_update"
  on public.club_members for update
  using (
    public.is_superadmin()
    or exists (
      select 1 from public.users u
      where u.id = auth.uid()
        and u.club_id = club_members.club_id
    )
  )
  with check (
    public.is_superadmin()
    or exists (
      select 1 from public.users u
      where u.id = auth.uid()
        and u.club_id = club_members.club_id
    )
  );

create policy "club_members_delete"
  on public.club_members for delete
  using (
    public.is_superadmin()
    or exists (
      select 1 from public.users u
      where u.id = auth.uid()
        and u.club_id = club_members.club_id
    )
  );

grant select, insert, update, delete on public.club_members to authenticated;

-- ---------------------------------------------------------------------------
-- Ventas TPV: socio opcional
-- ---------------------------------------------------------------------------
alter table public.tpv_dispenses
  add column if not exists member_id uuid references public.club_members (id) on delete set null;

create index if not exists tpv_dispenses_member_id_idx on public.tpv_dispenses (member_id);

-- ---------------------------------------------------------------------------
-- RPC venta: nueva firma con socio opcional (reemplaza la de 6 argumentos)
-- ---------------------------------------------------------------------------
drop function if exists public.club_register_tpv_dispense(uuid, numeric, numeric, numeric, uuid, text);

create or replace function public.club_register_tpv_dispense(
  p_product_id uuid,
  p_grams_charged numeric,
  p_grams_dispensed numeric,
  p_price_charged_eur numeric,
  p_shift_id uuid default null,
  p_notes text default '',
  p_member_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.inventory_products%rowtype;
  v_club uuid;
  v_dispense_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if p_grams_charged is null or p_grams_charged < 0
     or p_grams_dispensed is null or p_grams_dispensed < 0 then
    raise exception 'gramos inválidos';
  end if;

  if p_price_charged_eur is null or p_price_charged_eur < 0 then
    raise exception 'precio inválido';
  end if;

  select * into v_row
  from public.inventory_products
  where id = p_product_id
  for update;

  if not found then
    raise exception 'producto no encontrado';
  end if;

  if public.is_superadmin() then
    null;
  else
    select u.club_id into v_club
    from public.users u
    where u.id = auth.uid();

    if v_club is null or v_club <> v_row.club_id then
      raise exception 'forbidden';
    end if;
  end if;

  if v_row.stock_grams < p_grams_dispensed then
    raise exception 'stock insuficiente (disponible: % g)', v_row.stock_grams;
  end if;

  if p_shift_id is not null then
    if not exists (
      select 1
      from public.shifts s
      where s.id = p_shift_id
        and s.club_id = v_row.club_id
        and s.closed_at is null
    ) then
      raise exception 'turno no válido o ya cerrado';
    end if;
  end if;

  if p_member_id is not null then
    if not exists (
      select 1
      from public.club_members m
      where m.id = p_member_id
        and m.club_id = v_row.club_id
        and m.is_active = true
    ) then
      raise exception 'socio no válido o inactivo';
    end if;
  end if;

  update public.inventory_products
  set stock_grams = stock_grams - p_grams_dispensed,
      updated_at = now()
  where id = p_product_id;

  insert into public.tpv_dispenses (
    club_id,
    product_id,
    shift_id,
    member_id,
    grams_charged,
    grams_dispensed,
    price_charged_eur,
    notes,
    created_by
  )
  values (
    v_row.club_id,
    p_product_id,
    p_shift_id,
    p_member_id,
    p_grams_charged,
    p_grams_dispensed,
    p_price_charged_eur,
    coalesce(p_notes, ''),
    auth.uid()
  )
  returning id into v_dispense_id;

  return v_dispense_id;
end;
$$;

alter function public.club_register_tpv_dispense(uuid, numeric, numeric, numeric, uuid, text, uuid) owner to postgres;

grant execute on function public.club_register_tpv_dispense(uuid, numeric, numeric, numeric, uuid, text, uuid) to authenticated;
