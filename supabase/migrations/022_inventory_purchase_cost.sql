-- Coste de compra por unidad de stock (€/g o €/ud) para valorar inventario en Finanzas (solo uso admin).
-- Ejecutar después de 020_inventory_adjustments.sql (o cualquier migración que deje inventory_products estable).

alter table public.inventory_products
  add column if not exists purchase_cost_eur numeric(14, 4)
    check (purchase_cost_eur is null or purchase_cost_eur >= 0);

comment on column public.inventory_products.purchase_cost_eur is
  'Coste al que compras: por gramo si sale_unit = grams, por unidad si sale_unit = unit. Valor stock ≈ stock_grams * purchase_cost_eur.';
