-- Menú: más productos con precio (misma lógica que TPV + última venta si falta en ficha).

create or replace function public.club_menu_gram_rate(p public.inventory_products)
returns numeric
language plpgsql
stable
set search_path = public
as $$
declare
  v_rate numeric;
  v_gs numeric;
begin
  v_gs := coalesce(p.default_sale_grams, 0);

  v_rate := coalesce(p.retail_price_eur, p.default_price_per_gram_eur);
  if v_rate is not null then
    return v_rate;
  end if;

  if p.default_price_eur is null then
    return null;
  end if;

  if v_gs > 0 then
    return p.default_price_eur / v_gs;
  end if;

  return p.default_price_eur;
end;
$$;

create or replace function public.club_menu_unit_price(p public.inventory_products)
returns numeric
language plpgsql
stable
set search_path = public
as $$
declare
  v_amt numeric;
  v_rate numeric;
  v_gs numeric;
begin
  v_gs := coalesce(p.default_sale_grams, 0);

  v_amt := coalesce(p.retail_price_eur, p.default_price_eur);
  if v_amt is not null then
    return v_amt;
  end if;

  v_rate := public.club_menu_gram_rate(p);
  if v_rate is not null then
    if v_gs > 0 then
      return v_rate * v_gs;
    end if;
    return v_rate;
  end if;

  return null;
end;
$$;

create or replace function public.club_menu_price_from_sales(p public.inventory_products)
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_last_unit numeric;
  v_avg_per_g numeric;
begin
  select d.price_charged_eur into v_last_unit
  from public.tpv_dispenses d
  where d.product_id = p.id
    and coalesce(d.price_charged_eur, 0) > 0
  order by d.created_at desc
  limit 1;

  if coalesce(p.sale_unit, 'grams') = 'unit' then
    return v_last_unit;
  end if;

  select avg(d.price_charged_eur / nullif(d.grams_charged, 0)) into v_avg_per_g
  from public.tpv_dispenses d
  where d.product_id = p.id
    and coalesce(d.price_charged_eur, 0) > 0
    and coalesce(d.grams_charged, 0) > 0
    and d.created_at > (now() - interval '365 days');

  return v_avg_per_g;
end;
$$;

create or replace function public.club_menu_price_value(p public.inventory_products)
returns numeric
language plpgsql
stable
set search_path = public
as $$
declare
  v numeric;
begin
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

create or replace function public.club_menu_price_label(p public.inventory_products)
returns text
language plpgsql
stable
set search_path = public
as $$
declare
  v numeric;
begin
  v := public.club_menu_price_value(p);

  if v is null then
    return '—';
  end if;

  if coalesce(p.sale_unit, 'grams') = 'unit' then
    return trim(to_char(v, 'FM999999990.00')) || ' €';
  end if;

  return trim(to_char(v, 'FM999999990.00')) || ' €/g';
end;
$$;

create or replace function public.club_menu_price_sort(p public.inventory_products)
returns numeric
language plpgsql
stable
set search_path = public
as $$
begin
  return public.club_menu_price_value(p);
end;
$$;

alter function public.club_menu_gram_rate(public.inventory_products) owner to postgres;
alter function public.club_menu_unit_price(public.inventory_products) owner to postgres;
alter function public.club_menu_price_from_sales(public.inventory_products) owner to postgres;
alter function public.club_menu_price_value(public.inventory_products) owner to postgres;
alter function public.club_menu_price_label(public.inventory_products) owner to postgres;
alter function public.club_menu_price_sort(public.inventory_products) owner to postgres;
