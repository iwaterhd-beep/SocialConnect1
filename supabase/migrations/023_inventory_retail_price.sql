-- Precio de venta de referencia por unidad de stock (€/g o €/ud) para valorar inventario "si se vendiera todo".
-- Ejecutar después de 022_inventory_purchase_cost.sql.

alter table public.inventory_products
  add column if not exists retail_price_eur numeric(14, 4)
    check (retail_price_eur is null or retail_price_eur >= 0);

comment on column public.inventory_products.retail_price_eur is
  'Precio al que vendes (referencia): por gramo si sale_unit = grams, por unidad si sale_unit = unit. Valor stock a venta ≈ stock_grams * retail_price_eur.';
