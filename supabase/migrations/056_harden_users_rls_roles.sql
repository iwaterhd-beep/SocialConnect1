-- =============================================================================
-- Endurecer roles: evitar escalada desde el cliente (user_metadata / UPDATE propio)
-- =============================================================================

-- 1) Trigger: nadie (salvo superadmin / trigger interno) puede cambiar role o club_id
create or replace function public.users_guard_privileged_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  if public.is_superadmin() then
    return new;
  end if;

  if current_user::text in ('postgres', 'supabase_admin', 'supabase_auth_admin') then
    return new;
  end if;

  if new.role is distinct from old.role then
    raise exception 'No puedes cambiar el rol de usuario';
  end if;

  if new.club_id is distinct from old.club_id then
    raise exception 'No puedes cambiar el club del usuario';
  end if;

  return new;
end;
$$;

alter function public.users_guard_privileged_columns() owner to postgres;

drop trigger if exists users_guard_privileged_columns_trg on public.users;
create trigger users_guard_privileged_columns_trg
  before update on public.users
  for each row
  execute function public.users_guard_privileged_columns();

-- 2) Quitar UPDATE libre de la propia fila (permitía role = superadmin)
drop policy if exists "users_update_own_signup" on public.users;

-- 3) INSERT propio: solo admin_club/empleado con club_id obligatorio
drop policy if exists "users_insert_own_signup" on public.users;
create policy "users_insert_own_signup"
  on public.users for insert
  with check (
    auth.uid() = id
    and role in ('admin_club'::public.user_role, 'empleado'::public.user_role)
    and club_id is not null
    and exists (select 1 from public.clubs c where c.id = club_id)
  );

-- 4) club_access INSERT propio: mismo uid, rol de club, club existente,
--    y alineado con public.users (o bootstrap si la fila users ya tiene ese club)
drop policy if exists "club_access_insert_own_signup" on public.club_access;
create policy "club_access_insert_own_signup"
  on public.club_access for insert
  with check (
    auth.uid() = auth_user_id
    and role in ('admin_club'::public.user_role, 'empleado'::public.user_role)
    and exists (select 1 from public.clubs c where c.id = club_id)
    and exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and u.club_id = club_access.club_id
        and u.role = club_access.role
        and u.role in ('admin_club'::public.user_role, 'empleado'::public.user_role)
    )
  );

-- 5) handle_new_user: nunca crear superadmin desde metadata; no sobrescribir role/club_id
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

  -- Preferir app_metadata (solo service role); user_metadata es editable por el usuario
  meta_role := coalesce(
    nullif((coalesce(new.raw_app_meta_data, '{}'::jsonb))->>'role', ''),
    nullif((coalesce(new.raw_user_meta_data, '{}'::jsonb))->>'role', ''),
    nullif((coalesce(new.user_metadata, '{}'::jsonb))->>'role', ''),
    'empleado'
  );

  meta_club := coalesce(
    nullif((coalesce(new.raw_app_meta_data, '{}'::jsonb))->>'club_id', ''),
    nullif((coalesce(new.raw_user_meta_data, '{}'::jsonb))->>'club_id', ''),
    nullif((coalesce(new.user_metadata, '{}'::jsonb))->>'club_id', '')
  );

  begin
    resolved_role := meta_role::public.user_role;
  exception when others then
    resolved_role := 'empleado';
  end;

  -- Nunca asignar superadmin desde el alta Auth (solo seed / SQL / panel controlado)
  if resolved_role = 'superadmin' then
    resolved_role := 'empleado';
    resolved_club := null;
  end if;

  if resolved_role not in ('admin_club', 'empleado') then
    resolved_role := 'empleado';
  end if;

  if meta_club is not null and meta_club <> '' and resolved_role in ('admin_club', 'empleado') then
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
    set email = excluded.email;
    -- No actualizar role ni club_id: evita escalada en reintentos / metadata manipulada

  if resolved_club is not null and resolved_role in ('admin_club', 'empleado') then
    insert into public.club_access (club_id, email, role, auth_user_id)
    values (resolved_club, new.email, resolved_role, new.id)
    on conflict (email) do update
      set auth_user_id = coalesce(club_access.auth_user_id, excluded.auth_user_id);
  end if;

  return new;
end;
$$;

alter function public.handle_new_user() owner to postgres;

-- 6) Admin de club no puede poner roles fuera de admin_club/empleado en club_access
drop policy if exists "club_access_update_admin" on public.club_access;
create policy "club_access_update_admin"
  on public.club_access
  for update
  to authenticated
  using (
    public.is_superadmin()
    or exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and u.role = 'admin_club'::public.user_role
        and u.club_id = club_access.club_id
    )
  )
  with check (
    (
      public.is_superadmin()
      or exists (
        select 1
        from public.users u
        where u.id = auth.uid()
          and u.role = 'admin_club'::public.user_role
          and u.club_id = club_access.club_id
      )
    )
    and (
      public.is_superadmin()
      or role in ('admin_club'::public.user_role, 'empleado'::public.user_role)
    )
  );
