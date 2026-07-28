-- Niveles de membresía personalizados (más allá de standard / premium / vip).
-- Ejecutar en Supabase → SQL Editor → Run.

-- Quitar enums rígidos
alter table public.club_membership_tiers
  drop constraint if exists club_membership_tiers_tier_key_check;

alter table public.club_membership_rewards
  drop constraint if exists club_membership_rewards_tier_key_check;

alter table public.club_members
  drop constraint if exists club_members_member_type_check;

-- Formato slug: a-z, números y _ (máx 32)
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'club_membership_tiers_tier_key_format'
  ) then
    alter table public.club_membership_tiers
      add constraint club_membership_tiers_tier_key_format
      check (tier_key ~ '^[a-z][a-z0-9_]{0,31}$');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'club_membership_rewards_tier_key_format'
  ) then
    alter table public.club_membership_rewards
      add constraint club_membership_rewards_tier_key_format
      check (tier_key is null or tier_key ~ '^[a-z][a-z0-9_]{0,31}$');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'club_members_member_type_format'
  ) then
    alter table public.club_members
      add constraint club_members_member_type_format
      check (member_type ~ '^[a-z][a-z0-9_]{0,31}$');
  end if;
end $$;

comment on column public.club_membership_tiers.tier_key is
  'Clave interna del nivel (slug). Los base son standard/premium/vip; se pueden crear más.';

-- Comprobación
select
  (select count(*) from pg_constraint where conname = 'club_membership_tiers_tier_key_format') as tiers_ok,
  (select count(*) from pg_constraint where conname = 'club_members_member_type_format') as members_ok;
