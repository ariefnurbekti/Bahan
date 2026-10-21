alter table public.orders
  add column if not exists payment_status text,
  add column if not exists payment_gateway text,
  add column if not exists midtrans_order_id text,
  add column if not exists midtrans_transaction_id text,
  add column if not exists transaction_status text,
  add column if not exists payment_type text,
  add column if not exists paid_at timestamptz;

update public.orders
set payment_status = 'manual',
    payment_gateway = 'manual'
where payment_status is null
   or payment_gateway is null;

alter table public.orders
  alter column payment_status set default 'pending',
  alter column payment_status set not null,
  alter column payment_gateway set default 'midtrans',
  alter column payment_gateway set not null;

revoke insert on table public.orders from anon, authenticated;
grant insert, update on table public.orders to service_role;

drop policy if exists "Allow public order submissions" on public.orders;

alter table public.orders
  add constraint orders_payment_status_check
  check (payment_status in (
    'manual',
    'pending',
    'paid',
    'failed',
    'cancelled',
    'expired',
    'refunded',
    'partially_refunded',
    'disputed'
  ));

create unique index if not exists orders_midtrans_order_id_key
  on public.orders (midtrans_order_id)
  where midtrans_order_id is not null;

create index if not exists orders_payment_status_idx
  on public.orders (payment_status);
