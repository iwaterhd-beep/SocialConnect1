-- =============================================================================
-- FIX DEFINITIVO: "Database error creating new user" al crear usuario en Dashboard
--
-- Causas típicas:
-- 1) RLS evalúa pg_trigger_depth() = 0 dentro del WITH CHECK del INSERT del trigger.
-- 2) La función trigger debe ejecutarse como rol que pueda pasar políticas (owner postgres).
--
-- Ejecuta TODO este archivo en SQL Editor (una sola vez).
-- =============================================================================

-- Propietario de la función = postgres (mejor compatibilidad con RLS interno)
alter function public.handle_new_user() owner to postgres;

-- Políticas INSERT: superadmin, trigger interno, o rol de sistema que ejecuta el trigger
drop policy if exists "users_insert_superadmin" on public.users;
create policy "users_insert_superadmin"
  on public.users for insert
  with check (
    public.is_superadmin()
    or pg_trigger_depth() > 0
    or current_user::text in (
      'postgres',
      'supabase_admin',
      'supabase_auth_admin',
      'authenticator'
    )
  );

drop policy if exists "club_access_insert_superadmin" on public.club_access;
create policy "club_access_insert_superadmin"
  on public.club_access for insert
  with check (
    public.is_superadmin()
    or pg_trigger_depth() > 0
    or current_user::text in (
      'postgres',
      'supabase_admin',
      'supabase_auth_admin',
      'authenticator'
    )
  );

-- Alta desde la propia sesión (signUp club / respaldo si el trigger falla)
drop policy if exists "users_insert_own_signup" on public.users;
create policy "users_insert_own_signup"
  on public.users for insert
  with check (
    auth.uid() = id
    and role in ('admin_club'::public.user_role, 'empleado'::public.user_role)
  );

drop policy if exists "users_update_own_signup" on public.users;
create policy "users_update_own_signup"
  on public.users for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

drop policy if exists "club_access_insert_own_signup" on public.club_access;
create policy "club_access_insert_own_signup"
  on public.club_access for insert
  with check (auth.uid() = auth_user_id);

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

alter function public.handle_new_user() owner to postgres;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =============================================================================
-- PLAN B (solo si lo anterior SIGUE fallando al crear usuario en el panel):
-- 1) Ejecuta la sección siguiente (descomenta DROP TRIGGER).
-- 2) Crea el usuario admin@example.com en Authentication → Users.
-- 3) Ejecuta el INSERT final enlazando auth.users → public.users.
-- =============================================================================

-- drop trigger if exists on_auth_user_created on auth.users;
-- drop function if exists public.handle_new_user();

-- insert into public.users (id, email, role, club_id)
-- select id, email, 'superadmin'::public.user_role, null
-- from auth.users
-- where email = 'admin@example.com'
-- on conflict (id) do update
--   set role = excluded.role,
--       email = excluded.email,
--       club_id = excluded.club_id;
