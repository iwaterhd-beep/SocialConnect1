-- Contajes de stock: lectura para trabajadores en club_access + ajustes +/- vinculados al turno.
-- Sin esto, club_register_manual_stock_count guarda el evento pero el cliente no puede leerlo
-- (solo comprobaba public.users, no club_access).

-- ---------------------------------------------------------------------------
-- RLS shift_stock_events (select + insert)
-- ---------------------------------------------------------------------------
drop policy if exists "shift_stock_events_select" on public.shift_stock_events;
create policy "shift_stock_events_select"
  on public.shift_stock_events
  for select
  to authenticated
  using (
    public.is_superadmin()
    or exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and u.club_id = shift_stock_events.club_id
    )
    or exists (
      select 1
      from public.club_access ca
      where ca.auth_user_id = auth.uid()
        and ca.club_id = shift_stock_events.club_id
    )
  );

drop policy if exists "shift_stock_events_insert" on public.shift_stock_events;
create policy "shift_stock_events_insert"
  on public.shift_stock_events
  for insert
  to authenticated
  with check (
    public.is_superadmin()
    or (
      (
        club_id = (select u.club_id from public.users u where u.id = auth.uid())
        or exists (
          select 1
          from public.club_access ca
          where ca.auth_user_id = auth.uid()
            and ca.club_id = shift_stock_events.club_id
        )
      )
      and exists (
        select 1
        from public.clubs c
        where c.id = club_id
          and c.is_active = true
      )
      and exists (
        select 1
        from public.shifts s
        where s.id = shift_id
          and s.club_id = shift_stock_events.club_id
          and s.closed_at is null
      )
    )
  );

-- ---------------------------------------------------------------------------
-- Ajustes +/- desde Inventario: también registran descuadre en el turno abierto
-- ---------------------------------------------------------------------------
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
  v_shift_id uuid;
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

  select s.id into v_shift_id
  from public.shifts s
  where s.club_id = v_row.club_id
    and s.closed_at is null
  limit 1;

  if v_shift_id is not null then
    insert into public.shift_stock_events (
      club_id,
      shift_id,
      product_id,
      stock_net_grams,
      source,
      created_by,
      previous_stock_grams,
      delta_grams
    )
    values (
      v_row.club_id,
      v_shift_id,
      p_product_id,
      v_new,
      'manual',
      auth.uid(),
      v_prev,
      p_delta_grams
    );
  end if;

  return v_new;
end;
$$;

alter function public.club_apply_inventory_stock_adjustment(uuid, numeric, text) owner to postgres;
grant execute on function public.club_apply_inventory_stock_adjustment(uuid, numeric, text) to authenticated;
