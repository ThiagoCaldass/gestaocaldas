/**
 * Gestor Caldas — "pendências do dia": o que o Thiago precisa fazer hoje, vindo só dos dados do Gestor
 * (mês atual) + vencimentos dos treinos. Só leitura. Follow-up de WhatsApp fica de fora (é do fluxo de acompanhamento).
 */

import { vencimentos } from './_treinos.js';

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
  const primeiros = {};
  for (const { a, mod } of lista) {
    if (mod !== 'parceria' && !so(a.telefone)) alertas.push({ tipo: 'sem_telefone', aluno: a.nome, modalidade: mod });
    if (/\b(teste|test)\b/.test(sem(a.nome))) alertas.push({ tipo: 'possivel_registro_de_teste', aluno: a.nome, modalidade: mod });
    const k = sem(a.nome).split(/\s+/)[0];
    (primeiros[k] = primeiros[k] || []).push(a.nome);
  }
  for (const nomes of Object.values(primeiros)) {
    const unicos = [...new Set(nomes)];
    if (nomes.length > unicos.length) alertas.push({ tipo: 'nome_duplicado', alunos: unicos });
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

export function pendencias(md, { hoje, respostas = null, dias = 7 }) {
  const v = vencimentos(md, { hoje, dias, todos: true, respostas });
  const por = f => v.alunos.filter(f);
  const faltaMontar = por(x => x.formulario.startsWith('respondido'));
  return {
    hoje,
    resumo: 'Cada lista é uma tarefa. "mandar_formulario": enviar o link de atualização. "montar_treino": aluno respondeu, falta montar. "registrar_no_gestor": treino já entregue, mas a data no Gestor está velha. "cobrar_formulario": enviado e sem resposta. "sem_data": definir a próxima atualização.',
    mandar_formulario: por(x => x.mandar_formulario).map(x => ({ aluno: x.nome, modalidade: x.modalidade, situacao: x.situacao })),
    montar_treino: faltaMontar.map(x => ({ aluno: x.nome, modalidade: x.modalidade, resposta_em: x.ultima_resposta_formulario?.data || null })),
    registrar_no_gestor: por(x => x.atualizacao_desatualizada).map(x => ({ aluno: x.nome, ultima_atualizacao: x.ultima_atualizacao, resposta_em: x.ultima_resposta_formulario?.data || null })),
    cobrar_formulario: por(x => x.formulario.endsWith('cobrar')).map(x => ({ aluno: x.nome, formulario: x.formulario })),
    sem_data: v.sem_data,
    treinos_pausados: v.treino_pausado,
    pagamentos_em_aberto: pagamentosAbertos(md),
    qualidade_dos_dados: qualidadeDados(md),
    ...(respostas === null ? { aviso: 'Planilhas de formulário indisponíveis: "montar_treino" e "registrar_no_gestor" podem estar incompletos' } : {}),
  };
}
