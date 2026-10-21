create table if not exists public.store_catalog (
  id boolean primary key default true check (id),
  catalog jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.store_catalog enable row level security;
revoke all on table public.store_catalog from anon, authenticated;
grant select on table public.store_catalog to anon, authenticated;
grant update on table public.store_catalog to authenticated;

drop policy if exists "Anyone can view store catalog" on public.store_catalog;
create policy "Anyone can view store catalog"
  on public.store_catalog
  for select
  to anon, authenticated
  using (true);

drop policy if exists "Order admins can update store catalog" on public.store_catalog;
create policy "Order admins can update store catalog"
  on public.store_catalog
  for update
  to authenticated
  using (public.is_order_admin())
  with check (public.is_order_admin());

insert into public.store_catalog (id,catalog)
values (
  true,
  '{
    "storeName":"Segar Tahu & Tempe",
    "waNumber":"6282278142221",
    "banner":{
      "active":true,
      "title":"🌟 PROMO SPESIAL: 100% Kedelai Murni Pilihan!",
      "desc":"Higienis, Tanpa Bahan Pengawet, dan Fresh Setiap Hari.",
      "images":["","",""]
    },
    "products":[
      {"id":"besar","name":"Tahu Putih Besar","desc":"Tahu putih ukuran besar","image":"","price":7000},
      {"id":"kecil","name":"Tahu Putih Kecil","desc":"Tahu putih ukuran kecil","image":"","price":3000},
      {"id":"goreng","name":"Tahu Goreng","desc":"Tahu goreng siap santap","image":"","price":4500},
      {"id":"tempe","name":"Tempe","desc":"Tempe kedelai","image":"","price":5000}
    ]
  }'::jsonb
)
on conflict (id) do nothing;

insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('product-images','product-images',true,5242880,array['image/jpeg','image/png','image/webp'])
on conflict (id) do update
set public=true,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

drop policy if exists "Anyone can view product images" on storage.objects;
create policy "Anyone can view product images"
  on storage.objects
  for select
  to anon, authenticated
  using (bucket_id='product-images');

drop policy if exists "Order admins can upload product images" on storage.objects;
create policy "Order admins can upload product images"
  on storage.objects
  for insert
  to authenticated
  with check (bucket_id='product-images' and public.is_order_admin());

drop policy if exists "Order admins can update product images" on storage.objects;
create policy "Order admins can update product images"
  on storage.objects
  for update
  to authenticated
  using (bucket_id='product-images' and public.is_order_admin())
  with check (bucket_id='product-images' and public.is_order_admin());

drop policy if exists "Order admins can delete product images" on storage.objects;
create policy "Order admins can delete product images"
  on storage.objects
  for delete
  to authenticated
  using (bucket_id='product-images' and public.is_order_admin());
