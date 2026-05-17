-- Contajes manuales: siempre vinculados al turno abierto (también superadmin).
-- Devuelve JSON con delta para confirmar en cliente.
-- PostgreSQL no permite cambiar el tipo de retorno con CREATE OR REPLACE.

drop function if exists public.club_register_manual_stock_count(uuid, numeric);

create function public.club_register_manual_stock_count(
  p_product_id uuid,
  p_new_stock_grams numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.inventory_products%rowtype;
  v_club uuid;
  v_shift_id uuid;
  v_prev numeric(16, 3);
  v_delta numeric(16, 3);
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if p_new_stock_grams is null or p_new_stock_grams < 0 then
    raise exception 'stock inválido';
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

  select s.id into v_shift_id
  from public.shifts s
  where s.club_id = v_row.club_id
    and s.closed_at is null
  limit 1;

  if v_shift_id is null then
    raise exception 'no hay turno abierto';
  end if;

  v_prev := coalesce(v_row.stock_grams, 0);
  v_delta := p_new_stock_grams - v_prev;

  update public.inventory_products
  set stock_grams = p_new_stock_grams,
      updated_at = now()
  where id = p_product_id;

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
    p_new_stock_grams,
    'manual',
    auth.uid(),
    v_prev,
    v_delta
  );

  return jsonb_build_object(
    'stock_net_grams', p_new_stock_grams,
    'previous_stock_grams', v_prev,
    'delta_grams', v_delta,
    'shift_id', v_shift_id
  );
end;
$$;

alter function public.club_register_manual_stock_count(uuid, numeric) owner to postgres;
grant execute on function public.club_register_manual_stock_count(uuid, numeric) to authenticated;
