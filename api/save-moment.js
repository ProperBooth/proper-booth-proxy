// ============================================================
// SUPABASE PROXY — saves a completed booth moment.
// Uploads the composited share image to Supabase Storage AND
// inserts a row in the `moments` table for the live gallery.
//
// Environment variables on Vercel:
//   SUPABASE_URL          (e.g. https://fourbebcgmndoifdqgtv.supabase.co)
//   SUPABASE_SERVICE_KEY  (the secret service_role key — bypasses RLS)
//
// Request body (POST):
//   {
//     image_data_url: "data:image/jpeg;base64,...",  (required, the final composite)
//     name: "Charlotte",
//     team: "Wales",
//     message: "Go Wales!",
//     event_slug: "wales-vs-europe-2026",  (optional, defaults to this)
//     session_id: "wve_abc"                (optional client-side ID)
//   }
//
// Response:
//   { image_url: "https://...supabase.co/...", moment_id: "uuid", moment: {...} }
// ============================================================

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  // CORS for the booth (different origin)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({
      error: 'Supabase env vars not configured',
      detail: 'Set SUPABASE_URL and SUPABASE_SERVICE_KEY in Vercel'
    });
  }

  const { image_data_url, name, team, message, event_slug, session_id } = req.body || {};
  if (!image_data_url || !name) {
    return res.status(400).json({ error: 'Missing image_data_url or name' });
  }

  const slug = (event_slug || 'wales-vs-europe-2026').replace(/[^a-z0-9-]/gi, '').slice(0, 60);

  // ============ Decode the image data URL ============
  const base64 = image_data_url.includes(',') ? image_data_url.split(',')[1] : image_data_url;
  let buffer;
  try {
    buffer = Buffer.from(base64, 'base64');
  } catch (err) {
    return res.status(400).json({ error: 'Could not decode base64 image' });
  }
  if (buffer.length < 1000) {
    return res.status(400).json({ error: 'Image data is suspiciously small' });
  }

  // ============ Upload to Supabase Storage ============
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 10);
  const filePath = `${slug}/${ts}-${rand}.jpg`;
  const uploadUrl = `${SUPABASE_URL}/storage/v1/object/moment-images/${filePath}`;

  console.log('[save-moment] Uploading', buffer.length, 'bytes to', filePath);

  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'apikey': SUPABASE_SERVICE_KEY,
      'Content-Type': 'image/jpeg',
      'x-upsert': 'true'
    },
    body: buffer
  });

  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    console.error('[save-moment] Upload failed', uploadRes.status, errText.slice(0, 300));
    return res.status(uploadRes.status).json({
      error: 'Supabase storage upload failed',
      detail: errText.slice(0, 300)
    });
  }

  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/moment-images/${filePath}`;
  console.log('[save-moment] Uploaded. Public URL:', publicUrl);

  // ============ Insert moment row ============
  const insertUrl = `${SUPABASE_URL}/rest/v1/moments`;
  const insertRes = await fetch(insertUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'apikey': SUPABASE_SERVICE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify({
      event_slug: slug,
      name: String(name).slice(0, 60),
      team: team ? String(team).slice(0, 40) : null,
      message: message ? String(message).slice(0, 200) : null,
      image_url: publicUrl,
      hidden: false
    })
  });

  if (!insertRes.ok) {
    const errText = await insertRes.text();
    console.error('[save-moment] Insert failed', insertRes.status, errText.slice(0, 300));
    return res.status(insertRes.status).json({
      error: 'Supabase moments insert failed',
      detail: errText.slice(0, 300),
      image_url: publicUrl // at least return the URL so the booth still works
    });
  }

  const inserted = await insertRes.json();
  const moment = Array.isArray(inserted) ? inserted[0] : inserted;

  console.log('[save-moment] Saved moment:', moment.id);

  return res.status(200).json({
    image_url: publicUrl,
    moment_id: moment.id,
    moment: moment
  });
}
