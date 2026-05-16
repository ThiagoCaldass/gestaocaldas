/**
 * Gestor Caldas — Telegram Webhook
 * Recebe comandos do Telegram, interpreta com Claude e atualiza o Supabase.
 */

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_KEY;
const CLAUDE_KEY    = process.env.CLAUDE_API_KEY;
const TG_TOKEN      = process.env.TG_TOKEN;
const TG_CHAT_ID    = process.env.TG_CHAT_ID;

// ── Utilitários ──────────────────────────────────────────────────────────────

function monthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ── Supabase ─────────────────────────────────────────────────────────────────

async function fetchData(key) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/gestor_data?month_key=eq.${key}&select=data`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  const rows = await res.json();
  return rows?.[0]?.data || null;
}

async function saveData(key, data) {
  await fetch(`${SUPABASE_URL}/rest/v1/gestor_data`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({ month_key: key, data }),
  });
}

function emptyMonth() {
  return {
    balanco: { ganhos: [], gastos: [] },
    calistenia: [],
    personal: { online: [], presencial: [] },
    tattoo: [],
    parcerias: [],
    cartao: {
      bb:    { fechamento: null, parceladas: [], avista: [], assinaturas: [] },
      inter: { fechamento: null, parceladas: [], avista: [], assinaturas: [] },
    },
  };
}

// ── Telegram ──────────────────────────────────────────────────────────────────

export async function sendTelegram(text) {
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TG_CHAT_ID,
      text,
      parse_mode: 'Markdown',
    }),
  });
}

// ── Ferramentas ───────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'add_gasto',
    description: 'Registra um gasto. Se já existir um gasto com nome similar, soma o valor ao existente. Sempre use esta ferramenta para gastos, nunca calcule o total manualmente.',
    input_schema: {
      type: 'object',
      properties: {
        nome:      { type: 'string',  description: 'Descrição do gasto (ex: Mercado, Aluguel). Use o nome mais próximo ao existente.' },
        valor:     { type: 'number',  description: 'Valor A SOMAR em reais — nunca o total acumulado, sempre o delta.' },
        categoria: { type: 'string',  description: 'Categoria (ex: alimentação, transporte, saúde, lazer, casa)' },
        pago:      { type: 'boolean', description: 'Se já foi pago. Default true para "gastei", false para "vou gastar".' },
      },
      required: ['nome', 'valor'],
    },
  },
  {
    name: 'add_ganho',
    description: 'Registra um ganho. Se já existir um ganho com nome similar, soma o valor ao existente. Sempre use esta ferramenta para ganhos.',
    input_schema: {
      type: 'object',
      properties: {
        nome:      { type: 'string',  description: 'Fonte/descrição do ganho' },
        valor:     { type: 'number',  description: 'Valor A SOMAR em reais — nunca o total acumulado, sempre o delta.' },
        categoria: { type: 'string',  description: 'avulso | calistenia | personal | tattoo | 7force' },
        recebido:  { type: 'boolean', description: 'Se já foi recebido. Default true para "recebi", false para "vou receber".' },
      },
      required: ['nome', 'valor'],
    },
  },
  {
    name: 'marcar_gasto_pago',
    description: 'Marca um gasto como pago ou pendente.',
    input_schema: {
      type: 'object',
      properties: {
        id:   { type: 'string'  },
        pago: { type: 'boolean' },
      },
      required: ['id', 'pago'],
    },
  },
  {
    name: 'marcar_ganho_recebido',
    description: 'Marca um ganho como recebido ou pendente.',
    input_schema: {
      type: 'object',
      properties: {
        id:       { type: 'string'  },
        recebido: { type: 'boolean' },
      },
      required: ['id', 'recebido'],
    },
  },
];

// ── Executor de ferramentas ───────────────────────────────────────────────────

function runTool(name, input, md) {
  const b = md.balanco;

  if (name === 'add_gasto') {
    const q = input.nome.toLowerCase();
    const existing = b.gastos.find(g =>
      g.nome.toLowerCase().includes(q) || q.includes(g.nome.toLowerCase())
    );
    if (existing) {
      const antes = existing.valor;
      const delta = Number(input.valor);
      existing.valor = Math.round((existing.valor + delta) * 100) / 100;
      if (input.pago !== undefined) existing.pago = !!input.pago;
      existing.historico = existing.historico || [];
      existing.historico.push({ delta, ts: Date.now(), tipo: 'soma' });
      return `✅ *${existing.nome}* atualizado: R$ ${antes.toFixed(2)} → R$ ${existing.valor.toFixed(2)} (+${delta.toFixed(2)})`;
    }
    const item = {
      id: uid(), nome: input.nome, valor: Number(input.valor),
      categoria: input.categoria || 'outros',
      pago: input.pago ?? false, persistente: false,
      ts: Date.now(), historico: [],
    };
    b.gastos.push(item);
    return `✅ Gasto criado: *${item.nome}* R$ ${item.valor.toFixed(2)} (${item.pago ? 'pago' : 'pendente'})`;
  }

  if (name === 'add_ganho') {
    const q = input.nome.toLowerCase();
    const existing = b.ganhos.find(g =>
      g.nome.toLowerCase().includes(q) || q.includes(g.nome.toLowerCase())
    );
    if (existing) {
      const antes = existing.valor;
      const delta = Number(input.valor);
      existing.valor = Math.round((existing.valor + delta) * 100) / 100;
      if (input.recebido !== undefined) existing.recebido = !!input.recebido;
      existing.historico = existing.historico || [];
      existing.historico.push({ delta, ts: Date.now(), tipo: 'soma' });
      return `✅ *${existing.nome}* atualizado: R$ ${antes.toFixed(2)} → R$ ${existing.valor.toFixed(2)} (+${delta.toFixed(2)})`;
    }
    const item = {
      id: uid(), nome: input.nome, valor: Number(input.valor),
      categoria: input.categoria || 'avulso',
      recebido: input.recebido ?? false,
      ts: Date.now(), historico: [],
    };
    b.ganhos.push(item);
    return `✅ Ganho criado: *${item.nome}* R$ ${item.valor.toFixed(2)} (${item.recebido ? 'recebido' : 'pendente'})`;
  }

  if (name === 'marcar_gasto_pago') {
    const g = b.gastos.find(x => x.id === input.id);
    if (!g) return '❌ Gasto não encontrado.';
    g.pago = input.pago;
    return `✅ *${g.nome}* marcado como ${input.pago ? 'Pago ✓' : 'Pendente'}`;
  }

  if (name === 'marcar_ganho_recebido') {
    const g = b.ganhos.find(x => x.id === input.id);
    if (!g) return '❌ Ganho não encontrado.';
    g.recebido = input.recebido;
    return `✅ *${g.nome}* marcado como ${input.recebido ? 'Recebido ✓' : 'Pendente'}`;
  }

  return '❌ Ferramenta desconhecida.';
}

// ── Handler principal ─────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).end();

  try {
    const message = req.body?.message;
    if (!message?.text) return res.status(200).end();

    const chatId = String(message.chat.id);
    const text   = message.text.trim();

    // Segurança: só aceita mensagens do seu chat
    if (TG_CHAT_ID && chatId !== String(TG_CHAT_ID)) {
      console.log(`Chat não autorizado: ${chatId}`);
      return res.status(200).end();
    }

    const key = monthKey();
    let md = await fetchData(key) || emptyMonth();

    const snapshot = {
      mes: key,
      gastos: md.balanco.gastos.map(g => ({ id: g.id, nome: g.nome, valor: g.valor, categoria: g.categoria, pago: g.pago })),
      ganhos: md.balanco.ganhos.map(g => ({ id: g.id, nome: g.nome, valor: g.valor, categoria: g.categoria, recebido: g.recebido })),
    };

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
        system: `Você é o assistente financeiro do Thiago Caldas via Telegram.
Interprete mensagens em português e use as ferramentas para registrar gastos e ganhos.

Regras:
- "gastei X de Y" ou "comprei X por Y" → add_gasto (pago: true)
- "vou gastar X" ou "tenho gasto de X" → add_gasto (pago: false)
- "recebi X" ou "entrou X" → add_ganho (recebido: true)
- "vou receber X" → add_ganho (recebido: false)
- O valor passado deve ser sempre o delta (quanto foi gasto/ganho agora), nunca o total acumulado
- Seja breve e objetivo nas respostas

Estado atual do mês ${key}:
${JSON.stringify(snapshot, null, 2)}`,
        tools: TOOLS,
        messages: [{ role: 'user', content: text }],
      }),
    });

    const claude = await claudeRes.json();

    let reply = '';
    let changed = false;

    for (const block of claude.content || []) {
      if (block.type === 'tool_use') {
        const result = runTool(block.name, block.input, md);
        reply += result + '\n';
        changed = true;
      } else if (block.type === 'text' && block.text) {
        reply += block.text;
      }
    }

    if (changed) await saveData(key, md);

    const finalReply = reply.trim() || 'Não entendi 🤔\nTente: _"gastei 50 reais de mercado"_';
    await sendTelegram(finalReply);

    return res.status(200).end();

  } catch (err) {
    console.error('Erro no webhook Telegram:', err);
    return res.status(200).end();
  }
}
