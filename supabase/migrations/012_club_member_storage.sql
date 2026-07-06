-- Rutas de archivos en Storage + bucket privado club_member_docs.
-- Ejecutar después de 011_club_members_profile.sql.

alter table public.club_members
  add column if not exists avatar_path text not null default '';

alter table public.club_members
  add column if not exists doc_dni_front_path text not null default '';

alter table public.club_members
  add column if not exists doc_dni_back_path text not null default '';

alter table public.club_members
  add column if not exists doc_passport_path text not null default '';

-- Bucket privado (URLs firmadas desde el cliente)
insert into storage.buckets (id, name, public, file_size_limit)
values ('club_member_docs', 'club_member_docs', false, 5242880)
on conflict (id) do update
set file_size_limit = excluded.file_size_limit;

-- Políticas: ruta {club_id}/{member_id}/...
drop policy if exists "club_member_docs_select" on storage.objects;
create policy "club_member_docs_select"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'club_member_docs'
    and (
      public.is_superadmin()
      or exists (
        select 1
        from public.users u
        where u.id = auth.uid()
          and u.club_id is not null
          and u.club_id::text = split_part(name, '/', 1)
      )
    )
  );

drop policy if exists "club_member_docs_insert" on storage.objects;
create policy "club_member_docs_insert"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'club_member_docs'
    and (
      public.is_superadmin()
      or exists (
        select 1
        from public.users u
        where u.id = auth.uid()
          and u.club_id is not null
          and u.club_id::text = split_part(name, '/', 1)
      )
    )
  );

drop policy if exists "club_member_docs_update" on storage.objects;
create policy "club_member_docs_update"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'club_member_docs'
    and (
      public.is_superadmin()
      or exists (
        select 1
        from public.users u
        where u.id = auth.uid()
          and u.club_id is not null
          and u.club_id::text = split_part(name, '/', 1)
      )
    )
  )
  with check (
    bucket_id = 'club_member_docs'
    and (
      public.is_superadmin()
      or exists (
        select 1
        from public.users u
        where u.id = auth.uid()
          and u.club_id is not null
          and u.club_id::text = split_part(name, '/', 1)
      )
    )
  );

drop policy if exists "club_member_docs_delete" on storage.objects;
create policy "club_member_docs_delete"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'club_member_docs'
    and (
      public.is_superadmin()
      or exists (
        select 1
        from public.users u
        where u.id = auth.uid()
          and u.club_id is not null
          and u.club_id::text = split_part(name, '/', 1)
      )
    )
  );
