-- Añade el tipo Híbrida al campo cannabis_strain del inventario.

alter table public.inventory_products
  drop constraint if exists inventory_products_cannabis_strain_check;

alter table public.inventory_products
  add constraint inventory_products_cannabis_strain_check
  check (cannabis_strain is null or cannabis_strain in ('sativa', 'indica', 'hibrida'));

comment on column public.inventory_products.cannabis_strain is
  'Solo si la categoría tiene menu_show_strain: sativa, indica o hibrida.';

-- Redefinir club_public_menu para que la carta muestre también el tipo Híbrida.
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
  v_currency text;
  v_has_archived boolean;
begin
  if coalesce(trim(p_slug), '') = '' then
    return jsonb_build_object('ok', false, 'error', 'missing_slug');
  end if;

  select
    c.id,
    c.name,
    coalesce(nullif(trim(c.currency_symbol), ''), '€')
  into v_club_id, v_club_name, v_currency
  from public.clubs c
  where c.is_active = true
    and c.menu_enabled = true
    and lower(c.menu_slug) = lower(trim(p_slug))
  limit 1;

  if v_club_id is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  if v_currency is null or v_currency = '' then
    v_currency := '€';
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
    'currency_symbol', v_currency,
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
                    'image_path', nullif(trim(ip.image_path), ''),
                    'price_label', public.club_menu_price_label(ip),
                    'price_sort', public.club_menu_price_sort(ip),
                    'strain',
                    case
                      when coalesce(ic.menu_show_strain, false)
                        and ip.cannabis_strain in ('sativa', 'indica', 'hibrida')
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