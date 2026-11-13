# Run VISIOMOVER locally (real Supabase auth)

1. Install Node 20+.
2. In this folder: `npm install`
3. Copy `.env.example` to `.env.local` and fill in:
   - VITE_SUPABASE_URL      (Supabase -> Project Settings -> API -> Project URL)
   - VITE_SUPABASE_PUBLISHABLE_KEY  (the publishable / anon key; never the service_role key)
4. `npm run dev` and open http://localhost:5173
5. In Supabase -> Authentication -> URL Configuration add http://localhost:5173/** to Redirect URLs.
