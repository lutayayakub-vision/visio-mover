# VISIOMOVER

Your Content. Clean. Clear. Yours.

A secure workspace for cleaning unwanted marks from images, videos and documents you own or are authorized to edit.

## Status

| Stage | Scope | State |
|---|---|---|
| 1 | Frontend, landing page, landing upload entry, before/after slider | Built |
| 2 | Supabase auth, profiles, protected dashboard | Built. Database security verified (18 checks). Live email flows not yet verified in a browser. |
| 3 | Private upload workspace: upload, list, search, download, delete | Built. Database/storage policies verified with 35 checks across two accounts. Live end-to-end upload in a browser still to be confirmed. |
| 4-8 | Image/video/document processing, hardening, deploy | Planned |

The editors are placeholders and nothing is processed yet. See `ARCHITECTURE.md`.

## Upload workspace (Stage 3)

- Private bucket `visiomover-files`; every file lives at `<user-id>/<random-uuid>.<ext>`.
- Policies allow each user to read, upload and delete only inside their own folder; names must match the safe pattern; 500 MB quota; 50 MB per file (Supabase free-plan limit).
- A `files` table holds the original name, type and size (size/type are re-read from storage by a trigger). Records are immutable for clients.
- Downloads use 60-second signed links created for the owner only.
- Migrations: `20261114_stage3_private_uploads.sql` (initial) and `20261116_stage3_visiomover_files_bucket.sql` (moves to `visiomover-files`).

## Run locally

```bash
npm install
cp .env.example .env.local   # fill in your Supabase URL and publishable key
npm run dev                  # http://localhost:5173
npm run build                # type-check + production build
```

In Supabase, add `http://localhost:5173/**` to Authentication -> URL Configuration -> Redirect URLs.

## Security notes

- Only the publishable key belongs in the frontend. Never use a `service_role` key in any `VITE_` variable.
- Database setup lives in `supabase/migrations/`. Row-level security limits each user to their own profile.
- `public/_headers` sets a content security policy for Netlify-style hosting.
- File-type checks in the browser read the file's first bytes; malware scanning and server-side content verification are planned for Stage 7.

## Deploy on Netlify

Connect the repository, then set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in Site configuration -> Environment variables. `netlify.toml` provides the build settings.

Stage 4 (image and video editing) notes:

- Production branch must be `main`. Processing runs in the visitor's browser, so no Netlify Functions or extra services are used.
- The video engine (`ffmpeg-core-*.wasm`, about 32 MB, about 10 MB compressed) is built into `dist/assets` and loaded only when someone exports a video. `public/_headers` must keep `'wasm-unsafe-eval'` in `script-src` and `worker-src 'self' blob:`, or video export fails.
- Optional: set `VITE_FFMPEG_CORE_BASE_URL` to host the two engine files elsewhere (then also allow that host in `script-src` and `connect-src`).
- `netlify.toml` skips builds that only change tests, CI workflows, scripts, SQL or markdown files, to save build credits.
- The Stage 4 SQL migration (`supabase/migrations/20261116b_stage4_edit_metadata.sql`) is already applied to the live Supabase project.
- ffmpeg-core is licensed GPL-2.0-or-later.
