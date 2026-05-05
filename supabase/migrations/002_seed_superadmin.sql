-- =============================================================================
-- Paso 2 — Tras crear el usuario en Authentication (Dashboard)
--
-- Opción A (recomendada): al crear el usuario, en User metadata / Raw user meta data:
--   {"role":"superadmin"}
--
-- Opción B: crea el usuario admin@example.com con contraseña admin y ejecuta:
-- =============================================================================

-- Opción A: por email (recomendado si ya existe la fila del trigger en public.users)
update public.users
set role = 'superadmin'::public.user_role,
    club_id = null
where email = 'admin@example.com';

-- Opción B: por UUID de auth (si el trigger aún no creó fila, créala)
-- insert into public.users (id, email, role, club_id)
-- values (
--   'PASTE-AUTH-USER-UUID-HERE'::uuid,
--   'admin@example.com',
--   'superadmin'::public.user_role,
--   null
-- )
-- on conflict (id) do update
--   set role = excluded.role,
--       email = excluded.email,
--       club_id = excluded.club_id;
