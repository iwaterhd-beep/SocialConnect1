-- =============================================================================
-- Si sigue "Database error creating new user":
-- 1) Políticas RLS: permitir INSERT en public.users / club_access cuando el
--    INSERT viene del trigger (pg_trigger_depth > 0).
-- 2) Trigger: set_config('row_security','off') dentro del cuerpo.
-- 3) En Auth usa email tipo admin@example.com — *.local suele ser rechazado.
-- Ejecutar todo el bloque en SQL Editor (PostgreSQL 14+).
-- =============================================================================

drop policy if exists "users_insert_superadmin" on public.users;
create policy "users_insert_superadmin"
  on public.users for insert
  with check (public.is_superadmin() or pg_trigger_depth() > 0);

drop policy if exists "club_access_insert_superadmin" on public.club_access;
create policy "club_access_insert_superadmin"
  on public.club_access for insert
  with check (public.is_superadmin() or pg_trigger_depth() > 0);

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
  perform set_config('row_security', 'off', true);
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
