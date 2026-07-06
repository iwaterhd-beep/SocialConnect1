-- Backfill único: socios activos con >100 € en TPV últimos 7 días → VIP (misma regla que 025).
-- Idempotente: no toca filas que ya son VIP.

update public.club_members m
set
  member_type = 'vip',
  member_type_valid_until = null
from (
  select
    d.member_id,
    d.club_id
  from public.tpv_dispenses d
  where d.member_id is not null
    and d.created_at >= (now() - interval '7 days')
  group by d.member_id, d.club_id
  having coalesce(sum(d.price_charged_eur), 0) > 100
) s
where m.id = s.member_id
  and m.club_id = s.club_id
  and m.is_active = true
  and m.member_type is distinct from 'vip';
