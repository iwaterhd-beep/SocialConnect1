-- Menú público: ordenar productos por precio (menor a mayor) dentro de cada categoría.

create or replace function public.club_menu_price_sort(p public.inventory_products)
returns numeric
language plpgsql
stable
set search_path = public
as $$
declare
  v_rate numeric;
  v_amt numeric;
begin
  if p.sale_unit = 'unit' then
    v_amt := coalesce(p.retail_price_eur, p.default_price_eur);
    return v_amt;
  end if;

  v_rate := coalesce(p.retail_price_eur, p.default_price_per_gram_eur);
  if v_rate is null and p.default_price_eur is not null then
    if coalesce(p.default_sale_grams, 0) > 0 then
      v_rate := p.default_price_eur / p.default_sale_grams;
    else
      v_rate := p.default_price_eur;
    end if;
  end if;

  return v_rate;
end;
$$;

alter function public.club_menu_price_sort(public.inventory_products) owner to postgres;

create or replace function public.club_public_menu(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_club_id uuid;
  v_club_name text;
  v_has_archived boolean;
begin
  if coalesce(trim(p_slug), '') = '' then
    return jsonb_build_object('ok', false, 'error', 'missing_slug');
  end if;

  select c.id, c.name into v_club_id, v_club_name
  from public.clubs c
  where c.is_active = true
    and c.menu_enabled = true
    and lower(c.menu_slug) = lower(trim(p_slug))
  limit 1;

  if v_club_id is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'inventory_products'
      and column_name = 'is_archived'
  ) into v_has_archived;

  return jsonb_build_object(
    'ok', true,
    'club_name', v_club_name,
    'categories',
    coalesce(
      (
        select jsonb_agg(cat_row order by (cat_row ->> 'sort_order')::int, cat_row ->> 'name')
        from (
          select jsonb_build_object(
            'id', ic.id,
            'name', ic.name,
            'sort_order', ic.sort_order,
            'show_strain', coalesce(ic.menu_show_strain, false),
            'products',
            coalesce(
              (
                select jsonb_agg(prod_row order by
                  case
                    when (prod_row ->> 'price_sort') is null then 1
                    else 0
                  end,
                  (prod_row ->> 'price_sort')::numeric,
                  prod_row ->> 'name'
                )
                from (
                  select jsonb_build_object(
                    'name', ip.name,
                    'emoji', coalesce(ip.emoji, ''),
                    'price_label', public.club_menu_price_label(ip),
                    'price_sort', public.club_menu_price_sort(ip),
                    'strain',
                    case
                      when coalesce(ic.menu_show_strain, false)
                        and ip.cannabis_strain in ('sativa', 'indica')
                      then ip.cannabis_strain
                      else null
                    end
                  ) as prod_row
                  from public.inventory_products ip
                  where ip.club_id = v_club_id
                    and ip.category_id = ic.id
                    and coalesce(ip.stock_grams, 0) > 0
                    and (
                      not v_has_archived
                      or coalesce(ip.is_archived, false) = false
                    )
                ) prods
              ),
              '[]'::jsonb
            )
          ) as cat_row
          from public.inventory_categories ic
          where ic.club_id = v_club_id
            and exists (
              select 1
              from public.inventory_products ip2
              where ip2.club_id = v_club_id
                and ip2.category_id = ic.id
                and coalesce(ip2.stock_grams, 0) > 0
                and (
                  not v_has_archived
                  or coalesce(ip2.is_archived, false) = false
                )
            )
        ) cats
      ),
      '[]'::jsonb
    )
  );
end;
$$;

alter function public.club_public_menu(text) owner to postgres;
grant execute on function public.club_public_menu(text) to anon, authenticated;
