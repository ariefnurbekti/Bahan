alter table public.orders
  add column if not exists whatsapp_outcome text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'orders_whatsapp_outcome_check'
      and conrelid = 'public.orders'::regclass
  ) then
    alter table public.orders
      add constraint orders_whatsapp_outcome_check
      check (whatsapp_outcome is null or whatsapp_outcome in ('won', 'lost'));
  end if;
end
$$;

grant update (whatsapp_outcome) on table public.orders to authenticated;
