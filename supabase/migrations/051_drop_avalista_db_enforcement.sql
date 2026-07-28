-- Si tras 050 el alta sigue fallando, ejecuta ESTE archivo entero en SQL Editor → Run.
-- Quita la validación de avalista en triggers de la BD.
-- El panel del club sigue exigiendo elegir un socio avalista en el formulario.

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
        or pg_get_functiondef(p.oid) ilike '%Debes indicar un socio avalista%'
      )
  loop
    execute format('drop trigger if exists %I on public.club_members', r.tgname);
  end loop;
end $$;

drop function if exists public.club_members_enforce_existing_avalista();
drop function if exists public.club_members_avalista_required();
drop function if exists public.enforce_avalista_member();
drop function if exists public.trg_club_members_avalista();

-- Asegurar columnas (por si faltan)
alter table public.club_members
  add column if not exists avalista text not null default '';

alter table public.club_members
  add column if not exists avalista_dni text not null default '';

alter table public.club_members
  add column if not exists avalista_member_id uuid references public.club_members (id) on delete set null;

-- Comprobación: no debe quedar ningún trigger de avalista
select t.tgname
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = 'club_members'
  and not t.tgisinternal
  and (t.tgname ilike '%avalista%' or t.tgname ilike '%garante%');
