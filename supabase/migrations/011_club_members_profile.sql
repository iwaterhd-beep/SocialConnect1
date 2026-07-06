-- Perfil extendido de socios (alineado con formulario tipo SocialConnect).
-- Ejecutar después de 010_club_members_finance.sql.

alter table public.club_members
  add column if not exists first_name text not null default '';

alter table public.club_members
  add column if not exists last_name text not null default '';

alter table public.club_members
  add column if not exists dni text not null default '';

alter table public.club_members
  add column if not exists email text not null default '';

alter table public.club_members
  add column if not exists birth_date date;

alter table public.club_members
  add column if not exists member_type text not null default 'standard';

alter table public.club_members
  add column if not exists enrollment_fee_eur numeric(12, 2) not null default 0;

alter table public.club_members
  drop constraint if exists club_members_member_type_check;

alter table public.club_members
  add constraint club_members_member_type_check
  check (member_type in ('standard', 'premium', 'vip'));

-- Reparto básico del nombre visible histórico en nombre/apellidos vacíos
update public.club_members
set
  first_name = trim(split_part(trim(display_name), ' ', 1)),
  last_name = case
    when position(' ' in trim(display_name)) > 0
    then trim(substring(trim(display_name) from position(' ' in trim(display_name)) + 1))
    else ''
  end
where
  coalesce(trim(first_name), '') = ''
  and coalesce(trim(last_name), '') = ''
  and trim(display_name) <> '';
