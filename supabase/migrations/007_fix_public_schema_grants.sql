-- =============================================================================
-- Error: "permission denied for schema public" al leer public.users desde la app
-- Causa: faltan permisos USAGE en el esquema public para anon / authenticated.
-- Ejecuta en SQL Editor (una vez).
-- =============================================================================

grant usage on schema public to postgres, anon, authenticated, service_role;

grant all on all tables in schema public to postgres, anon, authenticated, service_role;
grant all on all sequences in schema public to postgres, anon, authenticated, service_role;
grant all on all routines in schema public to postgres, anon, authenticated, service_role;

alter default privileges in schema public grant all on tables to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on routines to postgres, anon, authenticated, service_role;
