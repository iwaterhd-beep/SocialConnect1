-- Símbolo / etiqueta de moneda de visualización por club (p. ej. €, Crd, $).
-- Los importes en BD siguen en columnas *_eur; esto solo afecta a la UI.

alter table public.clubs
  add column if not exists currency_symbol text not null default '€';

alter table public.clubs
  drop constraint if exists clubs_currency_symbol_len;

alter table public.clubs
  add constraint clubs_currency_symbol_len
  check (char_length(trim(currency_symbol)) >= 1 and char_length(currency_symbol) <= 8);

comment on column public.clubs.currency_symbol is
  'Etiqueta de moneda mostrada en el panel (p. ej. €, Crd). Solo visualización.';
