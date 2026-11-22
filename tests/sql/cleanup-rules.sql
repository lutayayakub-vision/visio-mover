-- Rolled-back rules test for the 'cleanup' edit kind. Run in the Supabase SQL editor (or via the MCP execute_sql tool).
-- It creates two throwaway users + storage rows, exercises RLS/lineage/limits as roles, and ends by RAISING an exception
-- whose message is the PASS/FAIL report, so nothing is ever committed.
do $$
declare
  a uuid := gen_random_uuid(); b uuid := gen_random_uuid();
  orig uuid; cp uuid; n int; rep text := '';
  pa text := a::text || '/orig.png'; pc text := a::text || '/clean.png'; pb text := b::text || '/b.png';
  pcb text := b::text || '/stolen.png'; pbad text := a::text || '/bad.png'; pbig text := a::text || '/big.png';
begin
  insert into auth.users (id, email, aud, role) values (a, 'rls-a-' || a || '@example.test', 'authenticated', 'authenticated'), (b, 'rls-b-' || b || '@example.test', 'authenticated', 'authenticated');
  insert into storage.objects (bucket_id, name, owner, owner_id, metadata) select 'visiomover-files', p, u, u::text, '{"size":100,"mimetype":"image/png"}'::jsonb
    from (values (pa, a), (pc, a), (pb, b), (pcb, b), (pbad, a), (pbig, a)) v(p, u);

  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.files (storage_path, original_name, category, mime_type, size_bytes) values (pa, 'orig.png', 'image', 'image/png', 100) returning id into orig;
  rep := rep || 'PASS A uploads an original' || E'\n';
  insert into public.files (storage_path, original_name, category, mime_type, size_bytes, source_file_id, edit_kind, edit_params)
    values (pc, 'orig (cleaned).png', 'image', 'image/png', 100, orig, 'cleanup', '{"engine":"patchmatch-inpaint","maskPixels":4513,"strokes":{"paintStrokes":2}}'::jsonb) returning id into cp;
  rep := rep || 'PASS A saves a cleanup copy linked to the original, with settings' || E'\n';
  select count(*) into n from public.files where id = cp and edit_kind = 'cleanup' and source_file_id = orig and edit_params->>'engine' = 'patchmatch-inpaint';
  rep := rep || case when n = 1 then 'PASS Owner reads back kind, lineage and settings' else 'FAIL Owner read-back' end || E'\n';

  begin insert into public.files (storage_path, original_name, category, mime_type, size_bytes, source_file_id, edit_kind) values (pbad, 'x.png', 'image', 'image/png', 100, orig, 'inpaint'); rep := rep || 'FAIL unknown edit_kind accepted' || E'\n';
  exception when check_violation then rep := rep || 'PASS Unknown edit_kind is rejected' || E'\n'; end;
  begin insert into public.files (storage_path, original_name, category, mime_type, size_bytes, source_file_id, edit_kind, edit_params) values (pbig, 'x.png', 'image', 'image/png', 100, orig, 'cleanup', jsonb_build_object('pad', repeat('x', 9000))); rep := rep || 'FAIL oversized params accepted' || E'\n';
  exception when check_violation then rep := rep || 'PASS edit_params over 8 KB is rejected' || E'\n'; end;
  begin update public.files set edit_kind = 'image' where id = cp; rep := rep || 'FAIL owner could rewrite edit_kind' || E'\n';
  exception when insufficient_privilege then rep := rep || 'PASS Edit records cannot be altered after saving (no UPDATE grant)' || E'\n'; end;

  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.files where id in (orig, cp);
  rep := rep || case when n = 0 then 'PASS B cannot see A''s original or cleanup copy' else 'FAIL B sees A rows: ' || n end || E'\n';
  begin insert into public.files (storage_path, original_name, category, mime_type, size_bytes, source_file_id, edit_kind) values (pcb, 'stolen.png', 'image', 'image/png', 100, orig, 'cleanup'); rep := rep || 'FAIL B linked to A''s original' || E'\n';
  exception when check_violation then rep := rep || 'PASS B cannot create a cleanup copy pointing at A''s original' || E'\n'; end;
  begin update public.files set edit_kind = 'image' where id = cp; rep := rep || 'FAIL B update allowed' || E'\n';
  exception when insufficient_privilege then rep := rep || 'PASS B cannot modify A''s edit record' || E'\n'; end;
  delete from public.files where id in (orig, cp);
  get diagnostics n = row_count;
  rep := rep || case when n = 0 then 'PASS B cannot delete A''s files (0 rows)' else 'FAIL B deleted ' || n end || E'\n';

  reset role; set local role anon; perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  begin select count(*) into n from public.files; rep := rep || case when n = 0 then 'PASS anon sees nothing' else 'FAIL anon sees rows' end || E'\n';
  exception when insufficient_privilege then rep := rep || 'PASS anon is denied' || E'\n'; end;

  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  delete from public.files where id = orig;
  select count(*) into n from public.files where id = cp and source_file_id is null and edit_kind = 'cleanup';
  rep := rep || case when n = 1 then 'PASS Deleting the original keeps the cleanup copy (link cleared, not cascaded)' else 'FAIL copy lost after original delete' end || E'\n';
  reset role;
  raise exception E'RULES TEST REPORT (rolled back)\n%', rep;
end $$;
