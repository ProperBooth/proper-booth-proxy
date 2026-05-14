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

  const { photo, reference_photo, references, prompt, provider, size } = req.body || {};
  if (!photo || !prompt) {
    return res.status(400).json({ error: 'Missing photo or prompt in body' });
  }

  // Normalise to an array of references.
  // Accepts legacy single `reference_photo` OR new `references` array.
  let refs = [];
  if (Array.isArray(references)) refs = references.filter(Boolean);
  else if (reference_photo) refs = [reference_photo];

  const selected = (provider || 'gemini').toLowerCase();
  console.log('[proxy] Provider:', selected, '| Reference images:', refs.length);

  try {
    if (selected === 'gemini') {
      return await callGemini(res, { photo, references: refs, prompt, size });
    } else if (selected === 'fal') {
      return await callFal(res, { photo, references: refs, prompt, size });
    } else {
      return await callOpenAI(res, { photo, references: refs, prompt, size });
    }
  } catch (err) {
    console.error('[proxy] Unhandled error:', err);
    return res.status(500).json({ error: err.message || 'Unknown server error' });
  }
}

// ============================================================
// GOOGLE GEMINI (Nano Banana — gemini-2.5-flash-image GA)
// ============================================================
async function callGemini(res, { photo, references, prompt, size }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not configured on server' });
  }

  const stripPrefix = s => s.includes(',') ? s.split(',')[1] : s;

  const parts = [
    { text: prompt },
    { inline_data: { mime_type: 'image/jpeg', data: stripPrefix(photo) } }
  ];

  // Append all reference images in order (Image 2, 3, etc.)
  for (const ref of (references || [])) {
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: stripPrefix(ref) } });
  }

  const body = {
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio: '1:1' }
    }
  };

  console.log('[gemini] Sending — prompt length:', prompt.length, 'total images:', parts.length - 1);

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
async function callOpenAI(res, { photo, references, prompt, size }) {
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
  const allImages = [photo, ...(references || [])];
  const imageField = allImages.length > 1 ? 'image[]' : 'image';
  allImages.forEach((img, i) => {
    const filename = i === 0 ? 'identity.jpg' : `reference-${i}.jpg`;
    formData.append(imageField, new Blob([bufferFrom(img)], { type: 'image/jpeg' }), filename);
  });

  console.log('[openai] Sending — prompt length:', prompt.length, 'total images:', allImages.length);

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

// ============================================================
// FAL.AI (FLUX.1 Kontext [pro] multi — best-in-class for
// character consistency + multi-image conditioning)
// ============================================================
async function callFal(res, { photo, references, prompt, size }) {
  const apiKey = process.env.FAL_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'FAL_API_KEY not configured on server' });
  }

  // FLUX Kontext multi accepts an array of data URLs.
  // Image order: selfie (Image 1), then refs (kit Image 2, style Image 3).
  const image_urls = [photo, ...(references || [])];

  const body = {
    prompt: String(prompt).slice(0, 5000),
    image_urls: image_urls,
    aspect_ratio: '1:1',
    num_images: 1,
    output_format: 'jpeg',
    safety_tolerance: '5' // most permissive — for portraits of real people
  };

  console.log('[fal] Sending — prompt length:', prompt.length, 'total images:', image_urls.length);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 55000);

  let response;
  try {
    response = await fetch('https://fal.run/fal-ai/flux-pro/kontext/max/multi', {
      method: 'POST',
      headers: {
        'Authorization': `Key ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    const msg = err.name === 'AbortError'
      ? `Timed out after 55s — fal.ai didn't respond`
      : `Network: ${err.message || 'unknown'}`;
    return res.status(504).json({ error: msg });
  }
  clearTimeout(timer);

  if (!response.ok) {
    const errText = await response.text();
    let parsed; try { parsed = JSON.parse(errText); } catch (e) { parsed = null; }
    const detail = parsed?.detail || parsed?.error || errText.slice(0, 400);
    console.error('[fal] Error', response.status, detail);
    return res.status(response.status).json({
      error: `fal.ai ${response.status}`,
      detail: typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 400)
    });
  }

  const data = await response.json();
  console.log('[fal] OK — images:', data?.images?.length);

  const imageUrl = data?.images?.[0]?.url;
  if (!imageUrl) {
    return res.status(500).json({
      error: 'No image in fal.ai response',
      detail: JSON.stringify(data).slice(0, 300)
    });
  }

  // fal returns hosted URLs. Fetch and convert to a data URL so the
  // browser doesn't have to deal with cross-origin canvas tainting.
  let dataUrl;
  try {
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) throw new Error(`fetch image ${imgRes.status}`);
    const buf = await imgRes.arrayBuffer();
    const b64 = Buffer.from(buf).toString('base64');
    const ct = imgRes.headers.get('content-type') || 'image/jpeg';
    dataUrl = `data:${ct};base64,${b64}`;
  } catch (err) {
    // Fallback: pass the URL through. Booth's <img crossOrigin="anonymous"> will handle it.
    console.warn('[fal] Could not inline image, returning URL:', err.message);
    dataUrl = imageUrl;
  }

  console.log('[fal] Returning image — length:', dataUrl.length);
  return res.status(200).json({ output_url: dataUrl, provider: 'fal' });
}
