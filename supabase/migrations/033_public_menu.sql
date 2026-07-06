-- Menú público en tablet: slug del club, sativa/indica en categoría weed, RPC lectura anónima.

alter table public.clubs
  add column if not exists menu_slug text;

alter table public.clubs
  add column if not exists menu_enabled boolean not null default false;

create unique index if not exists clubs_menu_slug_unique_idx
  on public.clubs (lower(menu_slug))
  where menu_slug is not null and trim(menu_slug) <> '';

comment on column public.clubs.menu_slug is 'Ruta pública: /menu/{menu_slug}';
comment on column public.clubs.menu_enabled is 'Si true, el menú tablet es visible con anon key.';

alter table public.inventory_categories
  add column if not exists menu_show_strain boolean not null default false;

comment on column public.inventory_categories.menu_show_strain is
  'Si true, productos de esta categoría pueden mostrar Sativa/Indica en menú y ficha.';

alter table public.inventory_products
  add column if not exists cannabis_strain text;

alter table public.inventory_products
  drop constraint if exists inventory_products_cannabis_strain_check;

alter table public.inventory_products
  add constraint inventory_products_cannabis_strain_check
  check (cannabis_strain is null or cannabis_strain in ('sativa', 'indica'));

comment on column public.inventory_products.cannabis_strain is
  'Solo si la categoría tiene menu_show_strain: sativa o indica.';

-- ---------------------------------------------------------------------------
-- Ajustes menú (admin / empleado del club)
-- ---------------------------------------------------------------------------
create or replace function public.club_update_public_menu_settings(
  p_enabled boolean,
  p_slug text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_club uuid;
  v_slug text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select u.club_id into v_club
  from public.users u
  where u.id = auth.uid();

  if v_club is null and not public.is_superadmin() then
    select ca.club_id into v_club
    from public.club_access ca
    where ca.auth_user_id = auth.uid()
    limit 1;
  end if;

  if v_club is null then
    raise exception 'sin club asignado';
  end if;

  v_slug := lower(trim(coalesce(p_slug, '')));
  if v_slug <> '' and v_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' then
    raise exception 'slug inválido: solo minúsculas, números y guiones';
  end if;

  if coalesce(p_enabled, false) and v_slug = '' then
    raise exception 'indica un slug para activar el menú';
  end if;

  update public.clubs
  set
    menu_enabled = coalesce(p_enabled, false),
    menu_slug = nullif(v_slug, '')
  where id = v_club;
end;
$$;

alter function public.club_update_public_menu_settings(boolean, text) owner to postgres;
grant execute on function public.club_update_public_menu_settings(boolean, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Etiqueta de precio para menú
-- ---------------------------------------------------------------------------
create or replace function public.club_menu_price_label(p public.inventory_products)
returns text
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
    if v_amt is null then
      return '—';
    end if;
    return trim(to_char(v_amt, 'FM999999990.00')) || ' €';
  end if;

  v_rate := coalesce(p.retail_price_eur, p.default_price_per_gram_eur);
  if v_rate is null and p.default_price_eur is not null then
    if coalesce(p.default_sale_grams, 0) > 0 then
      v_rate := p.default_price_eur / p.default_sale_grams;
    else
      v_rate := p.default_price_eur;
    end if;
  end if;

  if v_rate is null then
    return '—';
  end if;

  return trim(to_char(v_rate, 'FM999999990.00')) || ' €/g';
end;
$$;

alter function public.club_menu_price_label(public.inventory_products) owner to postgres;

-- ---------------------------------------------------------------------------
-- Menú público (anon): solo nombre, precio, emoji, sativa/indica si aplica
-- ---------------------------------------------------------------------------
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
                select jsonb_agg(prod_row order by prod_row ->> 'name')
                from (
                  select jsonb_build_object(
                    'name', ip.name,
                    'emoji', coalesce(ip.emoji, ''),
                    'price_label', public.club_menu_price_label(ip),
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
