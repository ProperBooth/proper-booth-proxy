// ============================================================
// VERCEL PROXY — calls OpenAI's image-edits endpoint
// ============================================================
//
// This is a Vercel serverless function. It receives a selfie +
// prompt from The Proper Booth, calls OpenAI's gpt-image-1
// image-edits endpoint, and returns the transformed image as
// a base64 data URL.
//
// Requires environment variable on Vercel:
//   OPENAI_API_KEY = sk-...
//
// Place this file in your Vercel project at:
//   /api/process-photo.js
// It will be reachable at:
//   https://your-vercel-project.vercel.app/api/process-photo
// ============================================================

export const config = {
  // Vercel free Hobby tier supports up to 60-second timeouts
  maxDuration: 60
};

export default async function handler(req, res) {
  // CORS — booth lives on a different domain (Netlify) and calls us
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'OPENAI_API_KEY not configured on server' });
  }

  const { photo, prompt, size } = req.body || {};
  if (!photo || !prompt) {
    return res.status(400).json({ error: 'Missing photo or prompt in body' });
  }

  // Strip the "data:image/jpeg;base64," prefix if present
  const base64 = photo.includes(',') ? photo.split(',')[1] : photo;

  let binaryBuffer;
  try {
    binaryBuffer = Buffer.from(base64, 'base64');
  } catch (err) {
    return res.status(400).json({ error: 'Photo base64 could not be decoded' });
  }

  // Build multipart form-data the way OpenAI expects.
  // NOTE: gpt-image-1 edits endpoint does NOT accept `quality` or
  // `response_format` parameters (those are images/generations-only).
  const formData = new FormData();
  formData.append('model', 'gpt-image-1');
  formData.append('prompt', String(prompt).slice(0, 32000));
  formData.append('n', '1');
  formData.append('size', size || '1024x1024');
  formData.append('output_format', 'jpeg');
  formData.append('input_fidelity', 'high');
  formData.append('image', new Blob([binaryBuffer], { type: 'image/jpeg' }), 'photo.jpg');

  console.log('[proxy] Sending to OpenAI: prompt length', prompt.length, 'image bytes', binaryBuffer.length);

  // Hard timeout inside the function — keep below Vercel's max
  const controller = new AbortController();
  const TIMEOUT_MS = 55000;
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let openaiRes;
  try {
    openaiRes = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    const msg = err.name === 'AbortError'
      ? `Timed out after ${TIMEOUT_MS / 1000}s — OpenAI didn't respond`
      : `Network: ${err.message || 'unknown'}`;
    return res.status(504).json({ error: msg });
  }
  clearTimeout(timer);

  if (!openaiRes.ok) {
    const errText = await openaiRes.text();
    let parsed;
    try { parsed = JSON.parse(errText); } catch (e) { parsed = null; }
    const detail = parsed?.error?.message || errText.slice(0, 400);
    console.error('[proxy] OpenAI error', openaiRes.status, detail);
    return res.status(openaiRes.status).json({
      error: `OpenAI ${openaiRes.status}`,
      detail
    });
  }

  const data = await openaiRes.json();

  console.log('[proxy] OpenAI 200, data length:', data?.data?.length);
  console.log('[proxy] First item keys:', data?.data?.[0] ? Object.keys(data.data[0]) : 'none');

  const item = data?.data?.[0];
  if (!item || (!item.b64_json && !item.url)) {
    const detail = data?.error?.message || JSON.stringify(data).slice(0, 300);
    return res.status(500).json({
      error: 'No image in OpenAI response',
      detail
    });
  }

  const output_url = item.b64_json
    ? `data:image/jpeg;base64,${item.b64_json}`
    : item.url;

  console.log('[proxy] Returning image — type:', item.b64_json ? 'base64' : 'url', 'length:', output_url.length);

  return res.status(200).json({ output_url });
}
