// ============================================================
// CONFIG ENDPOINT — returns the public-facing config for the gallery.
// Pulls values from Vercel environment variables so we don't have to
// hardcode them in the gallery HTML.
//
// Returned values are SAFE TO EXPOSE in the browser:
//   - SUPABASE_URL (public project URL)
//   - SUPABASE_ANON_KEY (anon public key — RLS protects this)
//   - EVENT_SLUG (which event the gallery should filter to)
//
// The service_role key is NEVER returned here.
// ============================================================

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  // Cache for 60 seconds at the edge so we don't hammer Vercel on every page load
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');

  return res.status(200).json({
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
    eventSlug: process.env.EVENT_SLUG || 'wales-vs-europe-2026'
  });
}
