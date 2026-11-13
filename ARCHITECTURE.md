# VISIOMOVER — Architecture

> Your Content. Clean. Clear. Yours.

VISIOMOVER is a secure workspace for cleaning unwanted marks from images, videos and documents the user owns or is authorized to edit. This document describes the target architecture for all eight stages. **Stage 1 (frontend + landing page) is implemented; everything else below is planned and is labelled as such in the UI until it is built and tested.**

---

## 1. System overview

```
┌──────────────────────────┐        HTTPS         ┌───────────────────────────┐
│  Web app (React + TS)    │ ───────────────────► │  Supabase                 │
│  Vite · React Router     │   auth, DB (RLS),    │  • Auth (JWT sessions)    │
│  Hosted on Vercel/Netlify│   signed upload URLs │  • Postgres + RLS         │
└───────────┬──────────────┘                      │  • Private Storage        │
            │ Bearer JWT                          └─────────────▲─────────────┘
            ▼                                                   │ service role
┌──────────────────────────┐   enqueue    ┌──────────────┐      │ (server only)
│  FastAPI gateway         │ ───────────► │  Redis queue │      │
│  • verifies Supabase JWT │              └──────┬───────┘      │
│  • validates + rate-limits│                    │ pull         │
│  • creates jobs          │                    ▼              │
└──────────────────────────┘      ┌─────────────────────────────┴──┐
                                  │  Workers (Python, isolated)    │
                                  │  • image: LaMa inpainting      │
                                  │  • video: FFmpeg + SAM2 + LaMa │
                                  │  • docs: PyMuPDF / python-docx │
                                  │          / python-pptx         │
                                  │  • ClamAV scan before any work │
                                  └────────────────────────────────┘
```

The frontend never talks to workers directly and never holds a secret. The browser holds only the Supabase **anon** key (safe by design because every table is protected by RLS).

## 2. Technology choices

| Concern | Choice | Reason |
|---|---|---|
| Frontend | React 18, TypeScript, Vite | Fast builds, strong typing, component reuse |
| Routing | React Router | Protected routes, nested dashboard layout |
| Styling | Hand-written CSS with design tokens | Full control of visual identity, no template look |
| Animation | CSS + `requestAnimationFrame` canvas | GPU-friendly, honours `prefers-reduced-motion` |
| Auth / DB / Storage | Supabase | Managed auth, RLS, private buckets, signed URLs |
| API | FastAPI | Async, typed, easy JWT dependency injection |
| Queue | Redis + RQ (or Celery) | Simple, reliable background jobs |
| Image inpainting | LaMa (open source) | Strong large-mask reconstruction |
| Video | FFmpeg + SAM2 tracking + LaMa per frame | Mask propagation then frame inpainting |
| Documents | PyMuPDF (PDF), python-docx, python-pptx | Native-format editing without flattening |
| Malware scan | ClamAV (clamd) | Open source, scriptable |
| Deploy | Frontend: Vercel/Netlify · Backend: Docker on GPU host | Separates static hosting from heavy compute |

## 3. Data model (Stage 3)

All tables carry `owner_id uuid references auth.users` and have RLS enabled.

- `profiles` (id = auth.users.id, display_name, avatar_path, plan, storage_quota_bytes)
- `projects` (id, owner_id, name, kind: image|video|document, created_at)
- `files` (id, owner_id, project_id, storage_path, mime_verified, size_bytes, sha256, scan_status, expires_at)
- `jobs` (id, owner_id, file_id, kind, status: queued|uploading|processing|completed|failed, progress, error, params jsonb)
- `results` (id, owner_id, job_id, storage_path, size_bytes, created_at)
- `downloads` (id, owner_id, result_id, downloaded_at)
- `preferences` (owner_id pk, theme, default_brush_size, notifications jsonb)

Representative policy (applied to every table):

```sql
alter table projects enable row level security;
create policy "own rows" on projects
  for all using (owner_id = auth.uid())
  with check (owner_id = auth.uid());
```

Storage buckets are **private**; object paths are `{owner_id}/{file_id}`, with a storage policy requiring `(storage.foldername(name))[1] = auth.uid()::text`. Downloads use short-lived signed URLs.

## 4. Security model

1. **AuthN**: Supabase Auth (bcrypt hashing handled by provider), email verification required, password reset by emailed link.
2. **AuthZ**: RLS in Postgres + storage policies; FastAPI re-verifies the JWT and checks ownership server-side before enqueueing anything.
3. **Uploads**: size caps; extension *and* magic-byte verification (`python-magic`); reject mismatches; ClamAV scan; files stay `quarantined` until clean.
4. **Isolation**: workers run in containers with no network egress except to Supabase/Redis, read-only root FS, CPU/memory limits, and per-job temp dirs.
5. **Secrets**: service-role key lives only in backend env vars. Never in the frontend bundle.
6. **Abuse controls**: per-user and per-IP rate limiting at the gateway; per-plan storage quotas.
7. **Web**: strict CSP, no `dangerouslySetInnerHTML`, parameterised queries only, CORS allow-list.
8. **Retention**: scheduled job deletes expired temporary files and orphaned results.
9. **Ownership policy**: the upload flow requires the user to confirm they own or are authorized to edit the content, and the Terms forbid removing third-party copyright or attribution marks.

No system is unhackable; Stage 7 includes explicit cross-tenant access tests (user A attempting to read/write user B's rows, objects and jobs).

## 5. Job lifecycle

`queued → uploading → processing → completed | failed`

The UI only shows *completed* when the worker has written a result row and the output file exists in storage. Anything else is *failed* with a human-readable reason. Features whose engine is not yet connected are badged **Prototype** in the UI.

## 6. Frontend structure

```
src/
  main.tsx, App.tsx
  styles/        tokens.css · global.css · landing.css
  components/
    layout/      Navbar, Footer, AnimatedBackground
    ui/          Button, Reveal
    compare/     CompareSlider
    landing/     Hero, TrustBar, Features, HowItWorks, Pricing, FinalCTA
  pages/         Landing, Login, Signup (Stage 2), Dashboard (Stage 2)…
  lib/           supabase client (Stage 2), api client (Stage 4)
```

## 7. Stages

| # | Stage | Status |
|---|---|---|
| 1 | Frontend + landing page | **Built in this delivery** |
| 2 | Auth + dashboard shell | Planned |
| 3 | Database + private storage | Planned |
| 4 | Image processing (LaMa) | Planned |
| 5 | Video processing | Planned |
| 6 | Document processing | Planned |
| 7 | Security testing + optimisation | Planned |
| 8 | Deployment | Planned |

## 8. Format support policy

Formats are listed as "supported" only after the processing path is implemented and tested end to end. Until then, the UI marks them **Coming soon** / **Prototype**.
