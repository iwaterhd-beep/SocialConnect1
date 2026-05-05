-- =============================================================================
-- Inventario: alerta de stock mínimo + valores por defecto para TPV rápido
-- Ejecutar después de 008_inventory_tpv.sql
-- =============================================================================

alter table public.inventory_products
  add column if not exists stock_alert_grams numeric(14, 3) not null default 0
    check (stock_alert_grams >= 0);

alter table public.inventory_products
  add column if not exists default_sale_grams numeric(14, 3);

alter table public.inventory_products
  add column if not exists default_price_eur numeric(12, 2)
    check (default_price_eur is null or default_price_eur >= 0);

comment on column public.inventory_products.stock_alert_grams is
  'Umbral para avisos de stock bajo en panel (0 = sin alerta por mínimo).';

comment on column public.inventory_products.default_sale_grams is
  'Gramos sugeridos en ticket al seleccionar producto en TPV (opcional).';

comment on column public.inventory_products.default_price_eur is
  'Precio € sugerido al seleccionar producto en TPV (opcional).';
