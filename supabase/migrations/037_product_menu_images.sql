-- Fotos de producto para menú tablet (bucket público de lectura).

alter table public.inventory_products
  add column if not exists image_path text not null default '';

comment on column public.inventory_products.image_path is
  'Ruta en Storage (club_product_images/{club_id}/{product_id}.ext) para menú tablet.';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'club_product_images',
  'club_product_images',
  true,
  2097152,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Lectura pública (menú anon); escritura solo staff del club.
drop policy if exists "club_product_images_select" on storage.objects;
create policy "club_product_images_select"
  on storage.objects for select
  to public
  using (bucket_id = 'club_product_images');

drop policy if exists "club_product_images_insert" on storage.objects;
create policy "club_product_images_insert"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'club_product_images'
    and public.current_user_can_edit_inventory()
    and (
      public.is_superadmin()
      or exists (
        select 1 from public.users u
        where u.id = auth.uid()
          and u.club_id is not null
          and u.club_id::text = split_part(name, '/', 1)
      )
      or exists (
        select 1 from public.club_access ca
        where ca.auth_user_id = auth.uid()
          and ca.club_id::text = split_part(name, '/', 1)
          and ca.can_edit_inventory = true
      )
    )
  );

drop policy if exists "club_product_images_update" on storage.objects;
create policy "club_product_images_update"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'club_product_images'
    and public.current_user_can_edit_inventory()
    and (
      public.is_superadmin()
      or exists (
        select 1 from public.users u
        where u.id = auth.uid()
          and u.club_id is not null
          and u.club_id::text = split_part(name, '/', 1)
      )
      or exists (
        select 1 from public.club_access ca
        where ca.auth_user_id = auth.uid()
          and ca.club_id::text = split_part(name, '/', 1)
          and ca.can_edit_inventory = true
      )
    )
  )
  with check (
    bucket_id = 'club_product_images'
    and public.current_user_can_edit_inventory()
    and (
      public.is_superadmin()
      or exists (
        select 1 from public.users u
        where u.id = auth.uid()
          and u.club_id is not null
          and u.club_id::text = split_part(name, '/', 1)
      )
      or exists (
        select 1 from public.club_access ca
        where ca.auth_user_id = auth.uid()
          and ca.club_id::text = split_part(name, '/', 1)
          and ca.can_edit_inventory = true
      )
    )
  );

drop policy if exists "club_product_images_delete" on storage.objects;
create policy "club_product_images_delete"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'club_product_images'
    and public.current_user_can_edit_inventory()
    and (
      public.is_superadmin()
      or exists (
        select 1 from public.users u
        where u.id = auth.uid()
          and u.club_id is not null
          and u.club_id::text = split_part(name, '/', 1)
      )
      or exists (
        select 1 from public.club_access ca
        where ca.auth_user_id = auth.uid()
          and ca.club_id::text = split_part(name, '/', 1)
          and ca.can_edit_inventory = true
      )
    )
  );

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
                    'image_path', nullif(trim(ip.image_path), ''),
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
