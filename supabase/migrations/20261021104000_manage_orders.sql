grant update (name, phone, address, items, total_amount)
  on table public.orders
  to authenticated;
grant delete on table public.orders to authenticated;

drop policy if exists "Order admins can update orders" on public.orders;
create policy "Order admins can update orders"
  on public.orders
  for update
  to authenticated
  using (public.is_order_admin())
  with check (
    public.is_order_admin()
    and char_length(btrim(name)) between 1 and 120
    and char_length(btrim(phone)) between 1 and 40
    and char_length(btrim(address)) between 1 and 1000
    and case
      when jsonb_typeof(items) = 'array' then jsonb_array_length(items) > 0
      else false
    end
    and total_amount >= 0
  );

drop policy if exists "Order admins can delete orders" on public.orders;
create policy "Order admins can delete orders"
  on public.orders
  for delete
  to authenticated
  using (public.is_order_admin());
