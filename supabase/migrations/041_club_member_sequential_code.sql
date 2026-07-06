-- Número secuencial de socio por club (#00001, #00002, …).
-- Ejecutar después de 040_club_remove_worker.sql.

alter table public.club_members
  add column if not exists member_number integer;

comment on column public.club_members.member_number is
  'Número secuencial del socio dentro del club (1 = primer alta).';

create unique index if not exists club_members_unique_number_per_club
  on public.club_members (club_id, member_number)
  where member_number is not null;

create table if not exists public.club_member_counters (
  club_id uuid primary key references public.clubs (id) on delete cascade,
  next_number integer not null default 1
);

-- Numerar socios existentes por orden de alta (primer socio = 1).
-- Solo clubes que siguen existiendo (evita FK si hay socios huérfanos).
with ranked as (
  select
    cm.id,
    cm.club_id,
    row_number() over (partition by cm.club_id order by cm.created_at asc, cm.id asc) as rn
  from public.club_members cm
  inner join public.clubs c on c.id = cm.club_id
)
update public.club_members m
set
  member_number = r.rn,
  member_code = '#' || lpad(r.rn::text, 5, '0')
from ranked r
where m.id = r.id;

insert into public.club_member_counters (club_id, next_number)
select cm.club_id, coalesce(max(cm.member_number), 0) + 1
from public.club_members cm
inner join public.clubs c on c.id = cm.club_id
group by cm.club_id
on conflict (club_id) do update
set next_number = excluded.next_number;

create or replace function public.club_members_assign_sequential_code()
returns trigger
language plpgsql
as $$
declare
  v_num integer;
begin
  if btrim(coalesce(new.member_code, '')) <> '' then
    return new;
  end if;

  update public.club_member_counters
  set next_number = next_number + 1
  where club_id = new.club_id
  returning next_number - 1 into v_num;

  if not found then
    if not exists (select 1 from public.clubs c where c.id = new.club_id) then
      raise exception 'club_id % no existe en clubs', new.club_id;
    end if;

    insert into public.club_member_counters (club_id, next_number)
    values (new.club_id, 2)
    returning 1 into v_num;
  end if;

  new.member_number := v_num;
  new.member_code := '#' || lpad(v_num::text, 5, '0');
  return new;
end;
$$;

drop trigger if exists club_members_assign_sequential_code on public.club_members;

create trigger club_members_assign_sequential_code
  before insert on public.club_members
  for each row
  execute function public.club_members_assign_sequential_code();
