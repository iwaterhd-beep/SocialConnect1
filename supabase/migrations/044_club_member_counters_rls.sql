-- Fix: "new row violates row-level security policy for table club_member_counters"
-- al dar de alta un socio (trigger de 041_club_member_sequential_code.sql).
-- El contador solo lo toca el trigger; la función debe saltarse RLS.

alter table public.club_member_counters enable row level security;

-- Sin políticas para usuarios: nadie accede directo a la tabla.
revoke all on table public.club_member_counters from anon, authenticated;

create or replace function public.club_members_assign_sequential_code()
returns trigger
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  v_num integer;
begin
  perform set_config('row_security', 'off', true);

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
