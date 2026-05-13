-- Productos archivados: no aparecen en inventario/TPV pero se conservan por ventas (tpv_dispenses) o ajustes (+/-).
-- Tras ejecutar, el cliente puede "eliminar" archivando cuando no permita DELETE por FK.

alter table public.inventory_products
  add column if not exists is_archived boolean not null default false;

comment on column public.inventory_products.is_archived is
  'Si true, el producto no se lista en TPV/inventario activo; la fila permanece por histórico (dispensaciones, ajustes).';

create index if not exists inventory_products_club_active_idx
  on public.inventory_products (club_id)
  where is_archived = false;
