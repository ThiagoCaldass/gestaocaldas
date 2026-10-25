/**
 * Gestor Caldas — Assistente financeiro
 * POST /api/analise  { mes: "YYYY-MM" }
 * Lê o mês (e os 2 anteriores) do Supabase, pede a análise ao Claude e salva em __analise_YYYY-MM__.
 * O texto enviado ao Claude é montado aqui a partir do banco — o cliente só escolhe o mês.
 */

import Anthropic from '@anthropic-ai/sdk';
import { fetchData, saveData } from './_tools.js';
import { resumoDetalhado, resumoCurto, resumoPoupanca } from './_resumo.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

const MESES = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];

const SYSTEM = `Você é o assistente financeiro pessoal do Thiago Caldas, personal trainer autônomo (alunos de calistenia, consultoria online e aulas presenciais). A renda dele varia mês a mês e parte dela entra numa conta empresarial, de onde ele faz retiradas para a conta pessoal.

Você recebe um resumo em JSON do mês analisado e dos dois meses anteriores, gerado pelo app de gestão dele. Analise como foi o mês e ajude-o a melhorar a gestão e a relação com o dinheiro.

Como ler os dados:
- "alunos": receita prevista vs. recebida por modalidade; "recebido_conta_empresarial" é a parte que caiu na conta empresarial (chega ao pessoal via retirada, listada em "outros_ganhos").
- "gastos_pessoais": "fixo_mensal" = recorrente; "pago_em" = dia em que foi pago; faturas de cartão aparecem como gasto ("Fatura BB", "Fatura Inter") e o detalhe da fatura está em "cartoes".
- Se "mes_em_andamento" for true, o mês ainda não terminou: trate pendências como previsão, não como falha.
- Valores em reais. Não invente números que não estão nos dados; se algo estiver ambíguo, diga.

Responda em português do Brasil, tom direto e próximo (como um amigo que entende de finanças), em Markdown, com estas seções:
## Resumo do mês
3-4 frases com o saldo, o que entrou e o que saiu.
## O que foi bem
## Pontos de atenção
Gastos que pesaram, categorias que cresceram vs. meses anteriores, parcelas e assinaturas, alunos pendentes, concentração de gastos no início do mês, etc.
## Ações para o próximo mês
3 a 5 ações concretas e mensuráveis (com valores ou metas quando possível).
## Relação com o dinheiro
1 parágrafo curto sobre hábitos e comportamento que os números sugerem, sem julgamento.

Seja específico: cite itens e valores reais. Não recomende produtos de investimento específicos.`;

function mesAnterior(mk, n) {
  let [y, m] = mk.split('-').map(Number);
  m -= n;
  while (m < 1) { m += 12; y--; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });
  const mes = req.body?.mes;
  if (!/^\d{4}-\d{2}$/.test(mes || '')) return res.status(400).json({ error: 'mes inválido (YYYY-MM)' });

  try {
    const anteriores = [mesAnterior(mes, 1), mesAnterior(mes, 2)];
    const [md, ant1, ant2, poup] = await Promise.all([
      fetchData(mes, SUPABASE_URL, SUPABASE_KEY),
      fetchData(anteriores[0], SUPABASE_URL, SUPABASE_KEY),
      fetchData(anteriores[1], SUPABASE_URL, SUPABASE_KEY),
      fetchData('__poupanca__', SUPABASE_URL, SUPABASE_KEY),
    ]);
    if (!md) return res.status(404).json({ error: 'Mês sem dados' });

    const agoraBR = new Date(Date.now() - 3 * 3600 * 1000);
    const mesAtual = `${agoraBR.getUTCFullYear()}-${String(agoraBR.getUTCMonth() + 1).padStart(2, '0')}`;
    const [y, m] = mes.split('-').map(Number);
    const dados = {
      mes_analisado: `${MESES[m - 1]} de ${y}`,
      mes_em_andamento: mes === mesAtual,
      dia_de_hoje: mes === mesAtual ? agoraBR.getUTCDate() : null,
      dias_no_mes: new Date(y, m, 0).getDate(),
      detalhe: resumoDetalhado(md),
      meses_anteriores: Object.fromEntries(
        [[anteriores[0], ant1], [anteriores[1], ant2]].filter(([, d]) => d).map(([k, d]) => [k, resumoCurto(d)])
      ),
      poupanca: resumoPoupanca(poup, [mes, ...anteriores]),
    };

    const response = await client.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      messages: [{ role: 'user', content: `Dados do app (JSON):\n${JSON.stringify(dados)}` }],
    });

    if (response.stop_reason === 'refusal') {
      return res.status(422).json({ error: 'O modelo não conseguiu gerar a análise.' });
    }
    const texto = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    if (!texto) return res.status(502).json({ error: 'Resposta vazia do modelo' });

    const analise = { mes, texto, geradoEm: Date.now(), modelo: response.model };
    await saveData(`__analise_${mes}__`, analise, SUPABASE_URL, SUPABASE_KEY);
    return res.status(200).json(analise);
  } catch (err) {
    console.error('Erro na análise:', err);
    if (err instanceof Anthropic.RateLimitError) return res.status(429).json({ error: 'Muitas requisições — tente em instantes.' });
    if (err instanceof Anthropic.APIError) return res.status(502).json({ error: `Erro da API (${err.status})` });
    return res.status(500).json({ error: err.message || 'Erro interno' });
  }
}
