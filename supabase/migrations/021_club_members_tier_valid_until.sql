-- Vigencia opcional del tipo Premium/VIP (fecha límite inclusive).
-- Ejecutar después de 011_club_members_profile.sql.

alter table public.club_members
  add column if not exists member_type_valid_until date;

comment on column public.club_members.member_type_valid_until is
  'Para premium/vip: último día con beneficio activo. NULL = sin fecha de caducidad.';
