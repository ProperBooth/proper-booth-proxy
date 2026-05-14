# Proper Booth — Vercel Proxy

This folder is the **proxy function** that calls OpenAI on behalf of the virtual booth.

Deploy this to Vercel. The booth (which lives on Netlify) calls it to do AI photo generation, because Vercel allows longer function timeouts (60s free tier) than Netlify (30s free tier).

## Setup

1. Sign up at [vercel.com](https://vercel.com) (free Hobby plan is fine).
2. Push this folder to a new GitHub repo, or use the Vercel CLI.
3. In Vercel project Settings → Environment Variables, add:
   - `OPENAI_API_KEY` = your OpenAI key (starts with `sk-`)
4. Deploy.
5. The endpoint will be available at: `https://<your-project>.vercel.app/api/process-photo`
6. In the booth code (`deploy/index.html` on Netlify), update `callOpenAIProxy` to call this Vercel URL instead of `/.netlify/functions/process-photo`.
