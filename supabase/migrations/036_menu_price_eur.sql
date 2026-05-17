-- Precio explícito para menú tablet + relleno automático desde ficha y TPV.

alter table public.inventory_products
  add column if not exists menu_price_eur numeric(14, 4);

comment on column public.inventory_products.menu_price_eur is
  'Precio mostrado en menú tablet: por unidad si sale_unit=unit, por gramo si sale_unit=grams.';

create or replace function public.club_menu_price_value(p public.inventory_products)
returns numeric
language plpgsql
stable
set search_path = public
as $$
declare
  v numeric;
begin
  if p.menu_price_eur is not null then
    return p.menu_price_eur;
  end if;

  if coalesce(p.sale_unit, 'grams') = 'unit' then
    v := public.club_menu_unit_price(p);
  else
    v := public.club_menu_gram_rate(p);
  end if;

  if v is not null then
    return v;
  end if;

  return public.club_menu_price_from_sales(p);
end;
$$;

-- Rellenar precios menú para un club (desde ficha + última venta TPV)
create or replace function public.club_sync_menu_prices(p_club_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_club uuid;
  v_count integer := 0;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if p_club_id is not null then
    v_club := p_club_id;
  else
    select u.club_id into v_club from public.users u where u.id = auth.uid();
    if v_club is null then
      select ca.club_id into v_club
      from public.club_access ca
      where ca.auth_user_id = auth.uid()
      limit 1;
    end if;
  end if;

  if v_club is null and not public.is_superadmin() then
    raise exception 'sin club';
  end if;

  with src as (
    select
      p.id,
      coalesce(
        p.menu_price_eur,
        case when coalesce(p.sale_unit, 'grams') = 'unit' then
          coalesce(p.retail_price_eur, p.default_price_eur)
        else
          public.club_menu_gram_rate(p)
        end,
        (
          select d.price_charged_eur
          from public.tpv_dispenses d
          where d.product_id = p.id
            and coalesce(d.price_charged_eur, 0) > 0
          order by d.created_at desc
          limit 1
        ),
        (
          select avg(d.price_charged_eur / nullif(d.grams_charged, 0))
          from public.tpv_dispenses d
          where d.product_id = p.id
            and coalesce(d.price_charged_eur, 0) > 0
            and coalesce(d.grams_charged, 0) > 0
            and d.created_at > (now() - interval '365 days')
        )
      ) as new_price
    from public.inventory_products p
    where (v_club is null or p.club_id = v_club)
      and coalesce(p.is_archived, false) = false
  )
  update public.inventory_products p
  set menu_price_eur = src.new_price
  from src
  where p.id = src.id
    and src.new_price is not null
    and (p.menu_price_eur is distinct from src.new_price);

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

alter function public.club_sync_menu_prices(uuid) owner to postgres;
grant execute on function public.club_sync_menu_prices(uuid) to authenticated;

-- Relleno inicial (solo donde aún no hay menu_price_eur)
update public.inventory_products p
set menu_price_eur = coalesce(
  case when coalesce(p.sale_unit, 'grams') = 'unit' then
    coalesce(p.retail_price_eur, p.default_price_eur)
  else
    public.club_menu_gram_rate(p)
  end,
  (
    select d.price_charged_eur
    from public.tpv_dispenses d
    where d.product_id = p.id
      and coalesce(d.price_charged_eur, 0) > 0
    order by d.created_at desc
    limit 1
  )
)
where p.menu_price_eur is null;
