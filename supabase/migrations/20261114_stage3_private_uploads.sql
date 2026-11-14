-- Stage 3: private upload bucket, storage RLS, files metadata table.
-- Applied to the live project as migration "stage3_private_uploads".

-- 1. Private bucket (50 MB per file is the Supabase free-plan ceiling)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'user-uploads', 'user-uploads', false, 52428800,
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

-- 2. Per-user usage (security invoker: RLS limits it to the caller's own objects)
create or replace function public.storage_used_bytes()
returns bigint
language sql stable security invoker set search_path = ''
as $$
  select coalesce(sum((o.metadata ->> 'size')::bigint), 0)::bigint
  from storage.objects o
  where o.bucket_id = 'user-uploads'
    and (storage.foldername(o.name))[1] = (select auth.uid())::text;
$$;
revoke execute on function public.storage_used_bytes() from public, anon;
grant execute on function public.storage_used_bytes() to authenticated;

-- 3. Storage policies: own folder only. No UPDATE policy, so files cannot be overwritten.
create policy "uploads_select_own" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'user-uploads'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "uploads_insert_own" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'user-uploads'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    -- server-enforced safe, unique name: <user uuid>/<random uuid>.<allowed extension>
    and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp|mp4|mov|webm|pdf|docx|pptx)$'
    -- 500 MB quota, checked before each new upload
    and public.storage_used_bytes() < 524288000
  );

create policy "uploads_delete_own" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'user-uploads'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- 4. File records: original names and details, searchable. Row owner = auth user.
create table public.files (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  storage_path text not null unique,
  original_name text not null
    check (char_length(original_name) between 1 and 255 and original_name !~ '[\x00-\x1f\x7f<>]'),
  category text not null check (category in ('image', 'video', 'document')),
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 52428800),
  created_at timestamptz not null default now(),
  constraint files_path_in_owner_folder check (storage_path like owner_id::text || '/%'),
  constraint files_mime_matches_category check (
    (category = 'image' and mime_type in ('image/jpeg', 'image/png', 'image/webp')) or
    (category = 'video' and mime_type in ('video/mp4', 'video/quicktime', 'video/webm')) or
    (category = 'document' and mime_type in (
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'))
  ),
  constraint files_image_size check (category <> 'image' or size_bytes <= 20971520)
);

create index files_owner_created_idx on public.files (owner_id, created_at desc);
create index files_owner_category_idx on public.files (owner_id, category);

alter table public.files enable row level security;
alter table public.files force row level security;

create policy "files_select_own" on public.files
  for select to authenticated using ((select auth.uid()) = owner_id);
create policy "files_insert_own" on public.files
  for insert to authenticated with check ((select auth.uid()) = owner_id);
create policy "files_delete_own" on public.files
  for delete to authenticated using ((select auth.uid()) = owner_id);
-- no UPDATE policy: records are immutable

revoke all on public.files from anon, authenticated;
grant select, delete on public.files to authenticated;
grant insert (storage_path, original_name, category, mime_type, size_bytes) on public.files to authenticated;

-- 5. Size and type always come from storage, never from the client.
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
  where o.bucket_id = 'user-uploads' and o.name = new.storage_path;

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

create trigger files_validate_insert
  before insert on public.files
  for each row execute function public.files_validate_insert();
