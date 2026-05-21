// ============================================================
// DELETE-MOMENT — admin-only endpoint that permanently removes
// a moment row from Supabase AND deletes the underlying image
// file from the storage bucket. Uses SUPABASE_SERVICE_KEY which
// bypasses RLS.
//
// Request body (POST):
//   { moment_id: "<uuid>" }
//
// Response:
//   { success: true, deleted_storage: true | false }
// ============================================================

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Supabase env vars not configured' });
  }

  const { moment_id } = req.body || {};
  if (!moment_id) {
    return res.status(400).json({ error: 'Missing moment_id' });
  }

  const authHeaders = {
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    apikey: SUPABASE_SERVICE_KEY
  };

  // 1. Fetch the moment so we know which file to remove from storage
  const lookupRes = await fetch(
    `${SUPABASE_URL}/rest/v1/moments?id=eq.${encodeURIComponent(moment_id)}&select=image_url`,
    { headers: authHeaders }
  );
  if (!lookupRes.ok) {
    const txt = await lookupRes.text();
    return res.status(500).json({ error: 'Could not look up moment', detail: txt.slice(0, 200) });
  }
  const rows = await lookupRes.json();
  if (!rows.length) {
    return res.status(404).json({ error: 'Moment not found' });
  }

  // 2. Delete the storage object (best-effort — don't fail the whole thing if this part fails)
  let deletedStorage = false;
  const imageUrl = rows[0].image_url || '';
  const marker = '/storage/v1/object/public/moment-images/';
  const pathStart = imageUrl.indexOf(marker);
  if (pathStart !== -1) {
    const storagePath = imageUrl.slice(pathStart + marker.length);
    try {
      const storageDelRes = await fetch(
        `${SUPABASE_URL}/storage/v1/object/moment-images/${storagePath}`,
        { method: 'DELETE', headers: authHeaders }
      );
      deletedStorage = storageDelRes.ok;
      if (!storageDelRes.ok) {
        console.warn('[delete-moment] Storage delete returned', storageDelRes.status);
      }
    } catch (err) {
      console.warn('[delete-moment] Storage delete threw:', err.message);
    }
  }

  // 3. Delete the database row
  const dbDelRes = await fetch(
    `${SUPABASE_URL}/rest/v1/moments?id=eq.${encodeURIComponent(moment_id)}`,
    { method: 'DELETE', headers: authHeaders }
  );
  if (!dbDelRes.ok) {
    const txt = await dbDelRes.text();
    return res.status(500).json({ error: 'Could not delete moment row', detail: txt.slice(0, 200) });
  }

  return res.status(200).json({ success: true, deleted_storage: deletedStorage });
}
