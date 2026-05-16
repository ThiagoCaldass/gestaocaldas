/**
 * Gestor Caldas — Ferramentas compartilhadas (WhatsApp + Telegram)
 */

// ── Utilitários ───────────────────────────────────────────────────────────────

export function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function monthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function calcAteQuando(nParcelas) {
  const now = new Date();
  let m = now.getMonth() + 1 + nParcelas - 1;
  let y = now.getFullYear();
  while (m > 12) { m -= 12; y++; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

// ── Supabase ──────────────────────────────────────────────────────────────────

export async function fetchData(key, SUPABASE_URL, SUPABASE_KEY) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/gestor_data?month_key=eq.${key}&select=data`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  const rows = await res.json();
  return rows?.[0]?.data || null;
}

export async function saveData(key, data, SUPABASE_URL, SUPABASE_KEY) {
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

export async function saveUndo(key, data, SUPABASE_URL, SUPABASE_KEY) {
  await saveData(`__undo_${key}__`, data, SUPABASE_URL, SUPABASE_KEY);
}

export async function loadUndo(key, SUPABASE_URL, SUPABASE_KEY) {
  return await fetchData(`__undo_${key}__`, SUPABASE_URL, SUPABASE_KEY);
}

export function emptyMonth() {
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

// ── Definição das ferramentas ─────────────────────────────────────────────────

export const TOOLS = [
  {
    name: 'add_gasto',
    description: 'Registra um gasto no balanço. Se já existir gasto com nome similar, soma o valor ao existente. Passe sempre o delta (valor novo), nunca o total acumulado.',
    input_schema: {
      type: 'object',
      properties: {
        nome:      { type: 'string',  description: 'Descrição do gasto (ex: Mercado, Aluguel)' },
        valor:     { type: 'number',  description: 'Valor A SOMAR em reais — sempre o delta' },
        categoria: { type: 'string',  description: 'alimentação | transporte | saúde | lazer | casa | trabalho | outros' },
        pago:      { type: 'boolean', description: 'true para "gastei", false para "vou gastar"' },
      },
      required: ['nome', 'valor'],
    },
  },
  {
    name: 'add_ganho',
    description: 'Registra um ganho no balanço. Se já existir ganho com nome similar, soma o valor ao existente.',
    input_schema: {
      type: 'object',
      properties: {
        nome:      { type: 'string',  description: 'Fonte/descrição do ganho' },
        valor:     { type: 'number',  description: 'Valor A SOMAR em reais — sempre o delta' },
        categoria: { type: 'string',  description: 'avulso | calistenia | personal | tattoo | 7force' },
        recebido:  { type: 'boolean', description: 'true para "recebi", false para "vou receber"' },
      },
      required: ['nome', 'valor'],
    },
  },
  {
    name: 'marcar_aluno_pago',
    description: 'Marca um aluno como pago. Busca pelo nome em calistenia, personal online e presencial automaticamente.',
    input_schema: {
      type: 'object',
      properties: {
        nome_parcial: { type: 'string', description: 'Parte do nome do aluno' },
        tipo: { type: 'string', enum: ['auto', 'calistenia', 'online', 'presencial'], description: 'Tipo do aluno. Use "auto" para buscar em todos.' },
      },
      required: ['nome_parcial'],
    },
  },
  {
    name: 'registrar_presenca',
    description: 'Registra uma aula/presença de hoje para um aluno presencial.',
    input_schema: {
      type: 'object',
      properties: {
        nome_parcial: { type: 'string', description: 'Parte do nome do aluno presencial' },
      },
      required: ['nome_parcial'],
    },
  },
  {
    name: 'novo_aluno',
    description: 'Adiciona um novo aluno (calistenia, personal online ou presencial).',
    input_schema: {
      type: 'object',
      properties: {
        nome:  { type: 'string', description: 'Nome completo do aluno' },
        tipo:  { type: 'string', enum: ['calistenia', 'online', 'presencial'], description: 'Tipo do aluno' },
        valor: { type: 'number', description: 'Valor mensal em reais' },
      },
      required: ['nome', 'tipo', 'valor'],
    },
  },
  {
    name: 'add_cartao_avista',
    description: 'Registra uma compra à vista no cartão de crédito.',
    input_schema: {
      type: 'object',
      properties: {
        titulo: { type: 'string', description: 'Descrição da compra' },
        valor:  { type: 'number', description: 'Valor total em reais' },
        cartao: { type: 'string', enum: ['bb', 'inter'], description: 'Qual cartão: bb (Banco do Brasil) ou inter' },
      },
      required: ['titulo', 'valor', 'cartao'],
    },
  },
  {
    name: 'add_cartao_parcelado',
    description: 'Registra uma compra parcelada no cartão de crédito.',
    input_schema: {
      type: 'object',
      properties: {
        titulo:   { type: 'string', description: 'Descrição da compra' },
        valor:    { type: 'number', description: 'Valor de CADA parcela em reais' },
        parcelas: { type: 'number', description: 'Número total de parcelas' },
        cartao:   { type: 'string', enum: ['bb', 'inter'], description: 'Qual cartão: bb ou inter' },
      },
      required: ['titulo', 'valor', 'parcelas', 'cartao'],
    },
  },
  {
    name: 'marcar_gasto_pago',
    description: 'Marca um gasto do balanço como pago ou pendente.',
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
    description: 'Marca um ganho do balanço como recebido ou pendente.',
    input_schema: {
      type: 'object',
      properties: {
        id:       { type: 'string'  },
        recebido: { type: 'boolean' },
      },
      required: ['id', 'recebido'],
    },
  },
  {
    name: 'desfazer',
    description: 'Desfaz a última alteração feita nesta sessão, restaurando o estado anterior.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

// ── Executor de ferramentas ───────────────────────────────────────────────────

export function runTool(name, input, md) {
  const b = md.balanco;

  // ── Balanço ────────────────────────────────────────────────────────────────

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

  // ── Alunos ─────────────────────────────────────────────────────────────────

  if (name === 'marcar_aluno_pago') {
    const q    = input.nome_parcial.toLowerCase();
    const tipo = input.tipo || 'auto';
    let item = null, found_tipo = '';

    if (tipo === 'calistenia' || tipo === 'auto') {
      item = md.calistenia.find(a => a.nome.toLowerCase().includes(q));
      if (item) found_tipo = 'calistenia';
    }
    if (!item && (tipo === 'online' || tipo === 'auto')) {
      item = md.personal.online.find(a => a.nome.toLowerCase().includes(q));
      if (item) found_tipo = 'online';
    }
    if (!item && (tipo === 'presencial' || tipo === 'auto')) {
      item = md.personal.presencial.find(a => a.nome.toLowerCase().includes(q));
      if (item) found_tipo = 'presencial';
    }
    if (!item) {
      const todos = [
        ...md.calistenia.map(a => a.nome),
        ...md.personal.online.map(a => a.nome),
        ...md.personal.presencial.map(a => a.nome),
      ];
      return `❌ Aluno "${input.nome_parcial}" não encontrado.\nAlunos: ${todos.join(', ')}`;
    }
    item.pago = true;
    return `✅ *${item.nome}* (${found_tipo}) marcado como pago ✓`;
  }

  if (name === 'registrar_presenca') {
    const q = input.nome_parcial.toLowerCase();
    const item = md.personal.presencial.find(a => a.nome.toLowerCase().includes(q));
    if (!item) {
      const nomes = md.personal.presencial.map(a => a.nome).join(', ') || 'nenhum';
      return `❌ Aluno presencial "${input.nome_parcial}" não encontrado.\nPresenciais: ${nomes}`;
    }
    const today = new Date().toISOString().split('T')[0];
    if (!item.aulasDatas) item.aulasDatas = [];
    item.aulasDatas.push(today);
    return `✅ Presença registrada: *${item.nome}* — ${item.aulasDatas.length} aulas no mês`;
  }

  if (name === 'novo_aluno') {
    const { nome, tipo, valor } = input;
    const obj = {
      id: uid(), nome, valor: Number(valor),
      pago: false, pausado: false,
      diaAcerto: '', attTreino: '', obs: '',
      valorAula: tipo === 'presencial' ? 0 : 0,
      aulasDatas: [],
    };
    if (tipo === 'calistenia') {
      obj.valorBase = Number(valor);
      obj.valorFinal = Number(valor);
      obj.familiaId = null;
      obj.familiaDesconto = 0;
      delete obj.diaAcerto;
      delete obj.attTreino;
      delete obj.obs;
      delete obj.valorAula;
      delete obj.aulasDatas;
      md.calistenia.push(obj);
    } else if (tipo === 'online') {
      delete obj.aulasDatas;
      md.personal.online.push(obj);
    } else if (tipo === 'presencial') {
      md.personal.presencial.push(obj);
    } else {
      return '❌ Tipo inválido. Use: calistenia, online ou presencial.';
    }
    return `✅ Novo aluno adicionado: *${nome}* (${tipo}) — R$ ${Number(valor).toFixed(2)}/mês`;
  }

  // ── Cartão ─────────────────────────────────────────────────────────────────

  if (name === 'add_cartao_avista') {
    const { titulo, valor, cartao } = input;
    const bank = cartao === 'inter' ? 'inter' : 'bb';
    const data = new Date().toISOString().split('T')[0];
    if (!md.cartao) md.cartao = emptyMonth().cartao;
    md.cartao[bank].avista.push({ id: uid(), titulo, valor: Number(valor), data });
    const label = bank === 'bb' ? 'BB' : 'Inter';
    return `✅ Compra à vista no *${label}*: *${titulo}* — R$ ${Number(valor).toFixed(2)}`;
  }

  if (name === 'add_cartao_parcelado') {
    const { titulo, valor, parcelas, cartao } = input;
    const bank = cartao === 'inter' ? 'inter' : 'bb';
    const data = new Date().toISOString().split('T')[0];
    const ateQuando = calcAteQuando(Number(parcelas));
    if (!md.cartao) md.cartao = emptyMonth().cartao;
    md.cartao[bank].parceladas.push({
      id: uid(), titulo,
      valor: Number(valor),
      parcelas: Number(parcelas),
      ateQuando, data,
    });
    const label = bank === 'bb' ? 'BB' : 'Inter';
    return `✅ Parcelado no *${label}*: *${titulo}* — ${parcelas}x R$ ${Number(valor).toFixed(2)} (até ${ateQuando})`;
  }

  return `❌ Ferramenta "${name}" desconhecida.`;
}

// ── Prompt do sistema ─────────────────────────────────────────────────────────

export function buildSystemPrompt(key, md) {
  const snapshot = {
    mes: key,
    gastos: md.balanco.gastos.map(g => ({ id: g.id, nome: g.nome, valor: g.valor, categoria: g.categoria, pago: g.pago })),
    ganhos: md.balanco.ganhos.map(g => ({ id: g.id, nome: g.nome, valor: g.valor, categoria: g.categoria, recebido: g.recebido })),
    alunos_calistenia: md.calistenia.map(a => ({ id: a.id, nome: a.nome, valor: a.valorFinal ?? a.valor, pago: a.pago })),
    alunos_online: md.personal.online.map(a => ({ id: a.id, nome: a.nome, valor: a.valor, pago: a.pago })),
    alunos_presencial: md.personal.presencial.map(a => ({ id: a.id, nome: a.nome, valor: a.valor, pago: a.pago, aulas: a.aulasDatas?.length ?? 0 })),
    cartao: {
      bb:    { avista: md.cartao?.bb?.avista?.length ?? 0,    parceladas: md.cartao?.bb?.parceladas?.length ?? 0 },
      inter: { avista: md.cartao?.inter?.avista?.length ?? 0, parceladas: md.cartao?.inter?.parceladas?.length ?? 0 },
    },
  };

  return `Você é o assistente financeiro do Thiago Caldas.
Interprete mensagens em português e use as ferramentas para registrar informações.

Regras:
- "gastei X de Y" → add_gasto (pago: true) | "vou gastar X" → add_gasto (pago: false)
- "recebi X" → add_ganho (recebido: true) | "vou receber X" → add_ganho (recebido: false)
- "X pagou" ou "fulano pagou" → marcar_aluno_pago (busca automática pelo nome)
- "X treinou" ou "aula do X" → registrar_presenca
- "novo aluno X de calistenia/online/presencial, R$ Y" → novo_aluno
- "gastei X no crédito à vista no BB/Inter" → add_cartao_avista
- "parcelei X em Y vezes no BB/Inter" → add_cartao_parcelado (valor = valor por parcela)
- O valor passado para add_gasto/add_ganho é SEMPRE o delta, nunca o total acumulado
- Se não entender, responda explicando o que não ficou claro

Estado atual do mês ${key}:
${JSON.stringify(snapshot, null, 2)}`;
}
