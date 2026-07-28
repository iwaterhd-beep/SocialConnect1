-- Cantidad del regalo de membresía (unidades o gramos según el producto).

alter table public.club_membership_rewards
  add column if not exists quantity numeric(12, 3) not null default 1
  check (quantity > 0);

comment on column public.club_membership_rewards.quantity is
  'Cantidad a añadir gratis en el TPV (unidades o gramos según sale_unit del producto).';

alter table public.club_membership_reward_grants
  add column if not exists quantity numeric(12, 3) not null default 1
  check (quantity > 0);

comment on column public.club_membership_reward_grants.quantity is
  'Cantidad fijada al crear el derecho del regalo.';
