# VISIOMOVER

Your Content. Clean. Clear. Yours.

A secure workspace for cleaning unwanted marks from images, videos and documents you own or are authorized to edit.

## Status

| Stage | Scope | State |
|---|---|---|
| 1 | Frontend, landing page, upload demo, before/after slider | Built |
| 2 | Supabase auth, profiles, protected dashboard | Built. Database security verified (18 checks). Live email flows not yet verified in a browser. |
| 3-8 | Storage, image/video/document processing, hardening, deploy | Planned |

The editors are placeholders and nothing is processed yet. See `ARCHITECTURE.md`.

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
