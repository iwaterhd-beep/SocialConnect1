-- =============================================================================
-- SOLUCIÓN RÁPIDA — Si al crear usuario sale "Database error creating new user"
--
-- HAZLO EN ESTE ORDEN (tres momentos, no todo junto si no quieres).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- MOMENTO 1 — Copia SOLO esto en SQL Editor y pulsa Run (una vez).
-- Esto quita el trigger que suele bloquear la creación de usuarios en el panel.
-- -----------------------------------------------------------------------------

drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user() cascade;


-- -----------------------------------------------------------------------------
-- MOMENTO 2 — Ve a: Authentication → Users → Create user
--
--   Email:    admin@example.com
--   Password: la que quieras (ej. admin)
--   Marca:    Auto confirm user
--   Metadata (datos de usuario), si te deja:  {"role":"superadmin"}
--
-- Debe crearse SIN error rojo. Si aún falla, el problema ya no es el trigger:
-- abre un ticket a Supabase o revisa que el proyecto no esté pausado.
-- -----------------------------------------------------------------------------


-- -----------------------------------------------------------------------------
-- MOMENTO 3 — Cuando en Users veas a admin@example.com creado, copia SOLO
-- el bloque de abajo en SQL Editor y pulsa Run.
-- Esto copia ese usuario a la tabla public.users (perfil de la app).
-- -----------------------------------------------------------------------------

insert into public.users (id, email, role, club_id)
select
  id,
  email,
  'superadmin'::public.user_role,
  null
from auth.users
where email = 'admin@example.com'
on conflict (id) do update
set
  role = excluded.role,
  email = excluded.email,
  club_id = excluded.club_id;
