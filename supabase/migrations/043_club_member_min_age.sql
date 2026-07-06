-- Edad mínima de socio configurable por club (predeterminado 18).
-- Ejecutar después de 042_clubs_admin_update_legal.sql.

alter table public.clubs
  add column if not exists member_min_age integer not null default 18;

alter table public.clubs
  drop constraint if exists clubs_member_min_age_check;

alter table public.clubs
  add constraint clubs_member_min_age_check
  check (member_min_age >= 1 and member_min_age <= 120);

comment on column public.clubs.member_min_age is
  'Edad mínima exigida para ser socio en este club (años cumplidos).';

-- Nombres de socios en mayúsculas
update public.club_members
set
  first_name = upper(trim(first_name)),
  last_name = upper(trim(last_name)),
  display_name = upper(trim(display_name))
where
  trim(coalesce(first_name, '')) <> upper(trim(first_name))
  or trim(coalesce(last_name, '')) <> upper(trim(last_name))
  or trim(coalesce(display_name, '')) <> upper(trim(display_name));
