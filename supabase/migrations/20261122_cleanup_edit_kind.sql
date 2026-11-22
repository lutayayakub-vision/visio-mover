-- Image cleanup (inpainting): allow edit_kind = 'cleanup' for edited copies produced by the object-removal tool.
-- Additive: only widens one CHECK constraint. No columns, grants, RLS policies or triggers change, so owner-only
-- select/insert/delete, the "source must belong to the same owner" trigger and the 8 KB edit_params limit all still apply.
--
-- edit_kind values after this migration: 'image' | 'video' | 'thumbnail' | 'cleanup'

alter table public.files drop constraint if exists files_edit_kind_check;
alter table public.files
  add constraint files_edit_kind_check check (edit_kind is null or edit_kind in ('image', 'video', 'thumbnail', 'cleanup'));
