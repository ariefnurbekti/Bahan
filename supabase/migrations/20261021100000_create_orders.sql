create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  phone text not null check (char_length(btrim(phone)) between 1 and 40),
  address text not null check (char_length(btrim(address)) between 1 and 1000),
  items jsonb not null check (
    case
      when jsonb_typeof(items) = 'array' then jsonb_array_length(items) > 0
      else false
    end
  ),
  total_amount bigint not null check (total_amount >= 0),
  created_at timestamptz not null default now()
);

alter table public.orders enable row level security;

revoke all on table public.orders from anon, authenticated;
grant usage on schema public to anon, authenticated;
grant insert on table public.orders to anon, authenticated;

drop policy if exists "Allow public order submissions" on public.orders;
create policy "Allow public order submissions"
  on public.orders
  for insert
  to anon, authenticated
  with check (
    char_length(btrim(name)) between 1 and 120
    and char_length(btrim(phone)) between 1 and 40
    and char_length(btrim(address)) between 1 and 1000
    and case
      when jsonb_typeof(items) = 'array' then jsonb_array_length(items) > 0
      else false
    end
    and total_amount >= 0
  );
