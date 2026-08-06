-- Separar "Contaje de stock" de "Ajustes de inventario": 
--   - Antes, el botón +/- (club_apply_inventory_stock_adjustment) escribía también un
--     evento duplicado en shift_stock_events (source='manual'), por lo que los ajustes
--     aparecían mezclados en el panel "Contaje de stock".
--   - Ahora ese RPC solo escribe en inventory_stock_adjustments. Por tanto:
--       * shift_stock_events          = solo contajes reales (báscula/manual)
--       * inventory_stock_adjustments = solo ajustes +/-
--   - Se eliminan los duplicados históricos ya escritos en shift_stock_events.

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

-- Limpieza: quitamos de shift_stock_events los eventos duplicados que provenían del botón +/-
-- (coinciden a la vez con un inventory_stock_adjustments del mismo club, producto, usuario,
-- deltas, stock anterior/nuevo y creados en la misma franja de tiempo).
delete from public.shift_stock_events e
using public.inventory_stock_adjustments a
where a.club_id = e.club_id
  and a.product_id = e.product_id
  and a.created_by = e.created_by
  and a.delta_grams = e.delta_grams
  and a.previous_stock_grams = e.previous_stock_grams
  and a.new_stock_grams = e.stock_net_grams
  and abs(extract(epoch from (e.created_at - a.created_at))) < 60
  and e.source = 'manual';