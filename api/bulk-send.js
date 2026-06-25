/**
 * POST /api/bulk-send
 * Body: { messages: [{ to: "5511999999999", body: "text", nome?: "..." }] }
 * Envia cada mensagem via Meta WhatsApp Cloud API com delay entre envios.
 */

const WA_TOKEN    = process.env.WA_TOKEN;
const WA_PHONE_ID = process.env.WA_PHONE_ID;

async function sendWA(to, body) {
  const res = await fetch(`https://graph.facebook.com/v19.0/${WA_PHONE_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WA_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body, preview_url: false },
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `HTTP ${res.status}`);
  }
  return true;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  if (!WA_TOKEN || !WA_PHONE_ID) {
    return res.status(500).json({ error: 'WA_TOKEN ou WA_PHONE_ID não configurados.' });
  }

  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array obrigatório' });
  }

  const results = [];
  for (const msg of messages) {
    try {
      await sendWA(msg.to, msg.body);
      results.push({ to: msg.to, ok: true });
    } catch (e) {
      results.push({ to: msg.to, ok: false, error: e.message });
    }
    // Pequeno delay para evitar rate limit
    await new Promise(r => setTimeout(r, 350));
  }

  return res.status(200).json({ results });
}
