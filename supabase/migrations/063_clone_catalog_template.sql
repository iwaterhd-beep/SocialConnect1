-- =============================================================================
-- 063: Plantilla de catálogo al crear un club nuevo.
--
-- Añade `is_template` a `clubs`. El club marcado como plantilla emite su
-- catálogo (categorías + productos) a todo club nuevo que se cree.
--
-- Se marca como plantilla al club "Prueba" (bf4fe979-...). Para cambiar el
-- origen del catálogo:
--     update public.clubs set is_template = false;
--     update public.clubs set is_template = true where id = '<otro>';
-- =============================================================================

-- 1) Columna que marca qué club actúa de plantilla
alter table public.clubs
  add column if not exists is_template boolean not null default false;

create index if not exists clubs_is_template_idx on public.clubs (is_template);

-- 2) Marcar "Prueba" como plantilla (y quitar el flag al resto)
update public.clubs set is_template = (id = 'bf4fe979-ef81-470f-a974-a16ab6bfb2ef');

-- 3) RPC interno: clona categorías y productos desde el club plantilla
create or replace function public.clone_club_catalog(p_template uuid, p_target uuid)
returns void
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  v_cat     record;
  v_dst_cat uuid;
  v_src_ids uuid[] := array[]::uuid[];
  v_dst_ids uuid[] := array[]::uuid[];
  v_rec     record;
  v_pos     int;
begin
  perform set_config('row_security', 'off', true);

  -- Categorías (created_at lo pone el DEFAULT)
  for v_cat in
    select * from public.inventory_categories where club_id = p_template
  loop
    insert into public.inventory_categories (club_id, name, sort_order, menu_show_strain)
    values (p_target, v_cat.name, v_cat.sort_order, v_cat.menu_show_strain)
    returning id into v_dst_cat;

    v_src_ids := array_append(v_src_ids, v_cat.id);
    v_dst_ids := array_append(v_dst_ids, v_dst_cat);
  end loop;

  -- Productos (re-asignando categoría origen -> destino)
  for v_rec in
    select
      name, emoji, bottle_weight_grams, stock_grams, stock_alert_grams,
      default_sale_grams, default_price_eur, default_price_per_gram_eur, sale_unit,
      purchase_cost_eur, retail_price_eur, is_archived, category_id,
      cannabis_strain, menu_price_eur, image_path
    from public.inventory_products
    where club_id = p_template
  loop
    v_dst_cat := null;
    if v_rec.category_id is not null then
      v_pos := array_position(v_src_ids, v_rec.category_id);
      if v_pos is not null then
        v_dst_cat := v_dst_ids[v_pos];
      end if;
    end if;

    insert into public.inventory_products
      (club_id, category_id, name, emoji, bottle_weight_grams, stock_grams,
       stock_alert_grams, default_sale_grams, default_price_eur, default_price_per_gram_eur,
       sale_unit, purchase_cost_eur, retail_price_eur, is_archived, image_path,
       cannabis_strain, menu_price_eur)
    values
      (p_target, v_dst_cat, v_rec.name, v_rec.emoji, v_rec.bottle_weight_grams,
       v_rec.stock_grams, v_rec.stock_alert_grams, v_rec.default_sale_grams,
       v_rec.default_price_eur, v_rec.default_price_per_gram_eur, v_rec.sale_unit,
       v_rec.purchase_cost_eur, v_rec.retail_price_eur, v_rec.is_archived, v_rec.image_path,
       v_rec.cannabis_strain, v_rec.menu_price_eur);
  end loop;
end;
$$;

-- 4) Trigger: al crear un club (que no sea plantilla), heredar su catálogo
create or replace function public.clone_template_for_new_club()
returns trigger
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  v_template uuid;
begin
  if new.is_template then
    return new;
  end if;

  select id into v_template
    from public.clubs
    where is_template = true
    order by created_at asc
    limit 1;

  if v_template is not null then
    perform public.clone_club_catalog(v_template, new.id);
  end if;

  return new;
end;
$$;

drop trigger if exists clubs_clone_catalog_after_insert on public.clubs;
create trigger clubs_clone_catalog_after_insert
  after insert on public.clubs
  for each row execute function public.clone_template_for_new_club();

alter function public.clone_club_catalog(uuid, uuid) owner to postgres;
alter function public.clone_template_for_new_club() owner to postgres;