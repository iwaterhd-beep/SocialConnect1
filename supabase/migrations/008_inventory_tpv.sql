-- =============================================================================
-- Inventario (categorías, productos con emoji y peso de bote) + TPV (margen g)
-- Ejecutar después de 001 y 003 (shifts).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Categorías de inventario por club
-- ---------------------------------------------------------------------------
create table public.inventory_categories (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  name text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create index inventory_categories_club_id_idx on public.inventory_categories (club_id);

-- ---------------------------------------------------------------------------
-- Productos: emoji, categoría, peso del bote (tara), stock en gramos netos
-- ---------------------------------------------------------------------------
create table public.inventory_products (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  category_id uuid references public.inventory_categories (id) on delete set null,
  name text not null,
  emoji text not null default '',
  bottle_weight_grams numeric(14, 3) not null default 0
    check (bottle_weight_grams >= 0),
  stock_grams numeric(16, 3) not null default 0
    check (stock_grams >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index inventory_products_club_id_idx on public.inventory_products (club_id);
create index inventory_products_category_id_idx on public.inventory_products (category_id);

-- ---------------------------------------------------------------------------
-- Dispensaciones TPV: gramos cobrados vs gramos reales; precio al cliente
-- ---------------------------------------------------------------------------
create table public.tpv_dispenses (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  product_id uuid not null references public.inventory_products (id) on delete restrict,
  shift_id uuid references public.shifts (id) on delete set null,
  grams_charged numeric(14, 3) not null check (grams_charged >= 0),
  grams_dispensed numeric(14, 3) not null check (grams_dispensed >= 0),
  price_charged_eur numeric(12, 2) not null default 0 check (price_charged_eur >= 0),
  notes text not null default '',
  created_by uuid not null references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create index tpv_dispenses_club_id_idx on public.tpv_dispenses (club_id, created_at desc);
create index tpv_dispenses_product_id_idx on public.tpv_dispenses (product_id);

-- ---------------------------------------------------------------------------
-- RPC: fijar stock neto desde peso bruto en báscula (resta tara del bote)
-- ---------------------------------------------------------------------------
create or replace function public.club_set_stock_from_gross_weight(
  p_product_id uuid,
  p_gross_grams numeric
)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.inventory_products%rowtype;
  v_club uuid;
  v_net numeric(16, 3);
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if p_gross_grams is null or p_gross_grams < 0 then
    raise exception 'peso bruto inválido';
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

  v_net := greatest(0::numeric, p_gross_grams - coalesce(v_row.bottle_weight_grams, 0));

  update public.inventory_products
  set stock_grams = v_net,
      updated_at = now()
  where id = p_product_id;

  return v_net;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: registrar venta TPV (descuenta stock por gramos reales, guarda ticket)
-- ---------------------------------------------------------------------------
create or replace function public.club_register_tpv_dispense(
  p_product_id uuid,
  p_grams_charged numeric,
  p_grams_dispensed numeric,
  p_price_charged_eur numeric,
  p_shift_id uuid default null,
  p_notes text default ''
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

  update public.inventory_products
  set stock_grams = stock_grams - p_grams_dispensed,
      updated_at = now()
  where id = p_product_id;

  insert into public.tpv_dispenses (
    club_id,
    product_id,
    shift_id,
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

alter function public.club_set_stock_from_gross_weight(uuid, numeric) owner to postgres;
alter function public.club_register_tpv_dispense(uuid, numeric, numeric, numeric, uuid, text) owner to postgres;

grant execute on function public.club_set_stock_from_gross_weight(uuid, numeric) to authenticated;
grant execute on function public.club_register_tpv_dispense(uuid, numeric, numeric, numeric, uuid, text) to authenticated;

-- Trigger updated_at
create or replace function public.touch_inventory_product_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger inventory_products_updated_at
  before update on public.inventory_products
  for each row execute function public.touch_inventory_product_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.inventory_categories enable row level security;
alter table public.inventory_products enable row level security;
alter table public.tpv_dispenses enable row level security;

create policy "inventory_categories_select"
  on public.inventory_categories for select
  using (
    public.is_superadmin()
    or exists (
      select 1 from public.users u
      where u.id = auth.uid()
        and u.club_id = inventory_categories.club_id
    )
  );

create policy "inventory_categories_write"
  on public.inventory_categories for insert
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

create policy "inventory_categories_update"
  on public.inventory_categories for update
  using (
    public.is_superadmin()
    or exists (
      select 1 from public.users u
      where u.id = auth.uid()
        and u.club_id = inventory_categories.club_id
    )
  )
  with check (
    public.is_superadmin()
    or exists (
      select 1 from public.users u
      where u.id = auth.uid()
        and u.club_id = inventory_categories.club_id
    )
  );

create policy "inventory_categories_delete"
  on public.inventory_categories for delete
  using (
    public.is_superadmin()
    or exists (
      select 1 from public.users u
      where u.id = auth.uid()
        and u.club_id = inventory_categories.club_id
    )
  );

create policy "inventory_products_select"
  on public.inventory_products for select
  using (
    public.is_superadmin()
    or exists (
      select 1 from public.users u
      where u.id = auth.uid()
        and u.club_id = inventory_products.club_id
    )
  );

create policy "inventory_products_insert"
  on public.inventory_products for insert
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

create policy "inventory_products_update"
  on public.inventory_products for update
  using (
    public.is_superadmin()
    or exists (
      select 1 from public.users u
      where u.id = auth.uid()
        and u.club_id = inventory_products.club_id
    )
  )
  with check (
    public.is_superadmin()
    or exists (
      select 1 from public.users u
      where u.id = auth.uid()
        and u.club_id = inventory_products.club_id
    )
  );

create policy "inventory_products_delete"
  on public.inventory_products for delete
  using (
    public.is_superadmin()
    or exists (
      select 1 from public.users u
      where u.id = auth.uid()
        and u.club_id = inventory_products.club_id
    )
  );

create policy "tpv_dispenses_select"
  on public.tpv_dispenses for select
  using (
    public.is_superadmin()
    or exists (
      select 1 from public.users u
      where u.id = auth.uid()
        and u.club_id = tpv_dispenses.club_id
    )
  );

create policy "tpv_dispenses_insert"
  on public.tpv_dispenses for insert
  with check (
    public.is_superadmin()
    or (
      created_by = auth.uid()
      and club_id = (select u.club_id from public.users u where u.id = auth.uid())
      and exists (
        select 1 from public.clubs c
        where c.id = club_id and c.is_active = true
      )
    )
  );

-- Los inserts reales van por RPC; esta política permite inserción directa a superadmin
-- y coincidencia club (por si se inserta desde cliente sin RPC en el futuro).

grant select, insert, update, delete on public.inventory_categories to authenticated;
grant select, insert, update, delete on public.inventory_products to authenticated;
grant select, insert on public.tpv_dispenses to authenticated;
