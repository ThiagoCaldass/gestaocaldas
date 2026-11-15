/**
 * Gestor Caldas — vencimento dos treinos dos alunos (consultoria online, presencial e parcerias),
 * cruzado com as respostas do formulário nas planilhas do Google. Só leitura.
 */

import { respostasFormulario, mesmaPessoa } from './central.js';

const DIA = 86400000;
const CICLO = 42;     // 6 semanas, igual ao app
const COBRAR = 5;     // formulário enviado sem resposta há N dias → cobrar
const diasEntre = (de, ate) => Math.round((Date.parse(ate) - Date.parse(de)) / DIA);
const so = d => String(d || '').replace(/\D/g, '');

const SIT_FORM = { aguardando: 'enviado, esperando resposta', pendente: 'respondido, falta montar o treino' };

/** Lista dos alunos com a data do treino. Exportada para teste. */
export function vencimentos(md, { hoje, dias = 7, todos = false, respostas = null }) {
  const lista = [
    ...(md.personal?.online || []).map(a => ({ a, modalidade: 'consultoria online' })),
    ...(md.personal?.presencial || []).map(a => ({ a, modalidade: 'presencial' })),
    ...(md.parcerias || []).map(a => ({ a, modalidade: 'parceria' })),
  ].filter(({ a }) => a?.nome && !a.pausado);

  const alunos = lista.map(({ a, modalidade }) => {
    const prox = /^\d{4}-\d{2}-\d{2}$/.test(a.proxAtt || '') ? a.proxAtt : null;
    const faltam = prox ? diasEntre(hoje, prox) : null;
    const fs = a.formStatus && a.formStatus !== 'ok' ? a.formStatus : null;
    const resp = respostas
      ? respostas.filter(r => mesmaPessoa(a, r)).sort((x, y) => String(y.data).localeCompare(String(x.data)))[0] || null
      : undefined;
    // Resposta nova = depois da última atualização do treino (sem essa data: 6 semanas antes do vencimento)
    const ref = /^\d{4}-\d{2}-\d{2}$/.test(a.attTreino || '') ? a.attTreino
      : prox ? new Date(Date.parse(prox) - CICLO * DIA).toISOString().slice(0, 10) : null;
    const respNova = !!(ref && resp?.data && resp.data.slice(0, 10) > ref);
    const enviadoHa = /^\d{4}-\d{2}-\d{2}$/.test(a.formEnviadoEm || '') ? diasEntre(a.formEnviadoEm, hoje) : null;
    const formulario = respNova
      ? (resp.feito ? 'respondido e marcado como Feito na planilha (falta registrar a atualização no Gestor)' : 'respondido (está na planilha), falta montar o treino')
      : fs === 'aguardando' && enviadoHa !== null && enviadoHa >= COBRAR ? `enviado há ${enviadoHa} dia(s), sem resposta — cobrar`
      : fs === 'aguardando' && enviadoHa !== null ? `enviado há ${enviadoHa} dia(s), esperando resposta`
      : SIT_FORM[fs] || 'não enviado';
    return {
      nome: a.nome, modalidade,
      telefone: so(a.telefone) || null,
      ultima_atualizacao: a.attTreino || null,
      proxima_atualizacao: prox,
      dias_para_vencer: faltam,
      situacao: a.treinoPausado ? `treino pausado${a.treinoPausadoEm ? ` desde ${a.treinoPausadoEm}` : ''} (aluno ativo)`
        : faltam === null ? 'sem data de próxima atualização'
        : faltam < 0 ? `venceu há ${-faltam} dia(s)` : faltam === 0 ? 'vence hoje' : `vence em ${faltam} dia(s)`,
      formulario,
      ...(resp !== undefined ? {
        ultima_resposta_formulario: resp ? { data: resp.data?.slice(0, 10) || null, planilha: resp.consultoria, aba: resp.aba, marcada_feito: resp.feito } : null,
      } : {}),
      treino_pausado: !!a.treinoPausado,
      mandar_formulario: !a.treinoPausado && !fs && !respNova && faltam !== null && faltam <= dias,
    };
  });

  const ordem = x => (x.dias_para_vencer ?? -9999);
  const filtrados = (todos ? alunos : alunos.filter(x => !x.treino_pausado && (x.mandar_formulario || x.formulario !== 'não enviado' || x.dias_para_vencer === null)))
    .sort((x, y) => ordem(x) - ordem(y));
  return {
    hoje, janela_dias: dias,
    mandar_formulario: filtrados.filter(x => x.mandar_formulario).map(x => x.nome),
    cobrar_resposta: alunos.filter(x => x.formulario.endsWith('cobrar')).map(x => x.nome),
    sem_data: alunos.filter(x => x.proxima_atualizacao === null && !x.treino_pausado).map(x => x.nome),
    treino_pausado: alunos.filter(x => x.treino_pausado).map(x => x.nome),
    alunos: filtrados,
  };
}

export async function treinosVencimento(md, args, { hoje, fetchFn = fetch }) {
  const dias = Number.isInteger(args.dias) ? Math.min(Math.max(args.dias, 0), 90) : 7;
  let respostas = null, aviso;
  try { respostas = await respostasFormulario(fetchFn); } catch (e) { aviso = `Não consegui ler as planilhas de formulário (${e.message})`; }
  const r = vencimentos(md, { hoje, dias, todos: !!args.todos, respostas });
  return aviso ? { ...r, aviso } : r;
}
