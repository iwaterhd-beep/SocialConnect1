-- =============================================================================
-- Social Connect V2 — Esquema inicial (Supabase)
-- Ejecutar en: SQL Editor → New query → Run
-- Antes: Authentication → Settings → desactiva "Confirm email" si quieres login inmediato en dev
-- =============================================================================

-- Limpiar objetos previos (orden seguro aunque las tablas NO existan todavía).
-- No uses DROP POLICY aquí: en Postgres falla si la tabla no existe (42P01).
-- CASCADE en las tablas elimina políticas RLS y dependencias.

drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();

drop table if exists public.club_access cascade;
drop table if exists public.users cascade;
drop table if exists public.clubs cascade;

drop function if exists public.is_superadmin();
drop type if exists public.user_role;

-- Rol de aplicación (coincide con el enum pedido)
create type public.user_role as enum ('superadmin', 'admin_club', 'empleado');

-- ---------------------------------------------------------------------------
-- Tabla: clubs
-- ---------------------------------------------------------------------------
create table public.clubs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  cif text not null default '',
  address text not null default '',
  phone text not null default '',
  email text not null default '',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index clubs_is_active_idx on public.clubs (is_active);

-- ---------------------------------------------------------------------------
-- Tabla: users (perfil vinculado a auth.users; la contraseña vive solo en Auth)
-- ---------------------------------------------------------------------------
create table public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  role public.user_role not null default 'empleado',
  club_id uuid references public.clubs (id) on delete set null
);

create index users_club_id_idx on public.users (club_id);
create index users_role_idx on public.users (role);

-- ---------------------------------------------------------------------------
-- Tabla: club_access (credenciales por club; password gestionado por Supabase Auth)
-- ---------------------------------------------------------------------------
create table public.club_access (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  email text not null,
  role public.user_role not null check (role in ('admin_club', 'empleado')),
  auth_user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (email)
);

create index club_access_club_id_idx on public.club_access (club_id);

-- ---------------------------------------------------------------------------
-- Función helper: debe existir ANTES de las políticas RLS que la referencian
-- SECURITY DEFINER evita recursión RLS al leer el rol.
-- ---------------------------------------------------------------------------
create or replace function public.is_superadmin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.users u
    where u.id = auth.uid()
      and u.role = 'superadmin'::public.user_role
  );
$$;

grant execute on function public.is_superadmin() to authenticated, anon;

-- ---------------------------------------------------------------------------
-- Trigger: al crear usuario en Auth, crear fila en public.users (+ club_access si aplica)
-- ---------------------------------------------------------------------------
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

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.clubs enable row level security;
alter table public.users enable row level security;
alter table public.club_access enable row level security;

-- Clubs: superadmin todo; resto solo su club si está activo
create policy "clubs_select"
  on public.clubs for select
  using (
    public.is_superadmin()
    or (
      exists (
        select 1 from public.users u
        where u.id = auth.uid()
          and u.club_id = clubs.id
          and clubs.is_active = true
      )
    )
  );

create policy "clubs_insert_superadmin"
  on public.clubs for insert
  with check (public.is_superadmin());

create policy "clubs_update_superadmin"
  on public.clubs for update
  using (public.is_superadmin())
  with check (public.is_superadmin());

-- users
create policy "users_select_self_or_superadmin"
  on public.users for select
  using (id = auth.uid() or public.is_superadmin());

-- Insert: superadmin, trigger interno (roles sistema), o alta club vía signup (política aparte)
create policy "users_insert_superadmin"
  on public.users for insert
  with check (
    public.is_superadmin()
    or pg_trigger_depth() > 0
    or current_user::text in ('postgres', 'supabase_admin', 'supabase_auth_admin', 'authenticator')
  );

create policy "users_insert_own_signup"
  on public.users for insert
  with check (
    auth.uid() = id
    and role in ('admin_club'::public.user_role, 'empleado'::public.user_role)
  );

create policy "users_update_own_signup"
  on public.users for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

create policy "users_update_superadmin"
  on public.users for update
  using (public.is_superadmin())
  with check (public.is_superadmin());

-- club_access
create policy "club_access_select"
  on public.club_access for select
  using (
    public.is_superadmin()
    or exists (
      select 1 from public.users u
      where u.id = auth.uid()
        and u.club_id = club_access.club_id
    )
  );

create policy "club_access_insert_superadmin"
  on public.club_access for insert
  with check (
    public.is_superadmin()
    or pg_trigger_depth() > 0
    or current_user::text in ('postgres', 'supabase_admin', 'supabase_auth_admin', 'authenticator')
  );

create policy "club_access_insert_own_signup"
  on public.club_access for insert
  with check (auth.uid() = auth_user_id);

create policy "club_access_delete_superadmin"
  on public.club_access for delete
  using (public.is_superadmin());

-- USAGE en esquema public (sin esto: "permission denied for schema public")
grant usage on schema public to anon, authenticated, service_role;

-- Permisos API (RLS sigue aplicando)
grant select, insert, update, delete on public.clubs to authenticated;
grant select, insert, update, delete on public.users to authenticated;
grant select, insert, update, delete on public.club_access to authenticated;

grant usage on type public.user_role to authenticated;
