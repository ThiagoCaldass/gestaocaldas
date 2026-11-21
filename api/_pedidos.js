/**
 * Gestor Caldas — pedidos de mudança no treino que os alunos fazem pelo WhatsApp.
 * Guardados em __pedidos_treino__ (lista). O webhook do MarcFlow (api/pedidos-webhook.js) cria os pedidos;
 * as ferramentas MCP pedidos_treino_* listam, concluem, criam e desfazem. Nada aqui manda mensagem ao aluno.
 */

import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { fetchData, saveData, monthKey, uid } from './_tools.js';
import { salvarMes, acharAluno, ErroEscrita } from './_escrita.js';

export const CHAVE = '__pedidos_treino__';
const CHAVE_UNDO = '__undo_pedidos_treino__';
const U = () => process.env.SUPABASE_URL, K = () => process.env.SUPABASE_KEY;
const MODELO = 'claude-haiku-5-5';
const JUNTAR_MIN = 30;   // mensagens seguidas do mesmo aluno dentro disso viram um pedido só
export const TIPOS = ['troca_exercicio', 'dor_lesao', 'equipamento', 'dias_volume', 'duvida_tecnica', 'outro'];
const URG = ['baixa', 'media', 'alta'];

const so = d => String(d || '').replace(/\D/g, '');
const fim8 = t => { const d = so(t); return d.length >= 8 ? d.slice(-8) : null; };
const sem = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// ── Armazenamento ────────────────────────────────────────────────────────────

export async function lerPedidos() {
  const d = await fetchData(CHAVE, U(), K());
  return Array.isArray(d) ? d : [];
}
const gravar = lista => salvarMes(CHAVE, lista);   // mesmo POST com updated_at das outras escritas

/** Desfazer por item: guarda como cada pedido estava antes (ou que foi criado), sem apagar o que chegou depois. */
async function guardarDesfazer(acao, antes, criados = []) {
  await saveData(CHAVE_UNDO, { acao, ts: new Date().toISOString(), antes, criados }, U(), K()).catch(() => {});
}

// ── Alunos do Gestor ─────────────────────────────────────────────────────────

const alunosDo = md => [
  ...(md?.personal?.online || []).map(a => ({ a, modalidade: 'online' })),
  ...(md?.personal?.presencial || []).map(a => ({ a, modalidade: 'presencial' })),
  ...(md?.parcerias || []).map(a => ({ a, modalidade: 'parceria' })),
  ...(md?.calistenia || []).map(a => ({ a, modalidade: 'calistenia' })),
].filter(({ a }) => a?.nome);

/** Aluno pelo telefone (últimos 8 dígitos, como mesmaPessoa). Exportada para teste. */
export function alunoPorTelefone(md, telefone) {
  const t = fim8(telefone);
  if (!t) return null;
  const achados = alunosDo(md).filter(({ a }) => fim8(a.telefone) === t);
  return (achados.find(x => !x.a.pausado) || achados[0]) || null;
}

// ── Classificação ────────────────────────────────────────────────────────────

const SISTEMA = `Você recebe mensagens de WhatsApp que chegaram para o Thiago, personal trainer (consultoria online de treino e aulas presenciais). Diga se a ÚLTIMA mensagem é um aluno pedindo mudança ou ajuste no treino, ou relatando algo que exige ajuste.
Conta como pedido (e_pedido = true):
- trocar, tirar ou adicionar exercício; não gostou ou não consegue fazer um exercício (troca_exercicio)
- dor, desconforto, lesão, incômodo em articulação (dor_lesao) — urgência SEMPRE "alta"
- academia não tem o aparelho, mudou de academia, vai treinar em casa ou viajando (equipamento)
- mudar dias, frequência, duração, volume, "está pesado/leve demais" (dias_volume)
- dúvida de como executar um exercício ou de como ler o treino (duvida_tecnica)
- pedido vago de mudança ("dá pra mudar meu treino?", "queria ajustar umas coisas") (outro)
Não conta: cumprimento, agradecimento, "ok", conversa social, pagamento, agendamento de aula, envio de formulário sem pedido, perguntas de quem ainda não é aluno sobre preços ou como funciona.
Use as mensagens anteriores só como contexto para entender a última.
"resumo": uma frase curta em português, na terceira pessoa, dizendo o que o aluno quer (ex.: "Quer trocar o leg press, academia não tem"). Se não for pedido, resumo vazio.
"urgencia": alta para dor/lesão ou treino impossível de fazer; media para trocas e equipamento; baixa para dúvidas e ajustes finos.`;

const ESQUEMA = {
  type: 'object',
  properties: {
    e_pedido: { type: 'boolean' },
    resumo: { type: 'string' },
    tipo: { type: 'string', enum: TIPOS },
    urgencia: { type: 'string', enum: URG },
  },
  required: ['e_pedido', 'resumo', 'tipo', 'urgencia'],
  additionalProperties: false,
};

/**
 * Pergunta ao Claude se a mensagem é um pedido. contexto = [{ de: 'aluno'|'Thiago', texto }] (mais antigas primeiro).
 * Devolve { e_pedido, resumo, tipo, urgencia } ou lança erro (quem chama registra como "não classificada").
 */
export async function classificar(texto, contexto = [], { cliente, resumoAberto } = {}) {
  const c = cliente || new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
  const linhas = contexto.map(m => `${m.de === 'Thiago' ? 'Thiago' : 'Aluno'}: ${String(m.texto || '').slice(0, 500)}`);
  const conteudo = (linhas.length ? `Mensagens anteriores:\n${linhas.join('\n')}\n\n` : '')
    + (resumoAberto ? `Este aluno já tem um pedido aberto agora há pouco: "${resumoAberto}". Se a última mensagem completa ou acrescenta algo a esse pedido, marque e_pedido = true e escreva um "resumo" único que junte os dois.\n\n` : '')
    + `ÚLTIMA mensagem (classifique esta):\nAluno: ${String(texto).slice(0, 2000)}`;
  const r = await c.messages.create({
    model: MODELO,
    max_tokens: 300,
    system: SISTEMA,
    messages: [{ role: 'user', content: conteudo }],
    output_config: { format: { type: 'json_schema', schema: ESQUEMA } },
  });
  const bloco = (r.content || []).find(b => b.type === 'text');
  const j = JSON.parse(bloco?.text || '');
  if (typeof j.e_pedido !== 'boolean' || !TIPOS.includes(j.tipo) || !URG.includes(j.urgencia)) throw new Error('Resposta fora do formato');
  if (j.tipo === 'dor_lesao') j.urgencia = 'alta';
  return j;
}

// ── Registro de uma mensagem recebida (usado pelo webhook) ───────────────────

/** Pedido aberto do mesmo contato com mensagem nos últimos 30 min (as próximas mensagens entram nele). */
export function pedidoRecente(lista, { telefone, jid, agora }) {
  const t8 = fim8(telefone);
  const limite = new Date(Date.parse(agora) - JUNTAR_MIN * 60000).toISOString();
  return lista.find(p => p.status === 'aberto' && p.origem === 'whatsapp' && (t8 ? fim8(p.telefone) === t8 : p.jid === jid) && (p.ultima_mensagem_em || p.criado_em) >= limite) || null;
}

const maiorUrg = (a, b) => URG[Math.max(URG.indexOf(a), URG.indexOf(b))] || a || b;
const chaveMsg = (telefone, texto) => createHash('sha256').update(`${fim8(telefone) || telefone}|${sem(texto)}`).digest('hex').slice(0, 16);

/**
 * Decide o que fazer com uma mensagem já classificada (em memória, sem gravar). Exportada para teste.
 * Retorna { lista, pedido, novo, avisar } ou { ignorada: motivo }.
 */
export function registrar(lista, { msgId, telefone, jid, nomeContato, texto, quando, aluno, classe, agora }) {
  const hash = chaveMsg(telefone || jid, texto);
  if (lista.some(p => (msgId && (p.msg_ids || []).includes(msgId)) || (p.hashes || []).includes(hash))) return { ignorada: 'mensagem já registrada' };
  const naoClassificada = !classe;
  if (!naoClassificada && !classe.e_pedido) return { ignorada: 'não é pedido' };
  const c = classe || { resumo: '', tipo: 'nao_classificada', urgencia: 'media' };

  // mensagens seguidas do mesmo contato viram um pedido só
  const aberto = pedidoRecente(lista, { telefone, jid, agora });
  if (aberto) {
    const urgAntes = aberto.urgencia;
    aberto.mensagem_original = `${aberto.mensagem_original}\n${texto}`.slice(-4000);
    if (c.resumo) aberto.resumo = c.resumo;   // o classificador recebeu o resumo aberto e escreveu um que junta os dois
    if (aberto.tipo === 'nao_classificada' && c.tipo !== 'nao_classificada') aberto.tipo = c.tipo;
    aberto.urgencia = maiorUrg(aberto.urgencia, c.urgencia);
    aberto.ultima_mensagem_em = quando || agora;
    aberto.msg_ids = [...(aberto.msg_ids || []), msgId].filter(Boolean);
    aberto.hashes = [...(aberto.hashes || []), hash];
    return { lista, pedido: aberto, novo: false, avisar: aberto.urgencia === 'alta' && urgAntes !== 'alta' };
  }

  const pedido = {
    id: uid(),
    aluno: aluno?.nome || null,
    modalidade: aluno?.modalidade || null,
    nome_contato: nomeContato || null,
    telefone: so(telefone) || null,
    jid: jid || null,
    mensagem_original: String(texto).slice(0, 4000),
    resumo: c.resumo || (naoClassificada ? `Não classificada: "${String(texto).slice(0, 120)}"` : ''),
    tipo: c.tipo,
    urgencia: c.urgencia,
    criado_em: quando || agora,
    ultima_mensagem_em: quando || agora,
    status: 'aberto',
    concluido_em: null,
    origem: 'whatsapp',
    msg_ids: msgId ? [msgId] : [],
    hashes: [hash],
  };
  lista.push(pedido);
  return { lista, pedido, novo: true, avisar: true };
}

// ── Textos ───────────────────────────────────────────────────────────────────

export function haQuanto(iso, agora = new Date().toISOString()) {
  const min = Math.max(0, Math.round((Date.parse(agora) - Date.parse(iso)) / 60000));
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.round(h / 24);
  return `há ${d} dia${d > 1 ? 's' : ''}`;
}

const ROTULO = { troca_exercicio: 'troca de exercício', dor_lesao: 'dor/lesão', equipamento: 'equipamento', dias_volume: 'dias/volume', duvida_tecnica: 'dúvida técnica', outro: 'outro', nao_classificada: 'não classificada' };
const ICONE = { alta: '🔴', media: '🟡', baixa: '⚪' };

/** Texto do aviso no Telegram (texto puro, sem Markdown: a frase do aluno pode ter * e _). */
export function textoAviso(p, { novo = true, agora } = {}) {
  const quem = p.aluno || `${p.nome_contato || 'Contato'} (não achei no Gestor${p.telefone ? `, ${p.telefone}` : ''})`;
  const frase = p.mensagem_original.length > 500 ? p.mensagem_original.slice(-500) : p.mensagem_original;
  return [
    `${ICONE[p.urgencia] || '🟡'} ${novo ? 'Pedido de treino' : 'Pedido de treino ficou urgente'}: ${quem}`,
    `${p.resumo || '(sem resumo)'} · ${ROTULO[p.tipo] || p.tipo}`,
    `"${frase}"`,
    `Recebido ${haQuanto(p.criado_em, agora)}`,
  ].join('\n');
}

export async function avisarTelegram(texto, fetchFn = fetch) {
  const { TG_TOKEN, TG_CHAT_ID } = process.env;
  if (!TG_TOKEN || !TG_CHAT_ID) throw new Error('Telegram não configurado');
  const r = await fetchFn(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT_ID, text: texto, disable_web_page_preview: true }),
  });
  if (!r.ok) throw new Error(`Telegram ${r.status}`);
}

/** Visão curta de um pedido para as ferramentas e pendências. */
export function visao(p, hoje) {
  const dias = Math.max(0, Math.floor((Date.parse(hoje) - Date.parse(String(p.criado_em).slice(0, 10))) / 86400000));
  return {
    id: p.id, aluno: p.aluno || p.nome_contato || p.telefone, ...(p.aluno ? {} : { aluno_nao_encontrado_no_gestor: true, telefone: p.telefone }),
    resumo: p.resumo, tipo: p.tipo, urgencia: p.urgencia, mensagem_original: p.mensagem_original,
    criado_em: p.criado_em, dias_esperando: dias, status: p.status, ...(p.concluido_em ? { concluido_em: p.concluido_em } : {}),
  };
}

const ordemUrg = p => -URG.indexOf(p.urgencia);
export const abertos = lista => lista.filter(p => p.status === 'aberto').sort((a, b) => ordemUrg(a) - ordemUrg(b) || String(a.criado_em).localeCompare(String(b.criado_em)));

// ── Ferramentas MCP ──────────────────────────────────────────────────────────

const escrita = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
export const PEDIDOS_TOOLS = [
  { name: 'pedidos_treino_listar', title: 'Pedidos de mudança no treino',
    description: 'Pedidos que os alunos fizeram pelo WhatsApp para mudar o treino (detectados automaticamente) ou criados à mão. Padrão: só os abertos, mais urgentes primeiro, com os dias de espera.',
    inputSchema: { type: 'object', properties: {
      status: { type: 'string', enum: ['aberto', 'feito', 'todos'], description: 'Padrão: aberto' },
      aluno: { type: 'string', description: 'Opcional: filtrar por trecho do nome' },
    }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'pedidos_treino_concluir', title: 'Concluir pedido de treino',
    description: 'Marca um pedido como feito. Passe o "id" ou o nome do aluno; se o aluno tiver mais de um pedido aberto, a ferramenta lista os ids e pede para escolher. Confirme com o Thiago antes.',
    inputSchema: { type: 'object', properties: {
      id: { type: 'string', description: 'Id do pedido (de pedidos_treino_listar)' },
      aluno: { type: 'string', description: 'Nome do aluno (se não souber o id)' },
    }, additionalProperties: false },
    annotations: escrita },
  { name: 'pedidos_treino_criar', title: 'Registrar pedido de treino',
    description: 'Registra à mão um pedido de mudança no treino (ex.: o aluno pediu pessoalmente). Confirme com o Thiago antes.',
    inputSchema: { type: 'object', properties: {
      aluno: { type: 'string', description: 'Nome do aluno no Gestor' },
      resumo: { type: 'string', description: 'O que o aluno quer, numa frase' },
      tipo: { type: 'string', enum: TIPOS, description: 'Padrão: outro' },
      urgencia: { type: 'string', enum: URG, description: 'Padrão: media (dor/lesão vira alta)' },
      mensagem_original: { type: 'string', description: 'Opcional: o que o aluno disse' },
    }, required: ['aluno', 'resumo'], additionalProperties: false },
    annotations: escrita },
  { name: 'pedidos_treino_desfazer', title: 'Desfazer última alteração nos pedidos',
    description: 'Desfaz a última alteração feita por pedidos_treino_concluir ou pedidos_treino_criar (não apaga pedidos que chegaram depois).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: escrita },
];
export const PEDIDOS_NOMES = new Set(PEDIDOS_TOOLS.map(t => t.name));

/** Lógica das ferramentas em memória (exportada para teste). Retorna { lista?, undo?, resposta }. */
export function aplicarPedido(nome, lista, args, { hoje, agora, md }) {
  switch (nome) {
    case 'pedidos_treino_listar': {
      const st = args.status || 'aberto';
      let l = st === 'todos' ? lista : st === 'aberto' ? abertos(lista) : lista.filter(p => p.status === 'feito').sort((a, b) => String(b.concluido_em).localeCompare(String(a.concluido_em)));
      if (args.aluno) { const q = sem(args.aluno); l = l.filter(p => sem(p.aluno || p.nome_contato).includes(q)); }
      return { resposta: { hoje, status: st, total: l.length, pedidos: l.slice(0, 100).map(p => visao(p, hoje)) } };
    }
    case 'pedidos_treino_concluir': {
      let alvo;
      if (args.id) {
        alvo = lista.find(p => p.id === args.id);
        if (!alvo) throw new ErroEscrita(`Pedido ${args.id} não encontrado`);
      } else {
        const q = sem(args.aluno);
        if (!q) throw new ErroEscrita('Informe "id" ou "aluno"');
        const ab = abertos(lista).filter(p => sem(p.aluno || p.nome_contato).includes(q));
        if (!ab.length) throw new ErroEscrita(`Nenhum pedido aberto de "${args.aluno}"`);
        if (ab.length > 1) return { resposta: { ok: false, precisa_escolher: true, mensagem: `${args.aluno} tem ${ab.length} pedidos abertos. Chame de novo com o "id" do pedido certo.`, pedidos: ab.map(p => visao(p, hoje)) } };
        alvo = ab[0];
      }
      if (alvo.status === 'feito') throw new ErroEscrita(`Esse pedido já está feito desde ${alvo.concluido_em}`);
      const antes = JSON.parse(JSON.stringify(alvo));
      alvo.status = 'feito'; alvo.concluido_em = agora;
      return { lista, undo: { acao: nome, antes: [antes], criados: [] }, resposta: { ok: true, resumo: `Pedido de ${alvo.aluno || alvo.nome_contato} marcado como feito: ${alvo.resumo}`, pedido: visao(alvo, hoje) } };
    }
    case 'pedidos_treino_criar': {
      if (!String(args.resumo || '').trim()) throw new ErroEscrita('Informe o "resumo"');
      const tipo = TIPOS.includes(args.tipo) ? args.tipo : 'outro';
      let urgencia = URG.includes(args.urgencia) ? args.urgencia : 'media';
      if (tipo === 'dor_lesao') urgencia = 'alta';
      const a = acharAluno(md || {}, args.aluno);
      const modalidade = (md?.personal?.online || []).includes(a) ? 'online' : (md?.personal?.presencial || []).includes(a) ? 'presencial' : 'parceria';
      const p = {
        id: uid(), aluno: a.nome, modalidade, nome_contato: null, telefone: so(a.telefone) || null, jid: null,
        mensagem_original: String(args.mensagem_original || args.resumo).slice(0, 4000), resumo: String(args.resumo).trim(),
        tipo, urgencia, criado_em: agora, ultima_mensagem_em: agora, status: 'aberto', concluido_em: null, origem: 'manual', msg_ids: [], hashes: [],
      };
      lista.push(p);
      return { lista, undo: { acao: nome, antes: [], criados: [p.id] }, resposta: { ok: true, resumo: `Pedido registrado para ${a.nome}: ${p.resumo}`, pedido: visao(p, hoje) } };
    }
    default:
      throw new ErroEscrita(`Ferramenta desconhecida: ${nome}`);
  }
}

/** Aplica um registro de desfazer na lista atual (em memória). Exportada para teste. */
export function aplicarDesfazer(lista, undo) {
  const criados = new Set(undo.criados || []);
  const out = lista.filter(p => !criados.has(p.id));
  for (const antes of undo.antes || []) {
    const i = out.findIndex(p => p.id === antes.id);
    if (i >= 0) out[i] = antes; else out.push(antes);
  }
  return out;
}

export async function executarPedidos(nome, args, { hoje, agora = new Date().toISOString() }) {
  if (nome === 'pedidos_treino_desfazer') {
    const undo = await fetchData(CHAVE_UNDO, U(), K());
    if (!undo || undo.desfeito) throw new ErroEscrita('Nada para desfazer nos pedidos');
    await gravar(aplicarDesfazer(await lerPedidos(), undo));
    await saveData(CHAVE_UNDO, { ...undo, desfeito: true }, U(), K()).catch(() => {});
    return { ok: true, resumo: `Desfeito: ${undo.acao} de ${undo.ts}` };
  }
  const lista = await lerPedidos();
  const md = nome === 'pedidos_treino_criar' ? await fetchData(monthKey(), U(), K()) : null;
  const r = aplicarPedido(nome, lista, args, { hoje, agora, md });
  if (r.undo) {
    await guardarDesfazer(r.undo.acao, r.undo.antes, r.undo.criados);
    await gravar(r.lista);
  }
  return r.resposta;
}
