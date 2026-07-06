-- Tipo de medida del producto en TPV: gramos o unidad.
-- Ejecutar después de 015_inventory_price_per_gram.sql.

alter table public.inventory_products
  add column if not exists sale_unit text not null default 'grams'
    check (sale_unit in ('grams', 'unit'));

comment on column public.inventory_products.sale_unit is
  'Unidad de venta en TPV: grams (por peso) o unit (por unidades).';
