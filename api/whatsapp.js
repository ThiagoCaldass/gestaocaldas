/**
 * Gestor Caldas — WhatsApp Webhook
 * Recebe mensagens do WhatsApp via Meta Cloud API,
 * interpreta com Claude e atualiza o Supabase.
 */

import {
  TOOLS, runTool, buildSystemPrompt,
  fetchData, saveData, saveUndo, loadUndo, emptyMonth, monthKey,
} from './_tools.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const CLAUDE_KEY   = process.env.CLAUDE_API_KEY;
const WA_TOKEN     = process.env.WA_TOKEN;
const WA_PHONE_ID  = process.env.WA_PHONE_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const MEU_NUMERO   = process.env.MEU_NUMERO;
const TG_TOKEN     = process.env.TG_TOKEN;
const TG_CHAT_ID   = process.env.TG_CHAT_ID;

// ── Telegram ─────────────────────────────────────────────────────────────────

async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'Markdown' }),
  });
}

// ── WhatsApp ─────────────────────────────────────────────────────────────────

async function sendMessage(to, text) {
  await fetch(`https://graph.facebook.com/v19.0/${WA_PHONE_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WA_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    }),
  });
}

// ── Handler principal ─────────────────────────────────────────────────────────

export default async function handler(req, res) {

  // Verificação do webhook (Meta faz um GET quando você cadastra a URL)
  if (req.method === 'GET') {
    const mode      = req.query['hub.mode'];
    const token     = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('Webhook verificado ✓');
      return res.status(200).send(challenge);
    }
    return res.status(403).end();
  }

  if (req.method !== 'POST') return res.status(200).end();

  try {
    const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message || message.type !== 'text') return res.status(200).end();

    const from = message.from;
    const text = message.text.body.trim();

    // Segurança: só aceita mensagens do seu número
    if (MEU_NUMERO && from !== MEU_NUMERO) {
      console.log(`Número não autorizado: ${from}`);
      return res.status(200).end();
    }

    const key = monthKey();
    let md = await fetchData(key, SUPABASE_URL, SUPABASE_KEY) || emptyMonth();

    // Salva snapshot para undo antes de qualquer alteração
    const snapshot = JSON.parse(JSON.stringify(md));

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 1024,
        system: buildSystemPrompt(key, md),
        tools: TOOLS,
        messages: [{ role: 'user', content: text }],
      }),
    });

    const claude = await claudeRes.json();

    let reply   = '';
    let changed = false;

    for (const block of claude.content || []) {
      if (block.type === 'tool_use') {
        if (block.name === 'desfazer') {
          const undo = await loadUndo(key, SUPABASE_URL, SUPABASE_KEY);
          if (undo) {
            md = undo;
            changed = true;
            reply += '↩️ Última alteração desfeita.\n';
          } else {
            reply += '❌ Nenhuma alteração anterior encontrada para desfazer.\n';
          }
        } else {
          // Salva snapshot apenas na primeira ferramenta real
          if (!changed) {
            await saveUndo(key, snapshot, SUPABASE_URL, SUPABASE_KEY);
          }
          const result = runTool(block.name, block.input, md);
          reply += result + '\n';
          changed = true;
        }
      } else if (block.type === 'text' && block.text) {
        reply += block.text;
      }
    }

    if (changed) {
      await saveData(key, md, SUPABASE_URL, SUPABASE_KEY);
      await sendTelegram(`📱 *WhatsApp*\n${reply.trim()}`);
    }

    const finalReply = reply.trim() || 'Não entendi 🤔\nExemplos:\n_"gastei 50 de mercado"_\n_"João pagou"_\n_"nova aluna Ana presencial 300"_';
    await sendMessage(from, finalReply);

    return res.status(200).end();

  } catch (err) {
    console.error('Erro no webhook:', err);
    return res.status(200).end();
  }
}
