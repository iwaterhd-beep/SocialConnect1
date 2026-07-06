-- Fix RLS policies for inventory categories/products and club members.
-- Makes permissions robust for users linked either via public.users.club_id
-- or via public.club_access.auth_user_id.
-- Execute after 010_club_members_finance.sql and 008_inventory_tpv.sql.

-- ---------------------------------------------------------------------------
-- inventory_categories
-- ---------------------------------------------------------------------------
drop policy if exists "inventory_categories_select" on public.inventory_categories;
drop policy if exists "inventory_categories_write" on public.inventory_categories;
drop policy if exists "inventory_categories_update" on public.inventory_categories;
drop policy if exists "inventory_categories_delete" on public.inventory_categories;
drop policy if exists "inventory_categories_insert_via_access" on public.inventory_categories;
drop policy if exists "inventory_categories_insert_fallback" on public.inventory_categories;

create policy "inventory_categories_select"
  on public.inventory_categories
  for select
  using (
    public.is_superadmin()
    or exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and u.club_id = inventory_categories.club_id
    )
    or exists (
      select 1
      from public.club_access ca
      where ca.auth_user_id = auth.uid()
        and ca.club_id = inventory_categories.club_id
    )
  );

create policy "inventory_categories_write"
  on public.inventory_categories
  for insert
  with check (
    public.is_superadmin()
    or (
      exists (
        select 1
        from public.users u
        where u.id = auth.uid()
          and u.club_id = inventory_categories.club_id
      )
      and exists (
        select 1
        from public.clubs c
        where c.id = inventory_categories.club_id
          and c.is_active = true
      )
    )
    or exists (
      select 1
      from public.club_access ca
      join public.clubs c on c.id = ca.club_id
      where ca.auth_user_id = auth.uid()
        and ca.club_id = inventory_categories.club_id
        and c.is_active = true
    )
  );

create policy "inventory_categories_update"
  on public.inventory_categories
  for update
  using (
    public.is_superadmin()
    or exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and u.club_id = inventory_categories.club_id
    )
    or exists (
      select 1
      from public.club_access ca
      where ca.auth_user_id = auth.uid()
        and ca.club_id = inventory_categories.club_id
    )
  )
  with check (
    public.is_superadmin()
    or exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and u.club_id = inventory_categories.club_id
    )
    or exists (
      select 1
      from public.club_access ca
      where ca.auth_user_id = auth.uid()
        and ca.club_id = inventory_categories.club_id
    )
  );

create policy "inventory_categories_delete"
  on public.inventory_categories
  for delete
  using (
    public.is_superadmin()
    or exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and u.club_id = inventory_categories.club_id
    )
    or exists (
      select 1
      from public.club_access ca
      where ca.auth_user_id = auth.uid()
        and ca.club_id = inventory_categories.club_id
    )
  );

-- ---------------------------------------------------------------------------
-- inventory_products
-- ---------------------------------------------------------------------------
drop policy if exists "inventory_products_select" on public.inventory_products;
drop policy if exists "inventory_products_insert" on public.inventory_products;
drop policy if exists "inventory_products_update" on public.inventory_products;
drop policy if exists "inventory_products_delete" on public.inventory_products;

create policy "inventory_products_select"
  on public.inventory_products
  for select
  using (
    public.is_superadmin()
    or exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and u.club_id = inventory_products.club_id
    )
    or exists (
      select 1
      from public.club_access ca
      where ca.auth_user_id = auth.uid()
        and ca.club_id = inventory_products.club_id
    )
  );

create policy "inventory_products_insert"
  on public.inventory_products
  for insert
  with check (
    public.is_superadmin()
    or (
      exists (
        select 1
        from public.users u
        where u.id = auth.uid()
          and u.club_id = inventory_products.club_id
      )
      and exists (
        select 1
        from public.clubs c
        where c.id = inventory_products.club_id
          and c.is_active = true
      )
    )
    or exists (
      select 1
      from public.club_access ca
      join public.clubs c on c.id = ca.club_id
      where ca.auth_user_id = auth.uid()
        and ca.club_id = inventory_products.club_id
        and c.is_active = true
    )
  );

create policy "inventory_products_update"
  on public.inventory_products
  for update
  using (
    public.is_superadmin()
    or exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and u.club_id = inventory_products.club_id
    )
    or exists (
      select 1
      from public.club_access ca
      where ca.auth_user_id = auth.uid()
        and ca.club_id = inventory_products.club_id
    )
  )
  with check (
    public.is_superadmin()
    or exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and u.club_id = inventory_products.club_id
    )
    or exists (
      select 1
      from public.club_access ca
      where ca.auth_user_id = auth.uid()
        and ca.club_id = inventory_products.club_id
    )
  );

create policy "inventory_products_delete"
  on public.inventory_products
  for delete
  using (
    public.is_superadmin()
    or exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and u.club_id = inventory_products.club_id
    )
    or exists (
      select 1
      from public.club_access ca
      where ca.auth_user_id = auth.uid()
        and ca.club_id = inventory_products.club_id
    )
  );

-- ---------------------------------------------------------------------------
-- club_members
-- ---------------------------------------------------------------------------
drop policy if exists "club_members_select" on public.club_members;
drop policy if exists "club_members_insert" on public.club_members;
drop policy if exists "club_members_update" on public.club_members;
drop policy if exists "club_members_delete" on public.club_members;

create policy "club_members_select"
  on public.club_members
  for select
  using (
    public.is_superadmin()
    or exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and u.club_id = club_members.club_id
    )
    or exists (
      select 1
      from public.club_access ca
      where ca.auth_user_id = auth.uid()
        and ca.club_id = club_members.club_id
    )
  );

create policy "club_members_insert"
  on public.club_members
  for insert
  with check (
    public.is_superadmin()
    or (
      exists (
        select 1
        from public.users u
        where u.id = auth.uid()
          and u.club_id = club_members.club_id
      )
      and exists (
        select 1
        from public.clubs c
        where c.id = club_members.club_id
          and c.is_active = true
      )
    )
    or exists (
      select 1
      from public.club_access ca
      join public.clubs c on c.id = ca.club_id
      where ca.auth_user_id = auth.uid()
        and ca.club_id = club_members.club_id
        and c.is_active = true
    )
  );

create policy "club_members_update"
  on public.club_members
  for update
  using (
    public.is_superadmin()
    or exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and u.club_id = club_members.club_id
    )
    or exists (
      select 1
      from public.club_access ca
      where ca.auth_user_id = auth.uid()
        and ca.club_id = club_members.club_id
    )
  )
  with check (
    public.is_superadmin()
    or exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and u.club_id = club_members.club_id
    )
    or exists (
      select 1
      from public.club_access ca
      where ca.auth_user_id = auth.uid()
        and ca.club_id = club_members.club_id
    )
  );

create policy "club_members_delete"
  on public.club_members
  for delete
  using (
    public.is_superadmin()
    or exists (
      select 1
      from public.users u
      where u.id = auth.uid()
        and u.club_id = club_members.club_id
    )
    or exists (
      select 1
      from public.club_access ca
      where ca.auth_user_id = auth.uid()
        and ca.club_id = club_members.club_id
    )
  );
