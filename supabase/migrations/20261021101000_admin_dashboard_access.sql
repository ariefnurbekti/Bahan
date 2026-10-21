create table if not exists public.admin_access (
  email text primary key check (email = lower(btrim(email)))
);

alter table public.admin_access enable row level security;
revoke all on table public.admin_access from anon, authenticated;

create or replace function public.is_order_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.admin_access
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

revoke all on function public.is_order_admin() from public, anon;
grant execute on function public.is_order_admin() to authenticated;

grant select on table public.orders to authenticated;
drop policy if exists "Order admins can view orders" on public.orders;
create policy "Order admins can view orders"
  on public.orders
  for select
  to authenticated
  using (public.is_order_admin());
