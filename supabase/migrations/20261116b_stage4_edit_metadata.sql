-- Stage 4: processing metadata for edited copies. Additive only: three nullable columns, no existing rows or policies change.
-- Applied to the live project as migration "stage4_edit_metadata".
--
--   source_file_id : the ORIGINAL this edited copy came from (null for normal uploads). The original is never modified.
--   edit_kind      : 'image' | 'video' | 'thumbnail'
--   edit_params    : the exact settings used (crop, quality, trim segments...), JSON object, max 8 KB
--
-- Security: the existing RLS policies still decide who can see/insert/delete a row (owner only). A trigger additionally
-- guarantees an edited copy can only point at an original owned by the SAME user, so ids of other people's files are useless.

alter table public.files
  add column if not exists source_file_id uuid references public.files(id) on delete set null,
  add column if not exists edit_kind text,
  add column if not exists edit_params jsonb;

alter table public.files
  add constraint files_edit_kind_check check (edit_kind is null or edit_kind in ('image', 'video', 'thumbnail')),
  add constraint files_edit_params_check check (edit_params is null or (jsonb_typeof(edit_params) = 'object' and pg_column_size(edit_params) <= 8192)),
  add constraint files_edit_lineage_check check (source_file_id is null or edit_kind is not null);

create index if not exists files_source_idx on public.files (source_file_id) where source_file_id is not null;

-- Column-level grants (the table already restricts which columns clients may write; keep that model)
grant select (source_file_id, edit_kind, edit_params) on public.files to authenticated;
grant insert (source_file_id, edit_kind, edit_params) on public.files to authenticated;

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

  -- an edited copy may only reference an original that belongs to the same user
  if new.source_file_id is not null then
    perform 1 from public.files f where f.id = new.source_file_id and f.owner_id = new.owner_id;
    if not found then
      raise exception 'Source file not found' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.files_validate_insert() from public, anon, authenticated;
