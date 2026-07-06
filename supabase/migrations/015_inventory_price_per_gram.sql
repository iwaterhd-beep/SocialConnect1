-- Precio por gramo explícito para TPV (opcional). Si está definido, importe = gramos × €/g.
-- Ejecutar después de 009_inventory_product_extras.sql.

alter table public.inventory_products
  add column if not exists default_price_per_gram_eur numeric(12, 4)
    check (default_price_per_gram_eur is null or default_price_per_gram_eur >= 0);

comment on column public.inventory_products.default_price_per_gram_eur is
  '€ por gramo en TPV. Si no es null, cobro sugerido = gramos en ticket × este valor (prioridad sobre precio/gramos sugeridos).';
