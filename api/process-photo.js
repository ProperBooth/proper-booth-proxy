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
    } else if (selected === 'fal-combined') {
      return await callFalCombined(res, { photo, references: refs, prompt, size });
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
// FAL.AI (FLUX.1 Kontext [max] — single-image edit)
// We send ONLY the selfie as the base image. The kit + style are
// described in the prompt text rather than as image refs, because
// the /multi variant blends images instead of treating one as the
// subject and the rest as references — wrong fit for our use case.
// ============================================================
async function callFal(res, { photo, references, prompt, size }) {
  const apiKey = process.env.FAL_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'FAL_API_KEY not configured on server' });
  }

  // Single-image Kontext: only the selfie. Kit reference is left out so it doesn't
  // dominate the generation. Prompt's detailed kit description picks up the slack.
  const body = {
    prompt: String(prompt).slice(0, 5000),
    image_url: photo,
    aspect_ratio: '1:1',
    num_images: 1,
    output_format: 'jpeg',
    safety_tolerance: '5',
    guidance_scale: 4.5 // a bit higher than default 3.5 — sticks more closely to the prompt
  };

  console.log('[fal] Sending — prompt length:', prompt.length,
              '(single-image kontext; refs ignored for this provider)');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 55000);

  let response;
  try {
    response = await fetch('https://fal.run/fal-ai/flux-pro/kontext/max', {
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

// ============================================================
// FAL.AI COMBINED — Two-stage pipeline for accurate kit + face:
//   Stage 1: FLUX Kontext Max — selfie → person in stadium scene
//            with strong face preservation
//   Stage 2: FASHN Try-On v1.6 — swap AI-imagined kit for the
//            actual kit reference image (pixel-accurate garment)
// ============================================================
async function callFalCombined(res, { photo, references, prompt, size }) {
  const apiKey = process.env.FAL_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'FAL_API_KEY not configured on server' });
  }

  const kitRef = references?.[0]; // first reference is the kit (by booth convention)

  // ============ STAGE 1: FLUX Kontext Max ============
  console.log('[fal-combined] Stage 1: FLUX Kontext Max — generating scene...');
  const t1 = Date.now();

  const controller1 = new AbortController();
  const timer1 = setTimeout(() => controller1.abort(), 35000);

  let stage1Res;
  try {
    stage1Res = await fetch('https://fal.run/fal-ai/flux-pro/kontext/max', {
      method: 'POST',
      headers: { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: String(prompt).slice(0, 5000),
        image_url: photo,
        aspect_ratio: '1:1',
        num_images: 1,
        output_format: 'jpeg',
        safety_tolerance: '5',
        guidance_scale: 4.5
      }),
      signal: controller1.signal
    });
  } catch (err) {
    clearTimeout(timer1);
    return res.status(504).json({
      error: 'Stage 1 (FLUX Kontext) failed',
      detail: err.name === 'AbortError' ? 'Timed out at 35s' : (err.message || 'unknown')
    });
  }
  clearTimeout(timer1);

  if (!stage1Res.ok) {
    const errText = await stage1Res.text();
    return res.status(stage1Res.status).json({
      error: `Stage 1 (FLUX Kontext) ${stage1Res.status}`,
      detail: errText.slice(0, 300)
    });
  }

  const stage1Data = await stage1Res.json();
  const stage1Url = stage1Data?.images?.[0]?.url;
  if (!stage1Url) {
    return res.status(500).json({
      error: 'Stage 1 returned no image',
      detail: JSON.stringify(stage1Data).slice(0, 300)
    });
  }

  console.log('[fal-combined] Stage 1 done in', Date.now() - t1, 'ms — URL:', stage1Url.slice(0, 80));

  // If there's no kit reference, return Stage 1 result as-is
  if (!kitRef) {
    console.log('[fal-combined] No kit reference — returning Stage 1 result.');
    return res.status(200).json({
      output_url: stage1Url,
      provider: 'fal-combined',
      note: 'No kit reference provided, returned FLUX Kontext result without try-on'
    });
  }

  // ============ STAGE 2: FASHN Try-On v1.6 ============
  console.log('[fal-combined] Stage 2: FASHN Try-On — swapping in real kit...');
  const t2 = Date.now();

  const controller2 = new AbortController();
  const timer2 = setTimeout(() => controller2.abort(), 35000);

  let stage2Res;
  try {
    stage2Res = await fetch('https://fal.run/fal-ai/fashn/tryon/v1.6', {
      method: 'POST',
      headers: { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model_image: stage1Url,
        garment_image: kitRef,
        category: 'tops' // football jersey = top
      }),
      signal: controller2.signal
    });
  } catch (err) {
    clearTimeout(timer2);
    // Fallback: return Stage 1 result if try-on fails
    console.warn('[fal-combined] Stage 2 failed, returning Stage 1:', err.message);
    return res.status(200).json({
      output_url: stage1Url,
      provider: 'fal-combined',
      warning: `Try-on failed: ${err.name === 'AbortError' ? 'timeout' : err.message}. Returned FLUX Kontext result.`
    });
  }
  clearTimeout(timer2);

  if (!stage2Res.ok) {
    const errText = await stage2Res.text();
    console.warn('[fal-combined] Stage 2 error', stage2Res.status, errText.slice(0, 200));
    return res.status(200).json({
      output_url: stage1Url,
      provider: 'fal-combined',
      warning: `Try-on returned ${stage2Res.status}: ${errText.slice(0, 200)}. Returned FLUX Kontext result.`
    });
  }

  const stage2Data = await stage2Res.json();
  const stage2Url = stage2Data?.images?.[0]?.url || stage2Data?.image?.url;
  if (!stage2Url) {
    console.warn('[fal-combined] Stage 2 returned no image, falling back');
    return res.status(200).json({
      output_url: stage1Url,
      provider: 'fal-combined',
      warning: 'Try-on returned no image. Returned FLUX Kontext result.'
    });
  }

  console.log('[fal-combined] Stage 2 done in', Date.now() - t2, 'ms — URL:', stage2Url.slice(0, 80));

  // Inline the final image as a data URL for the booth's canvas
  let finalUrl;
  try {
    const imgRes = await fetch(stage2Url);
    const buf = await imgRes.arrayBuffer();
    const b64 = Buffer.from(buf).toString('base64');
    const ct = imgRes.headers.get('content-type') || 'image/jpeg';
    finalUrl = `data:${ct};base64,${b64}`;
  } catch (err) {
    finalUrl = stage2Url;
  }

  return res.status(200).json({ output_url: finalUrl, provider: 'fal-combined' });
}
