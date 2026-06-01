/**
 * Gestor Caldas — Daily Digest
 * Chamado pelo Vercel Cron às 08:00 BRT (11:00 UTC) todo dia.
 * Envia via Telegram um resumo dos afazeres do dia.
 *
 * GET /api/digest             → envia Telegram + retorna { ok: true }
 * GET /api/digest?format=json → retorna JSON estruturado (para iOS Shortcuts)
 */

import { fetchData, monthKey } from './_tools.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const TG_TOKEN     = process.env.TG_TOKEN;
const TG_CHAT_ID   = process.env.TG_CHAT_ID;

// ── Helpers ──────────────────────────────────────────────────────────────────

function money(v) {
  return 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
}

function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}`;
}

async function sendTelegram(text) {
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'Markdown' }),
  });
}

// ── Lógica principal ──────────────────────────────────────────────────────────

function buildDigest(md) {
  const today  = new Date();
  const todayS = today.toISOString().split('T')[0];
  const in3S   = new Date(today.getTime() + 3 * 86400000).toISOString().split('T')[0];

  // Últimos 3 dias do mês (para alerta de cobrança de mensalidade)
  const lastDay    = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const daysToEOM  = lastDay - today.getDate(); // 0 = último dia, 1 = penúltimo, etc.
  const nearEOM    = daysToEOM <= 2; // hoje, amanhã ou depois-de-amanhã = últimos 3 dias

  const DAYS   = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  const MONTHS = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  const dayLabel = `${DAYS[today.getDay()]}, ${today.getDate()} ${MONTHS[today.getMonth()]}`;

  const lines = [`📋 *Afazeres do dia — ${dayLabel}*\n`];
  // tasks: lista estruturada para iOS Shortcuts
  // cada item: { title, notes, category }
  const tasks = [];

  // ── 1. Alunos online e presencial sem pagamento (só nos últimos 3 dias do mês)
  if (nearEOM) {
    const onlinePend = (md.personal?.online || []).filter(a => !a.pago && !a.pausado);
    const presPend   = (md.personal?.presencial || []).filter(a => !a.pago && !a.pausado);
    const total      = onlinePend.length + presPend.length;
    if (total > 0) {
      lines.push(`👥 *Cobrar alunos (${total}) — faltam ${daysToEOM === 0 ? 'hoje' : daysToEOM === 1 ? '1 dia' : '2 dias'} para fechar o mês*`);
      onlinePend.forEach(a => {
        const v = money(a.valor);
        lines.push(`  • ${a.nome} — ${v}`);
        tasks.push({ title: `Cobrar ${a.nome}`, notes: `Personal Online • ${v}`, category: 'cobranca' });
      });
      presPend.forEach(a => {
        const v = money(a.valor);
        lines.push(`  • ${a.nome} — ${v}`);
        tasks.push({ title: `Cobrar ${a.nome}`, notes: `Personal Presencial • ${v}`, category: 'cobranca' });
      });
      lines.push('');
    }
  }

  // ── 2. Treino vencendo (proxAtt ≤ hoje+3 dias, ou já vencido) ───────────────
  const allPersonal = [
    ...(md.personal?.online || []).map(a => ({ ...a, _tipo: 'Online' })),
    ...(md.personal?.presencial || []).map(a => ({ ...a, _tipo: 'Pres' })),
  ].filter(a => !a.pausado && a.proxAtt && a.proxAtt <= in3S);

  if (allPersonal.length > 0) {
    lines.push(`🏋️ *Atualizar treino (${allPersonal.length})*`);
    allPersonal.forEach(a => {
      const venceu = a.proxAtt < todayS;
      const label  = venceu ? `⚠️ venceu ${fmtDate(a.proxAtt)}` : `vence ${fmtDate(a.proxAtt)}`;
      lines.push(`  • ${a.nome} (${a._tipo}) — ${label}`);
      tasks.push({
        title: `Atualizar treino – ${a.nome}`,
        notes: `${a._tipo} • ${venceu ? 'Venceu em' : 'Vence em'} ${fmtDate(a.proxAtt)}`,
        category: 'treino',
      });
    });
    lines.push('');
  }

  if (tasks.length === 0) {
    lines.push('✅ Tudo em dia! Nenhum afazer pendente.');
  }

  return { tasks, hasItems: tasks.length > 0, message: lines.join('\n').trim(), dayLabel };
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();

  // CORS para iOS Shortcuts conseguir chamar diretamente
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const key = monthKey();
    const md  = await fetchData(key, SUPABASE_URL, SUPABASE_KEY);

    // Modo JSON: retorna tarefas estruturadas para iOS Shortcuts
    if (req.query?.format === 'json') {
      if (!md) return res.status(200).json({ tasks: [], hasItems: false });
      const { tasks, hasItems, dayLabel } = buildDigest(md);
      return res.status(200).json({
        tasks,
        hasItems,
        dayLabel,
        date: new Date().toISOString().split('T')[0],
      });
    }

    // Modo padrão: envia Telegram
    if (!md) {
      await sendTelegram('📋 Sem dados para o mês atual.');
      return res.status(200).json({ ok: true });
    }

    const { message } = buildDigest(md);
    await sendTelegram(message);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Digest error:', err);
    return res.status(500).json({ error: err.message });
  }
}
