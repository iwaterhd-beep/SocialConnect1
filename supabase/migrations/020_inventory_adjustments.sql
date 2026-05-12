-- Ajustes manuales de stock desde Inventario (+/-) y permiso de edición de productos.
-- Ejecutar después de 018_fix_rls_policies.sql.

alter table public.club_access
  add column if not exists can_edit_inventory boolean not null default false;

comment on column public.club_access.can_edit_inventory is
  'Si true, el trabajador puede editar/crear productos y categorías en Inventario.';

create table if not exists public.inventory_stock_adjustments (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  product_id uuid not null references public.inventory_products (id) on delete restrict,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  delta_grams numeric(16, 3) not null,
  previous_stock_grams numeric(16, 3) not null,
  new_stock_grams numeric(16, 3) not null check (new_stock_grams >= 0),
  notes text not null default ''
);

create index if not exists inventory_stock_adjustments_club_idx
  on public.inventory_stock_adjustments (club_id, created_at desc);

create index if not exists inventory_stock_adjustments_product_idx
  on public.inventory_stock_adjustments (product_id);

alter table public.inventory_stock_adjustments enable row level security;

drop policy if exists "inventory_stock_adjustments_select" on public.inventory_stock_adjustments;
create policy "inventory_stock_adjustments_select"
  on public.inventory_stock_adjustments
  for select
  to authenticated
  using (
    public.is_superadmin()
    or exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and u.club_id = inventory_stock_adjustments.club_id
    )
    or exists (
      select 1
      from public.club_access ca
      where ca.auth_user_id = auth.uid()
        and ca.club_id = inventory_stock_adjustments.club_id
    )
  );

create or replace function public.current_user_can_edit_inventory()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_superadmin()
    or exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and u.role = 'admin_club'::public.user_role
    )
    or exists (
      select 1
      from public.club_access ca
      where ca.auth_user_id = auth.uid()
        and ca.can_edit_inventory = true
    );
$$;

grant execute on function public.current_user_can_edit_inventory() to authenticated;

drop policy if exists "inventory_products_update" on public.inventory_products;
create policy "inventory_products_update"
  on public.inventory_products
  for update
  to authenticated
  using (
    public.is_superadmin()
    or (
      public.current_user_can_edit_inventory()
      and (
        exists (
          select 1
          from public.users u
          where u.id = auth.uid()
            and u.club_id = inventory_products.club_id
        )
        or exists (
          select 1
          from public.club_access ca
          where ca.auth_user_id = auth.uid()
            and ca.club_id = inventory_products.club_id
        )
      )
    )
  )
  with check (
    public.is_superadmin()
    or (
      public.current_user_can_edit_inventory()
      and (
        exists (
          select 1
          from public.users u
          where u.id = auth.uid()
            and u.club_id = inventory_products.club_id
        )
        or exists (
          select 1
          from public.club_access ca
          where ca.auth_user_id = auth.uid()
            and ca.club_id = inventory_products.club_id
        )
      )
    )
  );

drop policy if exists "inventory_products_insert" on public.inventory_products;
create policy "inventory_products_insert"
  on public.inventory_products
  for insert
  to authenticated
  with check (
    public.is_superadmin()
    or (
      public.current_user_can_edit_inventory()
      and (
        exists (
          select 1
          from public.users u
          where u.id = auth.uid()
            and u.club_id = inventory_products.club_id
        )
        or exists (
          select 1
          from public.club_access ca
          where ca.auth_user_id = auth.uid()
            and ca.club_id = inventory_products.club_id
        )
      )
    )
  );

drop policy if exists "inventory_products_delete" on public.inventory_products;
create policy "inventory_products_delete"
  on public.inventory_products
  for delete
  to authenticated
  using (
    public.is_superadmin()
    or (
      public.current_user_can_edit_inventory()
      and (
        exists (
          select 1
          from public.users u
          where u.id = auth.uid()
            and u.club_id = inventory_products.club_id
        )
        or exists (
          select 1
          from public.club_access ca
          where ca.auth_user_id = auth.uid()
            and ca.club_id = inventory_products.club_id
        )
      )
    )
  );

drop policy if exists "club_access_update_admin" on public.club_access;
create policy "club_access_update_admin"
  on public.club_access
  for update
  to authenticated
  using (
    public.is_superadmin()
    or exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and u.role = 'admin_club'::public.user_role
        and u.club_id = club_access.club_id
    )
  )
  with check (
    public.is_superadmin()
    or exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and u.role = 'admin_club'::public.user_role
        and u.club_id = club_access.club_id
    )
  );

create or replace function public.club_apply_inventory_stock_adjustment(
  p_product_id uuid,
  p_delta_grams numeric,
  p_notes text default ''
)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.inventory_products%rowtype;
  v_club uuid;
  v_prev numeric(16, 3);
  v_new numeric(16, 3);
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if p_delta_grams is null or p_delta_grams = 0 then
    raise exception 'indica una cantidad distinta de cero';
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

    if v_club is null then
      select ca.club_id into v_club
      from public.club_access ca
      where ca.auth_user_id = auth.uid()
      limit 1;
    end if;

    if v_club is null or v_club <> v_row.club_id then
      raise exception 'forbidden';
    end if;
  end if;

  v_prev := coalesce(v_row.stock_grams, 0);
  v_new := greatest(0::numeric, v_prev + p_delta_grams);

  update public.inventory_products
  set stock_grams = v_new,
      updated_at = now()
  where id = p_product_id;

  insert into public.inventory_stock_adjustments (
    club_id,
    product_id,
    created_by,
    delta_grams,
    previous_stock_grams,
    new_stock_grams,
    notes
  )
  values (
    v_row.club_id,
    p_product_id,
    auth.uid(),
    p_delta_grams,
    v_prev,
    v_new,
    coalesce(trim(p_notes), '')
  );

  return v_new;
end;
$$;

alter function public.club_apply_inventory_stock_adjustment(uuid, numeric, text) owner to postgres;
grant execute on function public.club_apply_inventory_stock_adjustment(uuid, numeric, text) to authenticated;

grant select on public.inventory_stock_adjustments to authenticated;
