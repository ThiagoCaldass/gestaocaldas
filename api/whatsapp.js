/**
 * Gestor Caldas — WhatsApp Webhook
 * Recebe mensagens do WhatsApp via Meta Cloud API,
 * interpreta com Claude e atualiza o Supabase.
 */

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_KEY;
const CLAUDE_KEY    = process.env.CLAUDE_API_KEY;
const WA_TOKEN      = process.env.WA_TOKEN;       // Token de acesso Meta
const WA_PHONE_ID   = process.env.WA_PHONE_ID;    // ID do número WhatsApp
const VERIFY_TOKEN  = process.env.VERIFY_TOKEN;   // String que você define
const MEU_NUMERO    = process.env.MEU_NUMERO;      // Ex: 5511999999999

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
      Prefer: 'resolution=merge-duplicates',
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

// ── Ferramentas (mesmas do Assistente TC) ────────────────────────────────────

const TOOLS = [
  {
    name: 'add_gasto',
    description: 'Adiciona um gasto ao balanço do mês atual.',
    input_schema: {
      type: 'object',
      properties: {
        nome:      { type: 'string',  description: 'Descrição do gasto (ex: Mercado, Aluguel)' },
        valor:     { type: 'number',  description: 'Valor em reais' },
        categoria: { type: 'string',  description: 'Categoria (ex: alimentação, transporte, saúde, lazer, casa)' },
        pago:      { type: 'boolean', description: 'Se já foi pago. Default false.' },
      },
      required: ['nome', 'valor'],
    },
  },
  {
    name: 'add_ganho',
    description: 'Adiciona um ganho ao balanço do mês atual.',
    input_schema: {
      type: 'object',
      properties: {
        nome:      { type: 'string',  description: 'Fonte/descrição do ganho' },
        valor:     { type: 'number',  description: 'Valor em reais' },
        categoria: { type: 'string',  description: 'avulso | calistenia | personal | tattoo | 7force' },
        recebido:  { type: 'boolean', description: 'Se já foi recebido. Default false.' },
      },
      required: ['nome', 'valor'],
    },
  },
  {
    name: 'update_gasto',
    description: 'Atualiza campos de um gasto existente pelo ID.',
    input_schema: {
      type: 'object',
      properties: {
        id:        { type: 'string'  },
        nome:      { type: 'string'  },
        valor:     { type: 'number'  },
        categoria: { type: 'string'  },
        pago:      { type: 'boolean' },
      },
      required: ['id'],
    },
  },
  {
    name: 'update_ganho',
    description: 'Atualiza campos de um ganho existente pelo ID.',
    input_schema: {
      type: 'object',
      properties: {
        id:       { type: 'string'  },
        nome:     { type: 'string'  },
        valor:    { type: 'number'  },
        recebido: { type: 'boolean' },
      },
      required: ['id'],
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

// ── Execução das ferramentas ──────────────────────────────────────────────────

function runTool(name, input, md) {
  const b = md.balanco;

  if (name === 'add_gasto') {
    const item = {
      id: uid(), nome: input.nome, valor: input.valor,
      categoria: input.categoria || 'outros',
      pago: input.pago ?? false, persistente: false,
    };
    b.gastos.push(item);
    return `✅ Gasto adicionado:\n*${item.nome}* — R$ ${item.valor.toFixed(2)}\nStatus: ${item.pago ? 'Pago' : 'Pendente'}`;
  }

  if (name === 'add_ganho') {
    const item = {
      id: uid(), nome: input.nome, valor: input.valor,
      categoria: input.categoria || 'avulso',
      recebido: input.recebido ?? false,
    };
    b.ganhos.push(item);
    return `✅ Ganho adicionado:\n*${item.nome}* — R$ ${item.valor.toFixed(2)}\nStatus: ${item.recebido ? 'Recebido' : 'Pendente'}`;
  }

  if (name === 'update_gasto') {
    const g = b.gastos.find(x => x.id === input.id);
    if (!g) return '❌ Gasto não encontrado.';
    if (input.nome      !== undefined) g.nome      = input.nome;
    if (input.valor     !== undefined) g.valor     = input.valor;
    if (input.categoria !== undefined) g.categoria = input.categoria;
    if (input.pago      !== undefined) g.pago      = input.pago;
    return `✅ Gasto *${g.nome}* atualizado — R$ ${g.valor.toFixed(2)}`;
  }

  if (name === 'update_ganho') {
    const g = b.ganhos.find(x => x.id === input.id);
    if (!g) return '❌ Ganho não encontrado.';
    if (input.nome     !== undefined) g.nome     = input.nome;
    if (input.valor    !== undefined) g.valor    = input.valor;
    if (input.recebido !== undefined) g.recebido = input.recebido;
    return `✅ Ganho *${g.nome}* atualizado — R$ ${g.valor.toFixed(2)}`;
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

  // 1. Verificação do webhook (Meta faz um GET quando você cadastra a URL)
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

  // 2. Responde 200 imediatamente (Meta exige resposta em < 5s)
  res.status(200).end();

  if (req.method !== 'POST') return;

  try {
    const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message || message.type !== 'text') return;

    const from = message.from;   // ex: "5511999999999"
    const text = message.text.body.trim();

    // Segurança: só aceita mensagens do seu número
    if (MEU_NUMERO && from !== MEU_NUMERO) {
      console.log(`Número não autorizado: ${from}`);
      return;
    }

    // Busca dados do mês atual
    const key = monthKey();
    let md = await fetchData(key) || emptyMonth();

    // Snapshot compacto para o Claude
    const snapshot = {
      mes: key,
      gastos: md.balanco.gastos.map(g => ({
        id: g.id, nome: g.nome, valor: g.valor,
        categoria: g.categoria, pago: g.pago,
      })),
      ganhos: md.balanco.ganhos.map(g => ({
        id: g.id, nome: g.nome, valor: g.valor,
        categoria: g.categoria, recebido: g.recebido,
      })),
    };

    // Chama Claude
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 1024,
        system: `Você é o assistente financeiro do Thiago Caldas via WhatsApp.
Interprete mensagens em português e use as ferramentas para registrar gastos e ganhos.

Regras:
- "gastei X de Y" ou "comprei X por Y" → add_gasto (pago: true)
- "vou gastar X" ou "tenho gasto de X" → add_gasto (pago: false)
- "recebi X" ou "entrou X" → add_ganho (recebido: true)
- "vou receber X" → add_ganho (recebido: false)
- Se citar um gasto que já existe na lista, atualize o valor em vez de criar novo
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
    await sendMessage(from, finalReply);

  } catch (err) {
    console.error('Erro no webhook:', err);
  }
}
