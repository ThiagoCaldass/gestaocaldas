/**
 * Gestor Caldas — completa a ficha do aluno (telefone, e-mail, data de nascimento) pelo MCP.
 * "Completar" = só preenche o que está vazio. Valor diferente do que já existe NÃO é trocado
 * (vira "conflito" na resposta), a não ser com sobrescrever: true. Sempre no mês atual,
 * com desfazer salvo em __undo_<mês>__ antes de gravar (igual às ferramentas de treino).
 */

import { fetchData, saveUndo, monthKey } from './_tools.js';
import { salvarMes, ErroEscrita } from './_escrita.js';

const SUPABASE_URL = () => process.env.SUPABASE_URL;
const SUPABASE_KEY = () => process.env.SUPABASE_KEY;
const CAMPOS = ['telefone', 'email', 'nascimento'];
const sem = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const digitos = v => String(v || '').replace(/\D/g, '');
const fim8 = v => { const d = digitos(v); return d.length >= 8 ? d.slice(-8) : null; };

const GRUPOS = md => [
  ...(md.calistenia || []).map(a => ({ a, modalidade: 'calistenia' })),
  ...(md.personal?.online || []).map(a => ({ a, modalidade: 'online' })),
  ...(md.personal?.presencial || []).map(a => ({ a, modalidade: 'presencial' })),
  ...(md.parcerias || []).map(a => ({ a, modalidade: 'parceria' })),
];

/**
 * Acha as linhas do aluno pelo nome (sem acento, trecho). A mesma pessoa em mais de uma modalidade
 * (mesmo nome completo e telefones que não se contradizem) recebe os dados em todas as linhas.
 * Nomes diferentes ou telefones diferentes: erro pedindo o nome completo ou a modalidade.
 */
export function acharLinhas(md, nome, modalidade) {
  const q = sem(nome);
  if (!q) throw new ErroEscrita('Informe o nome do aluno');
  let todos = GRUPOS(md).filter(x => x.a?.nome);
  if (modalidade) todos = todos.filter(x => x.modalidade === modalidade);
  const exato = todos.filter(x => sem(x.a.nome) === q);
  const achados = exato.length ? exato : todos.filter(x => sem(x.a.nome).includes(q));
  if (!achados.length) throw new ErroEscrita(`Aluno "${nome}" não encontrado${modalidade ? ` (${modalidade})` : ' (calistenia, online, presencial, parcerias)'}`);
  const lista = () => achados.map(x => `${x.a.nome} (${x.modalidade})`).join(', ');
  if (new Set(achados.map(x => sem(x.a.nome))).size > 1) throw new ErroEscrita(`Mais de um aluno com "${nome}": ${lista()}. Use o nome completo ou informe a modalidade`);
  const fones = new Set(achados.map(x => fim8(x.a.telefone)).filter(Boolean));
  if (fones.size > 1) throw new ErroEscrita(`"${achados[0].a.nome}" aparece com telefones diferentes: ${lista()}. Informe a modalidade`);
  return achados;
}

function normalizar(campo, bruto) {
  const v = String(bruto).trim();
  if (campo === 'telefone') {
    let d = digitos(v);
    if (d.length === 10 || d.length === 11) d = '55' + d;   // mesmo formato que o app grava ao completar pelo MarcFlow
    if (d.length < 12 || d.length > 13) throw new ErroEscrita(`Telefone inválido: "${v}". Use DDD + número (ex.: 14999998888)`);
    return d;
  }
  if (campo === 'email') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new ErroEscrita(`E-mail inválido: "${v}"`);
    return v.toLowerCase();
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v)) || new Date(Date.parse(v)).toISOString().slice(0, 10) !== v) throw new ErroEscrita('"nascimento" deve estar no formato YYYY-MM-DD (data real)');
  if (v < '1920-01-01' || v > new Date().toISOString().slice(0, 10)) throw new ErroEscrita(`Data de nascimento fora do esperado: ${v}`);
  return v;
}

const igual = (campo, a, b) => campo === 'telefone' ? fim8(a) === fim8(b) : sem(a) === sem(b);

/** Aplica os dados nas linhas (em memória). Exportada para teste. */
export function aplicarDados(linhas, args) {
  const novos = {};
  for (const c of CAMPOS) if (args[c] != null && String(args[c]).trim() !== '') novos[c] = normalizar(c, args[c]);
  if (!Object.keys(novos).length) throw new ErroEscrita('Informe ao menos um dado: telefone, email ou nascimento');
  const sobrescrever = args.sobrescrever === true;
  const mudancas = [], conflitos = [], ja_tinha = [];
  for (const { a, modalidade } of linhas) {
    for (const [campo, novo] of Object.entries(novos)) {
      const atual = String(a[campo] || '').trim();
      if (!atual || (sobrescrever && !igual(campo, atual, novo))) {
        a[campo] = novo;
        mudancas.push({ aluno: a.nome, modalidade, campo, de: atual || null, para: novo });
      } else if (igual(campo, atual, novo)) ja_tinha.push({ aluno: a.nome, modalidade, campo });
      else conflitos.push({ aluno: a.nome, modalidade, campo, no_gestor: atual, informado: novo });
    }
  }
  const faltando = linhas.map(({ a, modalidade }) => ({ aluno: a.nome, modalidade, faltando: CAMPOS.filter(c => !String(a[c] || '').trim()) }));
  const partes = [];
  if (mudancas.length) partes.push(`${mudancas.length} campo(s) preenchido(s)`);
  if (conflitos.length) partes.push(`${conflitos.length} diferente(s) do que já está no Gestor (não troquei; use sobrescrever: true se for para trocar)`);
  if (!mudancas.length && !conflitos.length) partes.push('nada a completar, o Gestor já tinha esses dados');
  return { mudancas, conflitos, ja_tinha, faltando, resumo: `${linhas[0].a.nome}: ${partes.join('; ')}` };
}

export async function completarDadosAluno(args) {
  const key = monthKey();
  const md = await fetchData(key, SUPABASE_URL(), SUPABASE_KEY());
  if (!md) throw new ErroEscrita('Mês atual sem dados no app');
  const linhas = acharLinhas(md, args.nome, args.modalidade);
  const antes = JSON.parse(JSON.stringify(md));
  const r = aplicarDados(linhas, args);
  if (r.mudancas.length) {
    await saveUndo(key, antes, SUPABASE_URL(), SUPABASE_KEY()).catch(() => {});
    await salvarMes(key, md);
  }
  return { ok: true, mes: key, gravou: r.mudancas.length > 0, ...r };
}

export const ALUNOS_TOOLS = [
  { name: 'aluno_completar_dados', title: 'Completar dados do aluno',
    description: 'Completa a ficha de um aluno do Gestor com telefone, e-mail e/ou data de nascimento, no mês atual. Só preenche o que está vazio: se o Gestor já tem outro valor, NÃO troca e devolve em "conflitos" (use sobrescrever: true só se o Thiago mandar trocar). Achando o aluno em mais de uma modalidade (mesma pessoa), preenche todas as linhas. A resposta traz o que mudou e o que ainda falta na ficha. Não cria aluno (para isso, fin_novo_aluno). Confirme com o Thiago antes de gravar; desfazer_ultima_alteracao volta.',
    inputSchema: { type: 'object', properties: {
      nome: { type: 'string', description: 'Nome do aluno (nome completo ou trecho único)' },
      modalidade: { type: 'string', enum: ['calistenia', 'online', 'presencial', 'parceria'], description: 'Opcional. Só para desempatar quando há mais de um aluno com o nome' },
      telefone: { type: 'string', description: 'DDD + número, com ou sem 55 (ex.: 14999998888)' },
      email: { type: 'string', description: 'E-mail do aluno' },
      nascimento: { type: 'string', description: 'Data de nascimento YYYY-MM-DD' },
      sobrescrever: { type: 'boolean', description: 'Troca também valores já preenchidos e diferentes. Padrão: falso' },
    }, required: ['nome'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
];

export const ALUNOS_NOMES = new Set(ALUNOS_TOOLS.map(t => t.name));
