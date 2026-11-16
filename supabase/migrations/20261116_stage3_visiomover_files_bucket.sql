-- Stage 3 (final): move uploads to the private bucket "visiomover-files".
-- Applied to the live project as migration "stage3_visiomover_files_bucket".
-- The earlier bucket "user-uploads" is left in place ONLY so its leftover object can be
-- removed from the Supabase dashboard (direct SQL deletes on storage tables are blocked by Supabase).
-- New uploads to it are disabled below.

-- 1. Private bucket, 50 MB per file, allow-listed MIME types
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'visiomover-files', 'visiomover-files', false, 52428800,
  array[
    'image/jpeg', 'image/png', 'image/webp',
    'video/mp4', 'video/quicktime', 'video/webm',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ]
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 2. Per-user usage now counts the new bucket (security invoker: RLS limits it to the caller's own objects)
create or replace function public.storage_used_bytes()
returns bigint
language sql stable security invoker set search_path = ''
as $$
  select coalesce(sum((o.metadata ->> 'size')::bigint), 0)::bigint
  from storage.objects o
  where o.bucket_id = 'visiomover-files'
    and (storage.foldername(o.name))[1] = (select auth.uid())::text;
$$;
revoke execute on function public.storage_used_bytes() from public, anon;
grant execute on function public.storage_used_bytes() to authenticated;

-- 3. Storage policies for the new bucket: own folder only, authenticated only, no UPDATE policy
create policy "vmfiles_select_own" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'visiomover-files'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "vmfiles_insert_own" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'visiomover-files'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|mp4|mov|webm|pdf|docx|pptx)$'
    and public.storage_used_bytes() < 524288000
  );

create policy "vmfiles_delete_own" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'visiomover-files'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- 4. The old bucket accepts no new uploads (its select/delete policies stay so the owner can still clean up)
drop policy if exists "uploads_insert_own" on storage.objects;

-- 5. Metadata trigger now validates against the new bucket
create or replace function public.files_validate_insert()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  sz bigint;
  mt text;
begin
  select (o.metadata ->> 'size')::bigint, o.metadata ->> 'mimetype'
    into sz, mt
  from storage.objects o
  where o.bucket_id = 'visiomover-files' and o.name = new.storage_path;

  if sz is null then
    raise exception 'No stored object exists for this file record' using errcode = '23514';
  end if;

  new.size_bytes := sz;
  if mt is not null then
    new.mime_type := mt;
  end if;
  return new;
end $$;
revoke execute on function public.files_validate_insert() from public, anon, authenticated;

-- 6. Remove metadata rows that still point at the old bucket (their library entries would be dead links).
--    Only rows whose object lives in "user-uploads" are touched.
delete from public.files f
using storage.objects o
where o.bucket_id = 'user-uploads' and o.name = f.storage_path;
