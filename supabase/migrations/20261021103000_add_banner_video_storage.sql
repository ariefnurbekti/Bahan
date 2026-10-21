insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values (
  'banner-videos',
  'banner-videos',
  true,
  52428800,
  array['video/mp4','video/webm']
)
on conflict (id) do update
set public=true,
    file_size_limit=excluded.file_size_limit,
    allowed_mime_types=excluded.allowed_mime_types;

drop policy if exists "Anyone can view banner videos" on storage.objects;
create policy "Anyone can view banner videos"
  on storage.objects
  for select
  to anon, authenticated
  using (bucket_id='banner-videos');

drop policy if exists "Order admins can upload banner videos" on storage.objects;
create policy "Order admins can upload banner videos"
  on storage.objects
  for insert
  to authenticated
  with check (bucket_id='banner-videos' and public.is_order_admin());

drop policy if exists "Order admins can update banner videos" on storage.objects;
create policy "Order admins can update banner videos"
  on storage.objects
  for update
  to authenticated
  using (bucket_id='banner-videos' and public.is_order_admin())
  with check (bucket_id='banner-videos' and public.is_order_admin());

drop policy if exists "Order admins can delete banner videos" on storage.objects;
create policy "Order admins can delete banner videos"
  on storage.objects
  for delete
  to authenticated
  using (bucket_id='banner-videos' and public.is_order_admin());
