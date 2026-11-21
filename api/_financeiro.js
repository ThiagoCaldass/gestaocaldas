/**
 * Gestor Caldas — ferramentas de ESCRITA financeira (MCP): gastos, ganhos, pagamento de alunos,
 * presença, novo aluno, cartão, correção e remoção. Mês atual por padrão (ou "mes" YYYY-MM já existente).
 * Cada gravação guarda o estado anterior em __undo_<mês>__ (desfazer_ultima_alteracao volta a última).
 */

import { fetchData, loadUndo, saveUndo, hojeBR, monthKey, uid, emptyMonth } from './_tools.js';
import { salvarMes, ErroEscrita } from './_escrita.js';

const U = () => process.env.SUPABASE_URL, K = () => process.env.SUPABASE_KEY;
const sem = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const r2 = n => Math.round(n * 100) / 100;
const RE_MES = /^\d{4}-\d{2}$/;
const brl = n => `R$ ${Number(n).toFixed(2).replace('.', ',')}`;

function valorOk(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new ErroEscrita('"valor" deve ser um número maior que zero');
  return r2(n);
}

/** Acha 1 item pelo nome: exato primeiro, depois trecho. 0 ou 2+ → erro listando. */
export function achar(lista, nome, rotulo) {
  const q = sem(nome);
  if (!q) throw new ErroEscrita(`Informe o nome do ${rotulo}`);
  const exato = lista.filter(x => sem(x.nome) === q);
  const ach = exato.length ? exato : lista.filter(x => sem(x.nome).includes(q));
  if (!ach.length) throw new ErroEscrita(`${rotulo} "${nome}" não encontrado. Existentes: ${lista.map(x => x.nome).join(', ') || 'nenhum'}`);
  if (ach.length > 1) throw new ErroEscrita(`Mais de um ${rotulo} com "${nome}": ${ach.map(x => `${x.nome} (${brl(x.valor)})`).join('; ')}. Use o nome exato`);
  return ach[0];
}

const alunosDe = md => [
  ...(md.calistenia || []).map(a => ({ a, tipo: 'calistenia' })),
  ...(md.personal?.online || []).map(a => ({ a, tipo: 'online' })),
  ...(md.personal?.presencial || []).map(a => ({ a, tipo: 'presencial' })),
];
function acharAlunoFin(md, nome) {
  const lista = alunosDe(md).map(x => ({ ...x, nome: x.a.nome, valor: x.a.valorFinal ?? x.a.valor }));
  const x = achar(lista, nome, 'aluno');
  return x;
}

/** Aplica a ação no mês (em memória). Exportada para teste. */
export function aplicarFin(acao, md, args, hoje) {
  md.balanco = md.balanco || { ganhos: [], gastos: [] };
  const b = md.balanco;
  switch (acao) {
    case 'fin_registrar_gasto': case 'fin_registrar_ganho': {
      const gasto = acao === 'fin_registrar_gasto';
      const lista = gasto ? b.gastos : b.ganhos, flag = gasto ? 'pago' : 'recebido';
      const valor = valorOk(args.valor);
      const q = sem(args.nome);
      if (!q) throw new ErroEscrita('Informe o nome');
      const exato = lista.find(x => sem(x.nome) === q);
      const parecidos = lista.filter(x => sem(x.nome).includes(q) || q.includes(sem(x.nome)));
      const feito = args[flag];
      if (exato && args.somar_ao_existente !== false) {
        const antes = exato.valor;
        exato.valor = r2(antes + valor);
        if (feito === true && !exato[flag]) exato.ts = Date.now();
        if (feito !== undefined) exato[flag] = !!feito;
        (exato.historico = exato.historico || []).push({ delta: valor, ts: Date.now(), tipo: 'soma' });
        return `${exato.nome}: ${brl(antes)} → ${brl(exato.valor)} (+${brl(valor)})`;
      }
      if (!exato && parecidos.length && !args.criar_novo)
        throw new ErroEscrita(`Já existe algo parecido: ${parecidos.map(x => `"${x.nome}" ${brl(x.valor)}`).join('; ')}. Para somar nele, use o nome exato; para criar um item separado, passe criar_novo=true`);
      const item = { id: uid(), nome: args.nome, valor, categoria: args.categoria || (gasto ? 'outros' : 'avulso'), [flag]: !!feito, ...(gasto ? { persistente: false } : {}), ts: Date.now(), historico: [] };
      lista.push(item);
      return `${gasto ? 'Gasto' : 'Ganho'} criado: ${item.nome} ${brl(valor)} (${item[flag] ? (gasto ? 'pago' : 'recebido') : 'pendente'})`;
    }
    case 'fin_marcar_gasto_pago': case 'fin_marcar_ganho_recebido': {
      const gasto = acao === 'fin_marcar_gasto_pago';
      const flag = gasto ? 'pago' : 'recebido';
      const it = achar(gasto ? b.gastos : b.ganhos, args.nome, gasto ? 'gasto' : 'ganho');
      const v = args[flag] !== false;
      if (v && !it[flag]) it.ts = Date.now();
      it[flag] = v;
      return `${it.nome} (${brl(it.valor)}) marcado como ${v ? (gasto ? 'pago' : 'recebido') : 'pendente'}`;
    }
    case 'fin_aluno_pago': {
      const { a, tipo } = acharAlunoFin(md, args.nome);
      a.pago = args.pago !== false;
      return `${a.nome} (${tipo}) marcado como ${a.pago ? 'pago' : 'não pago'}`;
    }
    case 'fin_presenca': {
      const a = achar(md.personal?.presencial || [], args.nome, 'aluno presencial');
      const dia = args.data || hoje;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) throw new ErroEscrita('"data" deve ser YYYY-MM-DD');
      a.aulasDatas = a.aulasDatas || [];
      if (a.aulasDatas.includes(dia)) throw new ErroEscrita(`${a.nome} já tem presença em ${dia}`);
      a.aulasDatas.push(dia);
      return `Presença de ${a.nome} em ${dia} (${a.aulasDatas.length} aulas no mês)`;
    }
    case 'fin_novo_aluno': {
      const valor = valorOk(args.valor), tipo = args.tipo;
      if (!['calistenia', 'online', 'presencial'].includes(tipo)) throw new ErroEscrita('"tipo" deve ser calistenia, online ou presencial');
      if (alunosDe(md).some(x => sem(x.a.nome) === sem(args.nome))) throw new ErroEscrita(`Já existe aluno "${args.nome}" neste mês`);
      md.personal = md.personal || { online: [], presencial: [] };
      md.calistenia = md.calistenia || [];
      const base = { id: uid(), nome: args.nome, valor, pago: false, pausado: false };
      if (tipo === 'calistenia') md.calistenia.push({ ...base, valorBase: valor, valorFinal: valor, familiaId: null, familiaDesconto: 0 });
      else if (tipo === 'online') md.personal.online.push({ ...base, diaAcerto: '', attTreino: '', obs: '', valorAula: 0 });
      else md.personal.presencial.push({ ...base, diaAcerto: '', attTreino: '', obs: '', valorAula: 0, aulasDatas: [] });
      return `Novo aluno ${args.nome} (${tipo}) ${brl(valor)}/mês. Telefone e dia de acerto ficam para preencher no app`;
    }
    case 'fin_cartao_compra': {
      const valor = valorOk(args.valor), bank = args.cartao;
      if (!['bb', 'inter'].includes(bank)) throw new ErroEscrita('"cartao" deve ser bb ou inter');
      md.cartao = md.cartao || emptyMonth().cartao;
      md.cartao[bank] = md.cartao[bank] || { fechamento: null, parceladas: [], avista: [], assinaturas: [] };
      const n = Math.round(Number(args.parcelas) || 1);
      if (n <= 1) { md.cartao[bank].avista.push({ id: uid(), titulo: args.titulo, valor, data: hoje }); return `Compra à vista no ${bank.toUpperCase()}: ${args.titulo} ${brl(valor)}`; }
      const [y, m] = hoje.split('-').map(Number); const fim = new Date(Date.UTC(y, m - 1 + n - 1, 1));
      const ate = `${fim.getUTCFullYear()}-${String(fim.getUTCMonth() + 1).padStart(2, '0')}`;
      md.cartao[bank].parceladas.push({ id: uid(), titulo: args.titulo, valor, parcelas: n, ateQuando: ate, data: hoje });
      return `Parcelado no ${bank.toUpperCase()}: ${args.titulo} ${n}x ${brl(valor)} (até ${ate}). "valor" é o de CADA parcela`;
    }
    case 'fin_corrigir_valor': {
      const valor = valorOk(args.valor);
      if (args.tipo === 'aluno') {
        const { a } = acharAlunoFin(md, args.nome); const antes = a.valorFinal ?? a.valor;
        a.valor = valor; if ('valorFinal' in a) a.valorFinal = valor; if ('valorBase' in a) a.valorBase = valor;
        return `Valor de ${a.nome}: ${brl(antes)} → ${brl(valor)}`;
      }
      if (!['gasto', 'ganho'].includes(args.tipo)) throw new ErroEscrita('"tipo" deve ser gasto, ganho ou aluno');
      const it = achar(args.tipo === 'gasto' ? b.gastos : b.ganhos, args.nome, args.tipo);
      const antes = it.valor; it.valor = valor;
      (it.historico = it.historico || []).push({ delta: r2(valor - antes), ts: Date.now(), tipo: 'correcao' });
      return `${it.nome}: ${brl(antes)} → ${brl(valor)} (correção)`;
    }
    case 'fin_remover': {
      if (!['gasto', 'ganho'].includes(args.tipo)) throw new ErroEscrita('"tipo" deve ser gasto ou ganho');
      const lista = args.tipo === 'gasto' ? b.gastos : b.ganhos;
      const it = achar(lista, args.nome, args.tipo);
      lista.splice(lista.indexOf(it), 1);
      return `${args.tipo === 'gasto' ? 'Gasto' : 'Ganho'} removido: ${it.nome} ${brl(it.valor)}. Dá para voltar com desfazer_ultima_alteracao`;
    }
    default: throw new ErroEscrita(`Ação desconhecida: ${acao}`);
  }
}

async function carregar(mes) {
  const key = mes || monthKey();
  if (!RE_MES.test(key)) throw new ErroEscrita('"mes" deve estar no formato YYYY-MM');
  const md = await fetchData(key, U(), K());
  if (!md) throw new ErroEscrita(`Mês ${key} sem dados no app (não crio meses por aqui)`);
  return { key, md };
}

export async function escreverFin(acao, args) {
  const { key, md } = await carregar(args.mes);
  const resumo = aplicarFin(acao, md, args, hojeBR());
  await saveUndo(key, JSON.parse(JSON.stringify(await fetchData(key, U(), K()))), U(), K()).catch(() => {});
  await salvarMes(key, md);
  return { ok: true, mes: key, resumo };
}

export async function desfazer(args) {
  const key = args.mes || monthKey();
  if (!RE_MES.test(key)) throw new ErroEscrita('"mes" deve estar no formato YYYY-MM');
  const anterior = await loadUndo(key, U(), K());
  if (!anterior) throw new ErroEscrita(`Nada para desfazer em ${key}`);
  const atual = await fetchData(key, U(), K());
  await saveUndo(key, atual, U(), K());              // desfazer de novo = refazer
  await salvarMes(key, anterior);
  return { ok: true, mes: key, resumo: 'Última alteração desfeita (chamar de novo refaz)' };
}

const mes = { type: 'string', description: 'Mês YYYY-MM (padrão: mês atual; precisa já existir)' };
const nome = d => ({ type: 'string', description: d });
const P = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });

export const FIN_TOOLS = [
  { name: 'fin_registrar_gasto', title: 'Registrar gasto', description: 'Registra gasto pessoal no balanço. Nome exato já existente → soma o valor ao item (passe sempre o valor NOVO, não o total). Nome só parecido → recusa e lista os parecidos (use criar_novo=true para criar separado).',
    inputSchema: P({ nome: nome('Descrição (ex: Mercado)'), valor: { type: 'number', description: 'Valor em reais a registrar/somar' }, categoria: nome('alimentação | transporte | saúde | lazer | casa | trabalho | outros'), pago: { type: 'boolean', description: 'true = já gastei; false = a pagar' }, criar_novo: { type: 'boolean' }, mes }, ['nome', 'valor']) },
  { name: 'fin_registrar_ganho', title: 'Registrar ganho', description: 'Registra ganho no balanço. Mesma regra de soma/parecidos de fin_registrar_gasto.',
    inputSchema: P({ nome: nome('Fonte (ex: Aula avulsa)'), valor: { type: 'number' }, categoria: nome('avulso | calistenia | personal | tattoo | 7force'), recebido: { type: 'boolean', description: 'true = já recebi; false = a receber' }, criar_novo: { type: 'boolean' }, mes }, ['nome', 'valor']) },
  { name: 'fin_marcar_gasto_pago', title: 'Marcar gasto como pago', description: 'Marca um gasto existente (pelo nome) como pago ou pendente.',
    inputSchema: P({ nome: nome('Nome do gasto'), pago: { type: 'boolean', description: 'padrão true' }, mes }, ['nome']) },
  { name: 'fin_marcar_ganho_recebido', title: 'Marcar ganho como recebido', description: 'Marca um ganho existente (pelo nome) como recebido ou pendente.',
    inputSchema: P({ nome: nome('Nome do ganho'), recebido: { type: 'boolean', description: 'padrão true' }, mes }, ['nome']) },
  { name: 'fin_aluno_pago', title: 'Marcar aluno como pago', description: 'Marca a mensalidade do aluno (calistenia, online ou presencial) como paga ou não paga no mês.',
    inputSchema: P({ nome: nome('Nome do aluno'), pago: { type: 'boolean', description: 'padrão true' }, mes }, ['nome']) },
  { name: 'fin_presenca', title: 'Registrar presença', description: 'Registra uma aula de aluno presencial (padrão: hoje).',
    inputSchema: P({ nome: nome('Nome do aluno presencial'), data: nome('YYYY-MM-DD (padrão hoje)'), mes }, ['nome']) },
  { name: 'fin_novo_aluno', title: 'Novo aluno', description: 'Cria aluno no mês (calistenia, online ou presencial). Telefone, dia de acerto e datas de treino ficam para preencher.',
    inputSchema: P({ nome: nome('Nome completo'), tipo: { type: 'string', enum: ['calistenia', 'online', 'presencial'] }, valor: { type: 'number', description: 'Mensalidade' }, mes }, ['nome', 'tipo', 'valor']) },
  { name: 'fin_cartao_compra', title: 'Compra no cartão', description: 'Registra compra no cartão BB ou Inter. Sem "parcelas" (ou 1) = à vista com o valor total; com parcelas = parcelado e "valor" é o de CADA parcela.',
    inputSchema: P({ titulo: nome('Descrição'), valor: { type: 'number' }, cartao: { type: 'string', enum: ['bb', 'inter'] }, parcelas: { type: 'integer', minimum: 1, maximum: 60 }, mes }, ['titulo', 'valor', 'cartao']) },
  { name: 'fin_corrigir_valor', title: 'Corrigir valor', description: 'Troca o valor de um gasto, ganho ou da mensalidade de um aluno (substitui, não soma).',
    inputSchema: P({ tipo: { type: 'string', enum: ['gasto', 'ganho', 'aluno'] }, nome: nome('Nome do item'), valor: { type: 'number' }, mes }, ['tipo', 'nome', 'valor']) },
  { name: 'fin_remover', title: 'Remover gasto/ganho', description: 'Remove um gasto ou ganho do balanço. Só com pedido explícito do Thiago. Dá para voltar com desfazer_ultima_alteracao.',
    inputSchema: P({ tipo: { type: 'string', enum: ['gasto', 'ganho'] }, nome: nome('Nome exato'), mes }, ['tipo', 'nome']) },
  { name: 'desfazer_ultima_alteracao', title: 'Desfazer última alteração', description: 'Volta o mês ao estado anterior à última gravação feita por estas ferramentas (financeiras ou de treino). Só guarda 1 passo; chamar de novo refaz.',
    inputSchema: P({ mes }, []) },
].map(t => ({ ...t, annotations: { readOnlyHint: false, destructiveHint: t.name === 'fin_remover', idempotentHint: false, openWorldHint: false } }));

export const FIN_NOMES = new Set(FIN_TOOLS.map(t => t.name));
