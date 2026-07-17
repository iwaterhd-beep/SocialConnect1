-- Chapa RFID / NFC del socio (lectores tipo teclado: escriben el UID y Enter).
-- Independiente del nº de socio (#00001).

alter table public.club_members
  add column if not exists rfid_uid text not null default '';

comment on column public.club_members.rfid_uid is
  'UID de chapa RFID/NFC. Vacío = sin chapa. Único por club si no está vacío.';

create unique index if not exists club_members_unique_rfid_per_club
  on public.club_members (club_id, lower(btrim(rfid_uid)))
  where length(btrim(rfid_uid)) > 0;
