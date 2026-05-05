-- =============================================================================
-- Corrección: "Database error creating new user" al crear usuario en Dashboard
--
-- El trigger handle_new_user inserta en public.users (y club_access). Las
-- políticas RLS exigen superadmin; al crear el usuario desde el panel NO hay
-- sesión JWT → el INSERT fallaba.
--
-- Solución: row_security = off en esta función SECURITY DEFINER (solo para el
-- código interno del trigger).
--
-- Ejecutar en SQL Editor (después de 001).
-- =============================================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  meta_role text;
  meta_club text;
  resolved_role public.user_role;
  resolved_club uuid;
begin
  meta_role := coalesce(
    nullif((coalesce(new.user_metadata, '{}'::jsonb))->>'role', ''),
    nullif((coalesce(new.raw_user_meta_data, '{}'::jsonb))->>'role', ''),
    'empleado'
  );
  meta_club := coalesce(
    nullif((coalesce(new.user_metadata, '{}'::jsonb))->>'club_id', ''),
    nullif((coalesce(new.raw_user_meta_data, '{}'::jsonb))->>'club_id', '')
  );

  begin
    resolved_role := meta_role::public.user_role;
  exception when others then
    resolved_role := 'empleado';
  end;

  if meta_club is not null and meta_club <> '' then
    begin
      resolved_club := meta_club::uuid;
    exception when others then
      resolved_club := null;
    end;
  else
    resolved_club := null;
  end if;

  insert into public.users (id, email, role, club_id)
  values (new.id, new.email, resolved_role, resolved_club)
  on conflict (id) do update
    set email = excluded.email,
        role = excluded.role,
        club_id = excluded.club_id;

  if resolved_club is not null and resolved_role in ('admin_club', 'empleado') then
    insert into public.club_access (club_id, email, role, auth_user_id)
    values (resolved_club, new.email, resolved_role, new.id)
    on conflict (email) do update
      set club_id = excluded.club_id,
          role = excluded.role,
          auth_user_id = excluded.auth_user_id;
  end if;

  return new;
end;
$$;
