-- Permite al admin del club eliminar empleados (club_access + perfil + cuenta Auth).

create or replace function public.club_remove_worker(p_access_id uuid)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_admin_club uuid;
  v_row public.club_access%rowtype;
  v_auth_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Sesión no válida.';
  end if;

  select u.club_id into v_admin_club
  from public.users u
  where u.id = auth.uid()
    and u.role = 'admin_club'::public.user_role;

  if v_admin_club is null then
    raise exception 'Solo el administrador del club puede eliminar trabajadores.';
  end if;

  select * into v_row
  from public.club_access
  where id = p_access_id;

  if not found then
    raise exception 'Trabajador no encontrado.';
  end if;

  if v_row.club_id <> v_admin_club then
    raise exception 'No puedes eliminar trabajadores de otro club.';
  end if;

  if v_row.role <> 'empleado'::public.user_role then
    raise exception 'Solo se pueden eliminar cuentas de empleado.';
  end if;

  if v_row.auth_user_id is not null and v_row.auth_user_id = auth.uid() then
    raise exception 'No puedes eliminarte a ti mismo.';
  end if;

  v_auth_id := v_row.auth_user_id;

  delete from public.club_access where id = p_access_id;

  if v_auth_id is not null then
    delete from public.users where id = v_auth_id and club_id = v_admin_club;
    delete from auth.users where id = v_auth_id;
  end if;
end;
$$;

alter function public.club_remove_worker(uuid) owner to postgres;
grant execute on function public.club_remove_worker(uuid) to authenticated;
