/**
 * Gestor Caldas — Servidor MCP para conectar o Claude.ai aos dados do app (finanças: leitura) e ao WhatsApp de trabalho (MarcFlow: leitura e envio)
 * POST /mcp/<chave>  (ou /api/mcp com Authorization: Bearer <chave>)
 * Protocolo MCP via HTTP "streamable", sem sessão: cada POST é uma mensagem JSON-RPC.
 * A chave fica na variável de ambiente MCP_CHAVE da Vercel — sem ela o endpoint recusa tudo.
 */

import { timingSafeEqual } from 'node:crypto';
import { fetchData, hojeBR, monthKey } from './_tools.js';
import { resumoDetalhado, resumoCurto, resumoPoupanca, saldoRealPessoal } from './_resumo.js';
import { WA_TOOLS, WA_NOMES, executarWhatsapp, ErroWhats } from './_whatsapp.js';
import { treinosVencimento } from './_treinos.js';
import { pendencias } from './_pendencias.js';
import { respostasFormulario } from './central.js';
import { ESCRITA_TOOLS, ESCRITA_NOMES, escreverTreino, ErroEscrita } from './_escrita.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const MCP_CHAVE    = process.env.MCP_CHAVE;

const VERSOES = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const RE_MES = /^\d{4}-\d{2}$/;

const INSTRUCOES = `Dados do Gestor Caldas, app de gestão financeira do Thiago Caldas (personal trainer autônomo: calistenia, consultoria online e aulas presenciais).
Cada mês ("YYYY-MM") tem: ganhos e gastos da conta pessoal, alunos (com quem pagou e em qual conta), cartões (BB, Inter e empresarial) e a conta empresarial (saídas e retiradas para a conta pessoal).
Valores em reais. "saldo_real" = recebido − pago na conta pessoal; a linha "Mês anterior" é o saldo que sobrou do mês anterior. Retiradas da conta empresarial aparecem como ganho pessoal.
Comece por listar_meses para saber quais meses existem. As ferramentas de finanças são só de leitura. Para treinos: pendencias mostra o que fazer hoje; treino_pausar, treino_retomar, treino_registrar_entrega, treino_formulario_enviado e treino_corrigir_data gravam no mês atual (confirme com o Thiago antes de gravar).\nTreinos: treinos_vencimento mostra quando vence o treino de cada aluno e para quem mandar o formulário de atualização.

WhatsApp de trabalho (ferramentas whatsapp_*, pelo MarcFlow): dá para ler conversas, buscar mensagens, ver agendamentos e os fluxos automáticos, e também enviar texto, enviar arquivo por link (Drive, Docs ou https), responder, agendar e marcar como lida. Arquivo anexado no chat não dá para enviar: peça ao Thiago um link do Drive com acesso "Qualquer pessoa com o link". Para enviar ou agendar, mostre antes ao Thiago o destinatário e o texto exato (ou o arquivo e a legenda) e espere ele confirmar. Escreva como o Thiago escreve: curto, informal, em português do Brasil.`;

const TOOLS = [
  {
    name: 'listar_meses',
    title: 'Listar meses',
    description: 'Lista os meses com dados no app, com um resumo de cada um (saldo real pessoal, receita de alunos, gastos, cartões). Use primeiro para saber o período disponível.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'ler_mes',
    title: 'Ler um mês',
    description: 'Detalhe completo de um mês: cada ganho e gasto pessoal (valor, se foi pago, dia do pagamento, se é fixo), alunos por modalidade (previsto, recebido, pendentes), cartões e conta empresarial.',
    inputSchema: {
      type: 'object',
      properties: { mes: { type: 'string', description: 'Mês no formato YYYY-MM, ex: 2026-10' } },
      required: ['mes'], additionalProperties: false,
    },
  },
  {
    name: 'comparar_meses',
    title: 'Comparar meses',
    description: 'Resumo lado a lado de um intervalo de meses (receita de alunos, outros ganhos, gastos totais e fixos, maiores gastos, cartões, saídas empresariais, saldo real). Bom para tendências e médias.',
    inputSchema: {
      type: 'object',
      properties: {
        de:  { type: 'string', description: 'Primeiro mês (YYYY-MM)' },
        ate: { type: 'string', description: 'Último mês (YYYY-MM)' },
      },
      required: ['de', 'ate'], additionalProperties: false,
    },
  },
  {
    name: 'buscar_lancamentos',
    title: 'Buscar lançamentos',
    description: 'Procura por nome (sem diferenciar maiúsculas/acentos) em ganhos, gastos, compras de cartão e saídas empresariais de todos os meses (ou de um intervalo). Ex: "mercado", "uber", "aluguel".',
    inputSchema: {
      type: 'object',
      properties: {
        texto: { type: 'string', description: 'Trecho do nome a procurar' },
        de:    { type: 'string', description: 'Opcional: primeiro mês (YYYY-MM)' },
        ate:   { type: 'string', description: 'Opcional: último mês (YYYY-MM)' },
      },
      required: ['texto'], additionalProperties: false,
    },
  },
  {
    name: 'ler_poupanca',
    title: 'Ler poupança',
    description: 'Saldo atual da poupança, meta mensal e todos os depósitos/resgates por mês.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'ler_analise',
    title: 'Ler análise do mês',
    description: 'Texto da análise do Assistente Financeiro já gerada no app para um mês (se existir).',
    inputSchema: {
      type: 'object',
      properties: { mes: { type: 'string', description: 'Mês no formato YYYY-MM' } },
      required: ['mes'], additionalProperties: false,
    },
  },
  {
    name: 'treinos_vencimento',
    title: 'Vencimento dos treinos',
    description: 'Data da próxima atualização do treino de cada aluno ativo (consultoria online, presencial e parcerias), quantos dias faltam, a situação do formulário no Gestor e a última resposta na planilha do Google. "mandar_formulario" lista para quem o Thiago precisa mandar o formulário de atualização: treino vencido ou vencendo dentro de "dias", sem formulário enviado, sem resposta na planilha esperando virar treino (sem "Feito") e sem treino pausado. Resposta já marcada como Feito não tira o aluno da lista. \"atualizacao_desatualizada\" (com \"aviso\") indica que a última resposta Feito é mais nova que a última atualização registrada no Gestor: falta registrar. \"cobrar_resposta\" são formulários enviados há 5+ dias sem resposta. \"treino_pausado\" são alunos ativos com o treino pausado (não contam como vencidos). \"sem_data\" são alunos sem data de próxima atualização no Gestor. Alunos de calistenia não têm data de treino no Gestor.',
    inputSchema: {
      type: 'object',
      properties: {
        dias: { type: 'integer', minimum: 0, maximum: 90, description: 'Janela em dias para considerar "vencendo" (padrão 7, igual ao app)' },
        todos: { type: 'boolean', description: 'Listar todos os alunos ativos, não só os que pedem ação' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'pendencias',
    title: 'Pendências do dia',
    description: 'Lista do que o Thiago precisa fazer hoje com base no Gestor: formulários a enviar, treinos a montar (aluno respondeu), datas a registrar, formulários sem resposta, alunos sem data, pagamentos em aberto e alertas de qualidade dos dados (telefone faltando, nome duplicado, registro de teste). Não inclui follow-up de WhatsApp.',
    inputSchema: { type: 'object', properties: { dias: { type: 'integer', minimum: 0, maximum: 90, description: 'Janela em dias para "vencendo" (padrão 7)' } }, additionalProperties: false },
  },
].map(t => ({ ...t, annotations: { readOnlyHint: true, openWorldHint: false } })).concat(ESCRITA_TOOLS, WA_TOOLS);

// ── Dados ─────────────────────────────────────────────────────────────────────

// Todos os meses (chaves YYYY-MM) num intervalo — as chaves especiais começam com "__" e ficam de fora
async function fetchMeses(de = '2000-01', ate = '2999-12') {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/gestor_data?month_key=gte.${de}&month_key=lte.${ate}&select=month_key,data&order=month_key.asc`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  if (!res.ok) throw new Error(`Supabase ${res.status}`);
  const rows = await res.json();
  return rows.filter(r => RE_MES.test(r.month_key) && r.data);
}

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function lancamentos(mes, md) {
  const out = [];
  const b = md.balanco || {};
  (b.ganhos || []).forEach(g => out.push({ mes, tipo: 'ganho pessoal', nome: g.nome, valor: g.valor, feito: !!g.recebido }));
  (b.gastos || []).forEach(g => out.push({ mes, tipo: 'gasto pessoal', nome: g.nome, valor: g.valor, feito: !!g.pago, fixo_mensal: !!g.persistente }));
  for (const [cartao, c] of Object.entries(md.cartao || {})) {
    (c?.avista || []).forEach(x => out.push({ mes, tipo: `cartão ${cartao} à vista`, nome: x.titulo, valor: x.valor, data: x.data }));
    (c?.parceladas || []).forEach(x => out.push({ mes, tipo: `cartão ${cartao} parcela`, nome: x.titulo, valor: x.valor, parcelas: x.parcelas, ate: x.ateQuando }));
    (c?.assinaturas || []).filter(x => !x.pausada).forEach(x => out.push({ mes, tipo: `cartão ${cartao} assinatura`, nome: x.titulo || x.nome, valor: x.valor }));
  }
  (md.contaEmp?.saidas || []).forEach(x => out.push({ mes, tipo: 'saída empresarial', nome: x.desc, valor: x.valor, feito: !!x.pago }));
  return out;
}

function checaMes(v, campo) {
  if (!RE_MES.test(v || '')) throw new ErroUso(`"${campo}" deve estar no formato YYYY-MM`);
}
class ErroUso extends Error {}

async function executar(nome, args = {}) {
  if (WA_NOMES.has(nome)) return executarWhatsapp(nome, args);
  if (ESCRITA_NOMES.has(nome)) return escreverTreino(nome, args);
  switch (nome) {
    case 'listar_meses': {
      const rows = await fetchMeses();
      return {
        hoje: hojeBR(), mes_atual: monthKey(),
        meses: rows.map(r => ({ mes: r.month_key, ...resumoCurto(r.data), maiores_gastos: undefined })),
      };
    }
    case 'ler_mes': {
      checaMes(args.mes, 'mes');
      const md = await fetchData(args.mes, SUPABASE_URL, SUPABASE_KEY);
      if (!md) return { mes: args.mes, erro: 'Mês sem dados no app' };
      return { mes: args.mes, mes_em_andamento: args.mes === monthKey(), hoje: hojeBR(), ...resumoDetalhado(md) };
    }
    case 'comparar_meses': {
      checaMes(args.de, 'de'); checaMes(args.ate, 'ate');
      const rows = await fetchMeses(args.de, args.ate);
      return { meses: rows.map(r => ({ mes: r.month_key, ...resumoCurto(r.data) })) };
    }
    case 'buscar_lancamentos': {
      const q = norm(args.texto).trim();
      if (!q) throw new ErroUso('"texto" vazio');
      if (args.de) checaMes(args.de, 'de');
      if (args.ate) checaMes(args.ate, 'ate');
      const rows = await fetchMeses(args.de, args.ate);
      const achados = rows.flatMap(r => lancamentos(r.month_key, r.data)).filter(l => norm(l.nome).includes(q));
      const total = Math.round(achados.reduce((s, l) => s + (Number(l.valor) || 0), 0) * 100) / 100;
      return { texto: args.texto, encontrados: achados.length, soma_valores: total, lancamentos: achados.slice(0, 300) };
    }
    case 'ler_poupanca': {
      const p = await fetchData('__poupanca__', SUPABASE_URL, SUPABASE_KEY);
      if (!p) return { erro: 'Sem dados de poupança' };
      return resumoPoupanca(p, [...new Set((p.movimentos || []).map(m => m.mes))]);
    }
    case 'ler_analise': {
      checaMes(args.mes, 'mes');
      const a = await fetchData(`__analise_${args.mes}__`, SUPABASE_URL, SUPABASE_KEY);
      return a ? { mes: a.mes, gerada_em: new Date(a.geradoEm).toISOString(), texto: a.texto } : { mes: args.mes, erro: 'Nenhuma análise gerada para esse mês' };
    }
    case 'treinos_vencimento': {
      const md = await fetchData(monthKey(), SUPABASE_URL, SUPABASE_KEY);
      if (!md) return { erro: 'Mês atual sem dados no app' };
      return treinosVencimento(md, args, { hoje: hojeBR() });
    }
    case 'pendencias': {
      const md = await fetchData(monthKey(), SUPABASE_URL, SUPABASE_KEY);
      if (!md) return { erro: 'Mês atual sem dados no app' };
      const dias = Number.isInteger(args.dias) ? Math.min(Math.max(args.dias, 0), 90) : 7;
      let respostas = null;
      try { respostas = await respostasFormulario(fetch); } catch { /* segue sem as planilhas */ }
      return pendencias(md, { hoje: hojeBR(), dias, respostas });
    }
    default:
      throw new ErroUso(`Ferramenta desconhecida: ${nome}`);
  }
}

// ── JSON-RPC / MCP ────────────────────────────────────────────────────────────

const ok   = (id, result) => ({ jsonrpc: '2.0', id, result });
const erro = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

async function responder(msg) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return msg?.id !== undefined ? erro(msg.id, -32600, 'Requisição inválida') : null;
  }
  if (msg.id === undefined || msg.id === null) return null; // notificação: sem resposta
  const { id, method, params = {} } = msg;
  switch (method) {
    case 'initialize': {
      const pedida = params.protocolVersion;
      return ok(id, {
        protocolVersion: VERSOES.includes(pedida) ? pedida : VERSOES[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'gestor-caldas', title: 'Gestor Caldas', version: '1.5.0' },
        instructions: INSTRUCOES,
      });
    }
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: TOOLS });
    case 'tools/call': {
      try {
        const dados = await executar(params.name, params.arguments || {});
        return ok(id, {
          content: [{ type: 'text', text: JSON.stringify(dados) }],
          structuredContent: dados,
          isError: false,
        });
      } catch (e) {
        const doUsuario = e instanceof ErroUso || e instanceof ErroWhats || e instanceof ErroEscrita;
        if (!doUsuario) console.error('MCP tool error:', e);
        return ok(id, { content: [{ type: 'text', text: doUsuario ? e.message : 'Erro ao acessar os dados' }], isError: true });
      }
    }
    default:
      return erro(id, -32601, `Método não suportado: ${method}`);
  }
}

function chaveValida(req) {
  if (!MCP_CHAVE) return false;
  const auth = req.headers.authorization || '';
  const dada = String(req.query?.chave || (auth.startsWith('Bearer ') ? auth.slice(7) : ''));
  const a = Buffer.from(dada), b = Buffer.from(MCP_CHAVE);
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (!chaveValida(req)) return res.status(401).json({ error: 'Não autorizado' });
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Use POST' });
  }
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json(erro(null, -32700, 'JSON inválido')); }
  }
  if (Array.isArray(body)) {
    const respostas = (await Promise.all(body.map(responder))).filter(Boolean);
    return respostas.length ? res.status(200).json(respostas) : res.status(202).end();
  }
  const resposta = await responder(body);
  return resposta ? res.status(200).json(resposta) : res.status(202).end();
}
