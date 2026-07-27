-- Directorio de staff por club: el superadmin puede consultar un club concreto
-- (antes solo usaba users.club_id del auth.uid(), que en superadmin es null).

drop function if exists public.club_staff_directory();
drop function if exists public.club_staff_directory(uuid);

create function public.club_staff_directory(p_club_id uuid)
returns table (user_id uuid, email text)
language sql
stable
security definer
set search_path = public
as $$
  select u.id, u.email
  from public.users u
  where u.club_id is not null
    and u.club_id = case
      when public.is_superadmin() and p_club_id is not null then p_club_id
      else (select u2.club_id from public.users u2 where u2.id = auth.uid())
    end;
$$;

-- Compatibilidad: llamadas sin argumento (panel club normal / clientes antiguos)
create function public.club_staff_directory()
returns table (user_id uuid, email text)
language sql
stable
security definer
set search_path = public
as $$
  select * from public.club_staff_directory(null::uuid);
$$;

alter function public.club_staff_directory(uuid) owner to postgres;
alter function public.club_staff_directory() owner to postgres;
grant execute on function public.club_staff_directory(uuid) to authenticated;
grant execute on function public.club_staff_directory() to authenticated;
