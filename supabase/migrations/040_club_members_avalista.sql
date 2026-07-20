-- Avalista del socio (nombre, DNI y enlace opcional a otro socio del club).
-- Ejecutar después de 011_club_members_profile.sql.

alter table public.club_members
  add column if not exists avalista text not null default '';

alter table public.club_members
  add column if not exists avalista_dni text not null default '';

alter table public.club_members
  add column if not exists avalista_member_id uuid references public.club_members (id) on delete set null;

comment on column public.club_members.avalista is 'Nombre completo del socio avalista.';
comment on column public.club_members.avalista_dni is 'DNI/NIE del avalista.';
comment on column public.club_members.avalista_member_id is 'Si el avalista es socio del club, referencia opcional.';

create index if not exists club_members_avalista_member_idx
  on public.club_members (avalista_member_id)
  where avalista_member_id is not null;
