/**
 * Gestor Caldas — "pendências do dia": o que o Thiago precisa fazer hoje, vindo só dos dados do Gestor
 * (mês atual) + vencimentos dos treinos. Só leitura. Follow-up de WhatsApp fica de fora (é do fluxo de acompanhamento).
 */

import { vencimentos } from './_treinos.js';
import { abertos, visao } from './_pedidos.js';

const so = d => String(d || '').replace(/\D/g, '');
const sem = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** Alertas de qualidade dos dados dos alunos. */
export function qualidadeDados(md) {
  const lista = [
    ...(md.personal?.online || []).map(a => ({ a, mod: 'online' })),
    ...(md.personal?.presencial || []).map(a => ({ a, mod: 'presencial' })),
    ...(md.parcerias || []).map(a => ({ a, mod: 'parceria' })),
    ...(md.calistenia || []).map(a => ({ a, mod: 'calistenia' })),
  ].filter(({ a }) => a?.nome && !a.pausado);
  const alertas = [];
  const vistos = {};
  for (const { a, mod } of lista) {
    if (mod !== 'parceria' && !so(a.telefone)) alertas.push({ tipo: 'sem_telefone', aluno: a.nome, modalidade: mod });
    if (/\b(teste|test)\b/.test(sem(a.nome))) alertas.push({ tipo: 'possivel_registro_de_teste', aluno: a.nome, modalidade: mod });
    const k = `${mod}|${sem(a.nome)}`;
    vistos[k] = (vistos[k] || 0) + 1;
    if (vistos[k] === 2) alertas.push({ tipo: 'nome_duplicado', aluno: a.nome, modalidade: mod });
  }
  return alertas;
}

/** Pagamentos do mês ainda em aberto (aluno ativo, pago = false). */
export function pagamentosAbertos(md) {
  const lista = [
    ...(md.personal?.online || []).map(a => ({ a, mod: 'online' })),
    ...(md.personal?.presencial || []).map(a => ({ a, mod: 'presencial' })),
    ...(md.calistenia || []).map(a => ({ a, mod: 'calistenia' })),
  ].filter(({ a }) => a?.nome && !a.pausado && a.pago === false);
  return lista.map(({ a, mod }) => ({ aluno: a.nome, modalidade: mod, valor: a.valorFinal ?? a.valor ?? null, dia_acerto: a.diaAcerto || null }));
}

export function pendencias(md, { hoje, respostas = null, dias = 7, pedidos = [] }) {
  const v = vencimentos(md, { hoje, dias, todos: true, respostas });
  const por = f => v.alunos.filter(f);
  const faltaMontar = por(x => x.formulario.startsWith('respondido'));
  return {
    hoje,
    resumo: 'Cada lista é uma tarefa. "mandar_formulario": enviar o link de atualização. "montar_treino": aluno respondeu, falta montar. "registrar_no_gestor": treino já entregue, mas a data no Gestor está velha. "cobrar_formulario": enviado e sem resposta. "sem_data": definir a próxima atualização. "alteracoes_pedidas": aluno pediu pelo WhatsApp para mudar o treino e ainda não foi atendido.',
    mandar_formulario: por(x => x.mandar_formulario).map(x => ({ aluno: x.nome, modalidade: x.modalidade, situacao: x.situacao })),
    montar_treino: faltaMontar.map(x => ({ aluno: x.nome, modalidade: x.modalidade, resposta_em: x.ultima_resposta_formulario?.data || null })),
    registrar_no_gestor: por(x => x.atualizacao_desatualizada).map(x => ({ aluno: x.nome, ultima_atualizacao: x.ultima_atualizacao, resposta_em: x.ultima_resposta_formulario?.data || null })),
    cobrar_formulario: por(x => x.formulario.endsWith('cobrar')).map(x => ({ aluno: x.nome, formulario: x.formulario })),
    alteracoes_pedidas: abertos(pedidos || []).map(p => { const x = visao(p, hoje); return { id: x.id, aluno: x.aluno, resumo: x.resumo, tipo: x.tipo, urgencia: x.urgencia, dias_esperando: x.dias_esperando }; }),
    sem_data: v.sem_data,
    treinos_pausados: v.treino_pausado,
    pagamentos_em_aberto: pagamentosAbertos(md),
    qualidade_dos_dados: qualidadeDados(md),
    ...(pedidos === null ? { aviso_pedidos: 'Não consegui ler os pedidos de treino' } : {}),
    ...(respostas === null ? { aviso: 'Planilhas de formulário indisponíveis: "montar_treino" e "registrar_no_gestor" podem estar incompletos' } : {}),
  };
}
