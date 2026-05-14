// ============================================================
// VERCEL PROXY — supports OpenAI gpt-image-1 AND Google Gemini
// (Nano Banana / gemini-2.5-flash-image). Optionally accepts a
// second "reference_photo" for style/identity guidance.
// ============================================================
//
// Environment variables required on Vercel:
//   OPENAI_API_KEY = sk-...     (for provider='openai')
//   GEMINI_API_KEY = AIzaSy...  (for provider='gemini')
//
// Request body (POST):
//   {
//     photo:           "data:image/jpeg;base64,..."  (required, the selfie)
//     prompt:          "Create a cinematic..."        (required)
//     provider:        "openai" | "gemini"            (optional, default 'gemini')
//     reference_photo: "data:image/jpeg;base64,..."  (optional, Image 2)
//     size:            "1024x1024"                    (optional)
//   }
//
// Response:
//   { output_url: "data:image/...", provider: "openai" | "gemini" }
// ============================================================

export const config = {
  maxDuration: 60
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { photo, reference_photo, prompt, provider, size } = req.body || {};
  if (!photo || !prompt) {
    return res.status(400).json({ error: 'Missing photo or prompt in body' });
  }

  const selected = (provider || 'gemini').toLowerCase();
  console.log('[proxy] Provider:', selected, '| Reference image:', !!reference_photo);

  try {
    if (selected === 'gemini') {
      return await callGemini(res, { photo, reference_photo, prompt, size });
    } else {
      return await callOpenAI(res, { photo, reference_photo, prompt, size });
    }
  } catch (err) {
    console.error('[proxy] Unhandled error:', err);
    return res.status(500).json({ error: err.message || 'Unknown server error' });
  }
}

// ============================================================
// GOOGLE GEMINI (Nano Banana — gemini-2.5-flash-image GA)
// ============================================================
async function callGemini(res, { photo, reference_photo, prompt, size }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not configured on server' });
  }

  const stripPrefix = s => s.includes(',') ? s.split(',')[1] : s;

  const parts = [
    { text: prompt },
    { inline_data: { mime_type: 'image/jpeg', data: stripPrefix(photo) } }
  ];

  if (reference_photo) {
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: stripPrefix(reference_photo) } });
  }

  const body = {
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio: '1:1' }
    }
  };

  console.log('[gemini] Sending — prompt length:', prompt.length, 'images:', parts.length - 1);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 55000);

  let response;
  try {
    response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
        signal: controller.signal
      }
    );
  } catch (err) {
    clearTimeout(timer);
    const msg = err.name === 'AbortError'
      ? `Timed out after 55s — Gemini didn't respond`
      : `Network: ${err.message || 'unknown'}`;
    return res.status(504).json({ error: msg });
  }
  clearTimeout(timer);

  if (!response.ok) {
    const errText = await response.text();
    let parsed; try { parsed = JSON.parse(errText); } catch (e) { parsed = null; }
    const detail = parsed?.error?.message || errText.slice(0, 400);
    console.error('[gemini] Error', response.status, detail);
    return res.status(response.status).json({
      error: `Gemini ${response.status}`,
      detail
    });
  }

  const data = await response.json();
  const candidates = data?.candidates || [];
  console.log('[gemini] OK — candidates:', candidates.length);

  const responseParts = candidates[0]?.content?.parts || [];
  const imagePart = responseParts.find(p => p.inlineData || p.inline_data);

  if (!imagePart) {
    const textPart = responseParts.find(p => p.text);
    const finishReason = candidates[0]?.finishReason || 'unknown';
    const blockReason = data?.promptFeedback?.blockReason || '';
    const detail = textPart ? textPart.text.slice(0, 120) : '(no text either)';
    return res.status(500).json({
      error: 'No image in Gemini response',
      detail: `Finish:${finishReason} ${blockReason} Said:"${detail}"`
    });
  }

  const inline = imagePart.inlineData || imagePart.inline_data;
  const mime = inline.mimeType || inline.mime_type || 'image/png';
  const output_url = `data:${mime};base64,${inline.data}`;

  console.log('[gemini] Returning image — length:', output_url.length);

  return res.status(200).json({ output_url, provider: 'gemini' });
}

// ============================================================
// OPENAI (gpt-image-1 image-edits)
// ============================================================
async function callOpenAI(res, { photo, reference_photo, prompt, size }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'OPENAI_API_KEY not configured on server' });
  }

  const stripPrefix = s => s.includes(',') ? s.split(',')[1] : s;
  const bufferFrom = s => Buffer.from(stripPrefix(s), 'base64');

  const formData = new FormData();
  formData.append('model', 'gpt-image-1');
  formData.append('prompt', String(prompt).slice(0, 32000));
  formData.append('n', '1');
  formData.append('size', size || '1024x1024');
  formData.append('output_format', 'jpeg');
  formData.append('input_fidelity', 'high'); // identity preservation

  // OpenAI's edits endpoint: single image uses field name "image",
  // multiple images use array notation "image[]".
  const imageField = reference_photo ? 'image[]' : 'image';
  formData.append(imageField, new Blob([bufferFrom(photo)], { type: 'image/jpeg' }), 'identity.jpg');
  if (reference_photo) {
    formData.append(imageField, new Blob([bufferFrom(reference_photo)], { type: 'image/jpeg' }), 'style.jpg');
  }

  console.log('[openai] Sending — prompt length:', prompt.length, 'images:', reference_photo ? 2 : 1);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 55000);

  let response;
  try {
    response = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    const msg = err.name === 'AbortError'
      ? `Timed out after 55s — OpenAI didn't respond`
      : `Network: ${err.message || 'unknown'}`;
    return res.status(504).json({ error: msg });
  }
  clearTimeout(timer);

  if (!response.ok) {
    const errText = await response.text();
    let parsed; try { parsed = JSON.parse(errText); } catch (e) { parsed = null; }
    const detail = parsed?.error?.message || errText.slice(0, 400);
    return res.status(response.status).json({
      error: `OpenAI ${response.status}`,
      detail
    });
  }

  const data = await response.json();
  console.log('[openai] OK — data length:', data?.data?.length);

  const item = data?.data?.[0];
  if (!item || (!item.b64_json && !item.url)) {
    return res.status(500).json({
      error: 'No image in OpenAI response',
      detail: data?.error?.message || JSON.stringify(data).slice(0, 200)
    });
  }

  const output_url = item.b64_json
    ? `data:image/jpeg;base64,${item.b64_json}`
    : item.url;

  return res.status(200).json({ output_url, provider: 'openai' });
}
