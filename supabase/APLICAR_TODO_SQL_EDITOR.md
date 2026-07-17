# Aplicar migraciones en Supabase SQL Editor

Ejecuta **una por una**, en este orden:

1. `supabase/migrations/008_inventory_tpv.sql`
2. `supabase/migrations/009_inventory_product_extras.sql`
3. `supabase/migrations/010_club_members_finance.sql`
4. `supabase/migrations/011_club_members_profile.sql`
5. `supabase/migrations/012_club_member_storage.sql`
6. `supabase/migrations/013_shift_stock_events.sql`
7. `supabase/migrations/014_shift_float_stock_rpc.sql`
8. `supabase/migrations/015_inventory_price_per_gram.sql`
9. `supabase/migrations/016_tpv_delete_dispense.sql`
10. `supabase/migrations/017_inventory_sale_unit.sql`
11. … (018–030 según lo que aún no tengas en el proyecto)
12. **`supabase/migrations/031_shift_stock_count_events.sql`** — contajes manuales siempre ligados al turno; devuelve JSON con descuadre. Si falla por tipo de retorno, el script ya incluye `DROP FUNCTION` antes de crear.
13. **`supabase/migrations/032_wallet_ledger_product_notes.sql`** — notas del monedero con nombre de producto en ventas TPV.
14. **`supabase/migrations/033_public_menu.sql`** — menú tablet público `/menu/?club=slug` y sativa/indica en categoría weed.
15. **`supabase/migrations/034_menu_sort_by_price.sql`** — productos del menú ordenados por precio (menor a mayor).
16. **`supabase/migrations/035_menu_price_fallback.sql`** — muestra precio aunque solo esté en TPV / última venta.
17. **`supabase/migrations/039_shift_stock_events_club_access_rls.sql`** — permite leer contajes de stock a trabajadores en `club_access` y vincula ajustes +/- al turno abierto.
18. **`supabase/migrations/045_club_members_rfid.sql`** — chapa RFID/NFC por socio (`rfid_uid`), única por club.

---

## Validacion rapida (pegar al final)

```sql
-- Tablas principales
select to_regclass('public.inventory_products') as inventory_products;
select to_regclass('public.tpv_dispenses') as tpv_dispenses;
select to_regclass('public.club_members') as club_members;
select to_regclass('public.shifts') as shifts;

-- Columnas nuevas esperadas
select column_name
from information_schema.columns
where table_schema = 'public'
  and table_name = 'inventory_products'
  and column_name in ('stock_alert_grams', 'default_sale_grams', 'default_price_eur', 'default_price_per_gram_eur', 'sale_unit')
order by column_name;

-- RPCs esperadas
select p.proname
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'club_register_tpv_dispense',
    'club_delete_tpv_dispense',
    'club_register_manual_stock_count',
    'club_set_stock_from_gross_weight',
    'club_staff_directory'
  )
order by p.proname;
```

Si todo sale bien, recarga `dashboard-club.html`.
