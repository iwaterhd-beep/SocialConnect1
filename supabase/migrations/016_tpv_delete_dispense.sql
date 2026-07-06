-- Borrado de dispensaciones TPV con reversión de stock.
-- Ejecutar después de 014_shift_float_stock_rpc.sql.

create or replace function public.club_delete_tpv_dispense(
  p_dispense_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_disp public.tpv_dispenses%rowtype;
  v_prod public.inventory_products%rowtype;
  v_club uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select * into v_disp
  from public.tpv_dispenses
  where id = p_dispense_id
  for update;

  if not found then
    raise exception 'dispensación no encontrada';
  end if;

  if not public.is_superadmin() then
    select u.club_id into v_club
    from public.users u
    where u.id = auth.uid();

    if v_club is null or v_club <> v_disp.club_id then
      raise exception 'forbidden';
    end if;
  end if;

  select * into v_prod
  from public.inventory_products
  where id = v_disp.product_id
  for update;

  if found then
    update public.inventory_products
    set stock_grams = coalesce(stock_grams, 0) + coalesce(v_disp.grams_dispensed, 0),
        updated_at = now()
    where id = v_disp.product_id;
  end if;

  delete from public.tpv_dispenses
  where id = p_dispense_id;
end;
$$;

alter function public.club_delete_tpv_dispense(uuid) owner to postgres;
grant execute on function public.club_delete_tpv_dispense(uuid) to authenticated;
