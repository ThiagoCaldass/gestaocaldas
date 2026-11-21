/**
 * Gestor Caldas — ferramentas de ESCRITA nos treinos dos alunos (MCP).
 * Espelham as ações do app (pausarTreino, retomarTreino, attTreino, formEnviado, corrigirProxTreino),
 * sempre no mês atual, com desfazer salvo em __undo_<mês>__ antes de gravar.
 */

import { fetchData, saveUndo, hojeBR, monthKey } from './_tools.js';

const SUPABASE_URL = () => process.env.SUPABASE_URL;
const SUPABASE_KEY = () => process.env.SUPABASE_KEY;
const DIA = 86400000;
const CICLO = 42;
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
const isoMais = (iso, n) => new Date(Date.parse(iso) + n * DIA).toISOString().slice(0, 10);
const diasEntre = (de, ate) => Math.round((Date.parse(ate) - Date.parse(de)) / DIA);
const sem = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

export class ErroEscrita extends Error {}

const GRUPOS = md => [
  ...(md.personal?.online || []).map(a => ({ a, modalidade: 'online' })),
  ...(md.personal?.presencial || []).map(a => ({ a, modalidade: 'presencial' })),
  ...(md.parcerias || []).map(a => ({ a, modalidade: 'parceria' })),
];
const fim8 = t => { const d = String(t || '').replace(/\D/g, ''); return d.length >= 8 ? d.slice(-8) : null; };
const PESO = { presencial: 0, online: 1, parceria: 2 };

/**
 * Acha UM aluno pelo nome (sem acento, trecho). Mesma pessoa em mais de uma modalidade (mesmo telefone):
 * o treino fica na linha presencial; com "modalidade" informada, usa a pedida. Outros casos de 2+ achados: erro.
 */
export function acharAluno(md, nome, modalidade) {
  const q = sem(nome);
  if (!q) throw new ErroEscrita('Informe o nome do aluno');
  let todos = GRUPOS(md).filter(x => x.a?.nome && !x.a.pausado);
  if (modalidade) todos = todos.filter(x => x.modalidade === modalidade);
  const exato = todos.filter(x => sem(x.a.nome) === q);
  const achados = exato.length ? exato : todos.filter(x => sem(x.a.nome).includes(q));
  if (!achados.length) throw new ErroEscrita(`Aluno "${nome}" não encontrado entre os ativos${modalidade ? ` (${modalidade})` : ' (online, presencial, parcerias)'}`);
  if (achados.length > 1) {
    const ks = new Set(achados.map(x => fim8(x.a.telefone)));
    if (ks.size === 1 && [...ks][0]) return achados.sort((x, y) => PESO[x.modalidade] - PESO[y.modalidade])[0].a;   // mesma pessoa
    throw new ErroEscrita(`Mais de um aluno com "${nome}": ${achados.map(x => `${x.a.nome} (${x.modalidade})`).join(', ')}. Use o nome completo ou informe a modalidade`);
  }
  return achados[0].a;
}

export async function salvarMes(key, md) {
  const r = await fetch(`${SUPABASE_URL()}/rest/v1/gestor_data`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY(), Authorization: `Bearer ${SUPABASE_KEY()}`,
      'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({ month_key: key, data: md, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new Error(`Supabase ${r.status} ao salvar`);
}

const checaData = (v, campo) => {
  if (!RE_DATA.test(v || '') || Number.isNaN(Date.parse(v))) throw new ErroEscrita(`"${campo}" deve estar no formato YYYY-MM-DD`);
};

/** Aplica a ação no aluno (em memória). Retorna { antes, depois, resumo }. Exportada para teste. */
export function aplicar(acao, a, args, hoje) {
  const antes = { treinoPausado: !!a.treinoPausado, treinoPausadoEm: a.treinoPausadoEm || null, attTreino: a.attTreino || null, proxAtt: a.proxAtt || null, formStatus: a.formStatus || 'ok', formEnviadoEm: a.formEnviadoEm || null };
  let resumo;
  switch (acao) {
    case 'treino_pausar':
      if (a.treinoPausado) throw new ErroEscrita(`Treino de ${a.nome} já está pausado desde ${a.treinoPausadoEm || '?'}`);
      a.treinoPausado = true; a.treinoPausadoEm = hoje;
      resumo = `Treino de ${a.nome} pausado (aluno continua ativo)`;
      break;
    case 'treino_retomar': {
      if (!a.treinoPausado) throw new ErroEscrita(`Treino de ${a.nome} não está pausado`);
      const parado = a.treinoPausadoEm ? Math.max(0, diasEntre(a.treinoPausadoEm, hoje)) : 0;
      if (a.proxAtt && parado) a.proxAtt = isoMais(a.proxAtt, parado);   // igual ao app: empurra o vencimento
      a.treinoPausado = false; a.treinoPausadoEm = null;
      resumo = `Treino de ${a.nome} retomado${a.proxAtt ? `, próxima atualização ${a.proxAtt}` : ''}`;
      break;
    }
    case 'treino_registrar_entrega': {
      const ent = args.entrega || hoje;
      checaData(ent, 'entrega');
      const prox = args.proxima_atualizacao || isoMais(ent, CICLO);
      checaData(prox, 'proxima_atualizacao');
      if (prox <= ent) throw new ErroEscrita('A próxima atualização tem que ser depois da entrega');
      if (a.prorrogacoes?.length) { a.prorrogacoesAnteriores = [...(a.prorrogacoesAnteriores || []), ...a.prorrogacoes]; a.prorrogacoes = []; }   // novo ciclo: zera a contagem, guarda o histórico
      Object.assign(a, { attTreino: ent, proxAtt: prox, formStatus: 'ok', formEnviadoEm: null, treinoPausado: false, treinoPausadoEm: null });
      resumo = `Entrega de ${a.nome} registrada em ${ent}; próxima atualização ${prox}`;
      break;
    }
    case 'treino_formulario_enviado':
      a.formStatus = 'aguardando'; a.formEnviadoEm = args.enviado_em || hoje;
      if (args.enviado_em) checaData(args.enviado_em, 'enviado_em');
      resumo = `Formulário de ${a.nome} marcado como enviado em ${a.formEnviadoEm}`;
      break;
    case 'treino_prorrogar': {
      const motivo = String(args.motivo || '').trim();
      if (!motivo) throw new ErroEscrita('Informe o "motivo" da prorrogação (ex.: treinou 6 de 18 sessões)');
      if (!a.proxAtt || !RE_DATA.test(a.proxAtt)) throw new ErroEscrita(`${a.nome} está sem data de próxima atualização; use treino_corrigir_data primeiro`);
      if (a.treinoPausado) throw new ErroEscrita(`Treino de ${a.nome} está pausado; retome antes de prorrogar`);
      let nova;
      if (args.nova_data) { checaData(args.nova_data, 'nova_data'); nova = args.nova_data; }
      else {
        const d = Number(args.dias);
        if (!Number.isInteger(d) || d < 1 || d > 90) throw new ErroEscrita('Informe "dias" (1 a 90) ou "nova_data"');
        nova = isoMais(a.proxAtt, d);
      }
      if (nova <= a.proxAtt) throw new ErroEscrita(`A nova data (${nova}) precisa ser depois da atual (${a.proxAtt})`);
      (a.prorrogacoes = a.prorrogacoes || []).push({ em: hoje, de: a.proxAtt, para: nova, motivo });
      a.proxAtt = nova;
      resumo = `Treino de ${a.nome} prorrogado: ${antes.proxAtt} → ${nova} (${a.prorrogacoes.length}ª prorrogação). Motivo: ${motivo}`
        + (a.prorrogacoes.length >= 2 ? '. ATENÇÃO: segunda prorrogação seguida, vale checar se o treino está difícil de encaixar' : '');
      break;
    }
    case 'treino_corrigir_data': {
      checaData(args.proxima_atualizacao, 'proxima_atualizacao');
      a.proxAtt = args.proxima_atualizacao;
      resumo = `Próxima atualização de ${a.nome}: ${antes.proxAtt || 'sem data'} → ${a.proxAtt}`;
      break;
    }
    default:
      throw new ErroEscrita(`Ação desconhecida: ${acao}`);
  }
  const depois = { treinoPausado: !!a.treinoPausado, treinoPausadoEm: a.treinoPausadoEm || null, attTreino: a.attTreino || null, proxAtt: a.proxAtt || null, formStatus: a.formStatus || 'ok', formEnviadoEm: a.formEnviadoEm || null };
  return { antes, depois, resumo };
}

export async function escreverTreino(acao, args) {
  const key = monthKey();
  const md = await fetchData(key, SUPABASE_URL(), SUPABASE_KEY());
  if (!md) throw new ErroEscrita('Mês atual sem dados no app');
  const a = acharAluno(md, args.nome, args.modalidade);
  const r = aplicar(acao, a, args, hojeBR());
  await saveUndo(key, JSON.parse(JSON.stringify(md)), SUPABASE_URL(), SUPABASE_KEY()).catch(() => {});
  await salvarMes(key, md);
  return { ok: true, mes: key, aluno: a.nome, ...r };
}

const nomeProp = { type: 'string', description: 'Nome do aluno (nome completo ou trecho único)' };
const modProp = { type: 'string', enum: ['online', 'presencial', 'parceria'], description: 'Opcional. Quem está em duas modalidades com o mesmo telefone tem o treino na linha presencial (padrão); use só para forçar outra' };
const dataProp = d => ({ type: 'string', description: d });

export const ESCRITA_TOOLS = [
  { name: 'treino_pausar', title: 'Pausar treino',
    description: 'Pausa o treino do aluno (ele continua ativo no Gestor e sai das listas de vencimento). Mesma ação do botão "Pausar" do app.',
    inputSchema: { type: 'object', properties: { nome: nomeProp, modalidade: modProp }, required: ['nome'], additionalProperties: false } },
  { name: 'treino_retomar', title: 'Retomar treino',
    description: 'Retoma o treino pausado e empurra a próxima atualização pelos dias em que ficou pausado (igual ao app).',
    inputSchema: { type: 'object', properties: { nome: nomeProp, modalidade: modProp }, required: ['nome'], additionalProperties: false } },
  { name: 'treino_registrar_entrega', title: 'Registrar entrega do treino',
    description: 'Registra que o treino novo foi entregue: atualiza a última e a próxima atualização (padrão 42 dias depois), zera o status do formulário e despausa. Não marca "Feito" na planilha do Google.',
    inputSchema: { type: 'object', properties: { nome: nomeProp, modalidade: modProp, entrega: dataProp('Data da entrega YYYY-MM-DD (padrão: hoje)'), proxima_atualizacao: dataProp('Próxima atualização YYYY-MM-DD (padrão: entrega + 42 dias)') }, required: ['nome'], additionalProperties: false } },
  { name: 'treino_formulario_enviado', title: 'Marcar formulário enviado',
    description: 'Marca no Gestor que o formulário de atualização foi enviado ao aluno (status "aguardando resposta").',
    inputSchema: { type: 'object', properties: { nome: nomeProp, modalidade: modProp, enviado_em: dataProp('YYYY-MM-DD (padrão: hoje)') }, required: ['nome'], additionalProperties: false } },
  { name: 'treino_prorrogar', title: 'Prorrogar treino',
    description: 'Prorroga a próxima atualização de um aluno que treinou pouco e ainda não precisa trocar o treino. Exige o motivo e o registra no histórico do aluno (conta quantas prorrogações já houve). Passe "dias" a somar à data atual ou "nova_data". Diferente de pausar: o aluno continua no fluxo normal.',
    inputSchema: { type: 'object', properties: { nome: nomeProp, modalidade: modProp, dias: { type: 'integer', minimum: 1, maximum: 90, description: 'Dias a somar à próxima atualização atual' }, nova_data: dataProp('Alternativa a "dias": nova data YYYY-MM-DD'), motivo: { type: 'string', description: 'Por que prorrogar (ex.: treinou 6 de 18 sessões)' } }, required: ['nome', 'motivo'], additionalProperties: false } },
  { name: 'treino_corrigir_data', title: 'Corrigir próxima atualização',
    description: 'Corrige só a data da próxima atualização do treino do aluno.',
    inputSchema: { type: 'object', properties: { nome: nomeProp, modalidade: modProp, proxima_atualizacao: dataProp('YYYY-MM-DD') }, required: ['nome', 'proxima_atualizacao'], additionalProperties: false } },
].map(t => ({ ...t, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } }));

export const ESCRITA_NOMES = new Set(ESCRITA_TOOLS.map(t => t.name));
