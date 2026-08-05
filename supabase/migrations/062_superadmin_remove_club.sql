-- =============================================================================
-- 062: RPC superadmin_remove_club — elimina un club completo (historial incluido)
--
-- Borra en orden de dependencias (hijos antes que padres) porque varias tablas
-- con club_id NO tienen FK a clubs (no limpiarían en cascada) y hay RESTRICT.
-- Irreversible: afecta a socios, inventario, dispensaciones, finanzas, turnos,
-- categorías, proveedores y cuentas de usuario del club.
-- =============================================================================

drop function if exists public.superadmin_remove_club(uuid);
create function public.superadmin_remove_club(p_club_id uuid)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_club_name text;
begin
  if auth.uid() is null then
    raise exception 'Sesión no válida.';
  end if;

  if not public.is_superadmin() then
    raise exception 'Solo el superadministrador puede eliminar clubes.';
  end if;

  select name into v_club_name from public.clubs where id = p_club_id;
  if not found then
    raise exception 'Club no encontrado.';
  end if;

  -- Quitar auto-referencias entre miembros del club para permitir el borrado
  update public.club_members
  set avalista_member_id = null, guarantor_member_id = null
  where club_id = p_club_id;

  -- Hijos antes que padres (evitar RESTRICT y huérfanos)
  delete from public.tpv_dispenses where club_id = p_club_id;
  delete from public.club_member_check_ins where club_id = p_club_id;
  delete from public.club_member_dues_payments where club_id = p_club_id;
  delete from public.club_member_wallet_ledger where club_id = p_club_id;
  delete from public.club_membership_reward_grants
    where club_id = p_club_id
       or member_id in (select id from public.club_members where club_id = p_club_id)
       or product_id in (select id from public.inventory_products where club_id = p_club_id);
  delete from public.club_membership_rewards where club_id = p_club_id;
  delete from public.club_supplier_purchase_lines where club_id = p_club_id;
  delete from public.club_supplier_purchases where club_id = p_club_id;
  delete from public.club_supplier_ledger where club_id = p_club_id;
  delete from public.club_suppliers where club_id = p_club_id;
  delete from public.club_member_counters where club_id = p_club_id;
  delete from public.shift_stock_events where club_id = p_club_id;
  delete from public.inventory_stock_adjustments where club_id = p_club_id;
  delete from public.club_membership_tiers where club_id = p_club_id;
  delete from public.inventory_products where club_id = p_club_id;
  delete from public.inventory_categories where club_id = p_club_id;
  delete from public.club_members where club_id = p_club_id;
  delete from public.shifts where club_id = p_club_id;
  delete from public.club_access where club_id = p_club_id;

  -- Perfiles y cuentas de Auth del club
  delete from auth.users
  where id in (select id from public.users where club_id = p_club_id);
  delete from public.users where club_id = p_club_id;

  delete from public.clubs where id = p_club_id;
end;
$$;

alter function public.superadmin_remove_club(uuid) owner to postgres;
grant execute on function public.superadmin_remove_club(uuid) to authenticated;