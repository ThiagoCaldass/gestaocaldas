/**
 * Gestor Caldas — Resumo financeiro compacto de um mês (entrada do assistente financeiro)
 */

const CATS_ESPELHO = ['calistenia', 'personal', 'personal_online', 'personal_presencial'];

const r2 = v => Math.round((Number(v) || 0) * 100) / 100;
const soma = (arr, f = x => x.valor) => r2((arr || []).reduce((s, x) => s + (Number(f(x)) || 0), 0));

// Data local de Brasília (UTC-3) em DD/MM
function diaBR(ts) {
  if (!ts) return null;
  const d = new Date(ts - 3 * 3600 * 1000);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function resumoAlunos(lista, valorDe) {
  const ativos = (lista || []).filter(a => !a.pausado);
  const pagos = ativos.filter(a => a.pago);
  return {
    ativos: ativos.length,
    pausados: (lista || []).length - ativos.length,
    previsto: soma(ativos, valorDe),
    recebido: soma(pagos, valorDe),
    recebido_conta_empresarial: soma(pagos.filter(a => a.contaPgto === 'emp'), valorDe),
    pendentes: ativos.filter(a => !a.pago).map(a => ({ nome: a.nome, valor: r2(valorDe(a)), dia: a.diaAcerto || null })),
  };
}

function resumoCartao(c) {
  if (!c) return null;
  const parc = c.parceladas || [], av = c.avista || [], ass = (c.assinaturas || []).filter(a => !a.pausada);
  return {
    total_mes: r2(soma(parc) + soma(av) + soma(ass)),
    parceladas: parc.map(p => ({ item: p.titulo, parcela: r2(p.valor), parcelas: p.parcelas, ate: p.ateQuando })),
    assinaturas: ass.map(a => ({ item: a.titulo || a.nome, valor: r2(a.valor) })),
    a_vista: { total: soma(av), compras: av.length, maiores: [...av].sort((a, b) => b.valor - a.valor).slice(0, 8).map(a => ({ item: a.titulo, valor: r2(a.valor) })) },
  };
}

/** Resumo detalhado (mês analisado) */
export function resumoDetalhado(md) {
  const b = md.balanco || { ganhos: [], gastos: [] };
  const ganhosOutros = (b.ganhos || []).filter(g => !CATS_ESPELHO.includes((g.categoria || 'avulso').toLowerCase()));
  const gastos = b.gastos || [];
  const valorCali = a => a.valorFinal ?? a.valorBase ?? a.valor ?? 0;
  const valorPers = a => a.valor || 0;
  const emp = md.contaEmp || { saidas: [], retiradas: [] };
  return {
    alunos: {
      calistenia: resumoAlunos(md.calistenia, valorCali),
      personal_online: resumoAlunos(md.personal?.online, valorPers),
      personal_presencial: resumoAlunos(md.personal?.presencial, valorPers),
    },
    outros_ganhos: ganhosOutros.map(g => ({
      nome: g.nome, valor: r2(g.valor), tipo: g.categoria === 'retirada_emp' ? 'retirada da conta empresarial' : (g.categoria || 'avulso'),
      recebido: !!g.recebido, data: g.recebido ? diaBR(g.ts) : null,
    })),
    gastos_pessoais: gastos.map(g => ({
      nome: g.nome, valor: r2(g.valor), pago: !!g.pago, fixo_mensal: !!g.persistente,
      vence_dia: g.diaVencimento || null, pago_em: g.pago ? diaBR(g.ts) : null,
      somas_no_mes: (g.historico || []).filter(h => h.tipo === 'soma' && h.delta > 0).length || undefined,
    })),
    totais_pessoal: {
      gastos_total: soma(gastos), gastos_pagos: soma(gastos.filter(g => g.pago)),
      gastos_fixos: soma(gastos.filter(g => g.persistente)),
      ganhos_recebidos: soma((b.ganhos || []).filter(g => g.recebido)),
    },
    cartoes: { bb: resumoCartao(md.cartao?.bb), inter: resumoCartao(md.cartao?.inter), empresarial: resumoCartao(md.cartao?.emp) },
    conta_empresarial: {
      saidas: (emp.saidas || []).map(s => ({ nome: s.desc, valor: r2(s.valor), pago: !!s.pago, fixo_mensal: !!s.persistente })),
      retiradas_total: soma(emp.retiradas),
    },
  };
}

/** Resumo curto (meses anteriores, para comparação) */
export function resumoCurto(md) {
  const d = resumoDetalhado(md);
  const al = d.alunos;
  const maiores = [...d.gastos_pessoais].sort((a, b) => b.valor - a.valor).slice(0, 12).map(g => ({ nome: g.nome, valor: g.valor }));
  return {
    alunos_ativos: al.calistenia.ativos + al.personal_online.ativos + al.personal_presencial.ativos,
    receita_alunos_prevista: r2(al.calistenia.previsto + al.personal_online.previsto + al.personal_presencial.previsto),
    receita_alunos_recebida: r2(al.calistenia.recebido + al.personal_online.recebido + al.personal_presencial.recebido),
    outros_ganhos: soma(d.outros_ganhos),
    gastos_pessoais_total: d.totais_pessoal.gastos_total,
    gastos_fixos: d.totais_pessoal.gastos_fixos,
    maiores_gastos: maiores,
    cartoes_total: r2((d.cartoes.bb?.total_mes || 0) + (d.cartoes.inter?.total_mes || 0)),
    saidas_empresariais: soma(d.conta_empresarial.saidas),
  };
}

/** Resumo da poupança: saldo atual e movimentos dos meses informados */
export function resumoPoupanca(p, meses) {
  if (!p) return null;
  const movs = (p.movimentos || []).filter(m => meses.includes(m.mes));
  return {
    saldo_atual: r2(p.saldo), meta_mensal: r2(p.metaMensal),
    movimentos: movs.map(m => ({ mes: m.mes, tipo: m.tipo, valor: r2(m.valor), desc: m.desc })),
  };
}
