-- Socios archivados: no aparecen en listados activos ni POS, pero se conservan por histórico.
-- Tras ejecutar, el panel puede "eliminar" archivando cuando no permita DELETE por FK.

alter table public.club_members
  add column if not exists is_archived boolean not null default false;

alter table public.club_members
  add column if not exists archived_at timestamptz;

comment on column public.club_members.is_archived is
  'Si true, el socio no se lista en socios activos ni POS; la fila permanece por histórico (ventas, monedero, documentos).';

comment on column public.club_members.archived_at is
  'Fecha en que el socio fue archivado (eliminación lógica desde el panel).';

create index if not exists club_members_club_not_archived_idx
  on public.club_members (club_id)
  where is_archived = false;

-- Permitir reutilizar código y chapa RFID de socios archivados
drop index if exists public.club_members_unique_code_per_club;

create unique index club_members_unique_code_per_club
  on public.club_members (club_id, lower(btrim(member_code)))
  where length(btrim(member_code)) > 0 and is_archived = false;

drop index if exists public.club_members_unique_rfid_per_club;

create unique index club_members_unique_rfid_per_club
  on public.club_members (club_id, lower(btrim(rfid_uid)))
  where length(btrim(rfid_uid)) > 0 and is_archived = false;
