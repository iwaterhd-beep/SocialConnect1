-- PEGAR TODO ESTE ARCHIVO EN: Supabase → SQL Editor → Run
-- Proyecto: lkpyybmqvyhevcifezws (SocialConnect)
-- Arregla: "Debes indicar un socio avalista (garante) existente."

-- Asegurar columnas de avalista
alter table public.club_members
  add column if not exists avalista text not null default '';

alter table public.club_members
  add column if not exists avalista_dni text not null default '';

alter table public.club_members
  add column if not exists avalista_member_id uuid references public.club_members (id) on delete set null;

-- Quitar TODOS los triggers de avalista en club_members (nombres desconocidos incluidos)
do $$
declare
  r record;
begin
  for r in
    select t.tgname
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_proc p on p.oid = t.tgfoid
    where n.nspname = 'public'
      and c.relname = 'club_members'
      and not t.tgisinternal
      and (
        t.tgname ilike '%avalista%'
        or t.tgname ilike '%garante%'
        or pg_get_functiondef(p.oid) ilike '%avalista%'
        or pg_get_functiondef(p.oid) ilike '%garante%'
      )
  loop
    execute format('drop trigger if exists %I on public.club_members', r.tgname);
  end loop;
end $$;

drop function if exists public.club_members_enforce_existing_avalista();
drop function if exists public.club_members_avalista_required();
drop function if exists public.enforce_avalista_member();
drop function if exists public.trg_club_members_avalista();

create or replace function public.club_members_enforce_existing_avalista()
returns trigger
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  v_other_count integer;
  v_ok boolean;
  v_name text;
  v_dni text;
  v_has_archived boolean;
begin
  perform set_config('row_security', 'off', true);

  select exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'club_members'
      and c.column_name = 'is_archived'
  )
  into v_has_archived;

  if v_has_archived then
    execute
      'select count(*)::integer from public.club_members m
       where m.club_id = $1
         and ($2 = ''INSERT'' or m.id is distinct from $3)
         and coalesce(m.is_archived, false) = false'
      into v_other_count
      using new.club_id, tg_op, new.id;
  else
    select count(*)::integer
      into v_other_count
    from public.club_members m
    where m.club_id = new.club_id
      and (tg_op = 'INSERT' or m.id is distinct from new.id);
  end if;

  -- Primer socio del club: no exige avalista.
  if coalesce(v_other_count, 0) = 0 then
    return new;
  end if;

  if new.avalista_member_id is null then
    raise exception 'Debes indicar un socio avalista (garante) existente.';
  end if;

  if v_has_archived then
    execute
      'select exists (
         select 1 from public.club_members a
         where a.id = $1
           and a.club_id = $2
           and coalesce(a.is_archived, false) = false
           and a.id is distinct from $3
       )'
      into v_ok
      using new.avalista_member_id, new.club_id, new.id;
  else
    select exists (
      select 1
      from public.club_members a
      where a.id = new.avalista_member_id
        and a.club_id = new.club_id
        and a.id is distinct from new.id
    )
    into v_ok;
  end if;

  if not coalesce(v_ok, false) then
    raise exception 'Debes indicar un socio avalista (garante) existente.';
  end if;

  -- Rellenar siempre nombre/dni desde el socio enlazado.
  select
    coalesce(nullif(btrim(a.display_name), ''), nullif(btrim(concat_ws(' ', a.first_name, a.last_name)), ''), 'Socio'),
    coalesce(a.dni, '')
  into v_name, v_dni
  from public.club_members a
  where a.id = new.avalista_member_id;

  if v_name is not null then
    new.avalista := v_name;
  end if;
  if v_dni is not null then
    new.avalista_dni := v_dni;
  end if;

  return new;
end;
$$;

alter function public.club_members_enforce_existing_avalista() owner to postgres;

drop trigger if exists club_members_enforce_existing_avalista on public.club_members;
create trigger club_members_enforce_existing_avalista
  before insert or update of avalista_member_id, avalista, avalista_dni, club_id
  on public.club_members
  for each row
  execute function public.club_members_enforce_existing_avalista();

comment on function public.club_members_enforce_existing_avalista() is
  'Exige avalista_member_id de un socio del mismo club; rellena nombre/dni desde ese socio.';

-- Comprobación rápida (debe devolver 1 fila)
select tgname, pg_get_triggerdef(oid) as def
from pg_trigger
where tgrelid = 'public.club_members'::regclass
  and not tgisinternal
  and tgname = 'club_members_enforce_existing_avalista';
