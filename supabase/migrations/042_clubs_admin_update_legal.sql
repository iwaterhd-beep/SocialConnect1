-- Permite al admin del club editar datos legales (términos de alta de socios).
-- Ejecutar después de 041_club_member_sequential_code.sql.

create policy "clubs_update_admin_club"
  on public.clubs for update
  using (
    exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and u.club_id = clubs.id
        and u.role = 'admin_club'::public.user_role
        and clubs.is_active = true
    )
  )
  with check (
    exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and u.club_id = clubs.id
        and u.role = 'admin_club'::public.user_role
    )
  );
