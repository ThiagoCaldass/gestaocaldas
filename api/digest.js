/**
 * Gestor Caldas — Daily Digest
 * Chamado pelo Vercel Cron às 08:00 BRT (11:00 UTC) todo dia.
 * Envia via Telegram um resumo dos afazeres do dia.
 *
 * GET /api/digest             → envia Telegram + retorna { ok: true }
 * GET /api/digest?format=json → retorna JSON estruturado (para iOS Shortcuts)
 */

import { fetchData, monthKey } from './_tools.js';
import { STORIES_60DIAS } from './_stories.js';

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

  const DAYS   = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  const MONTHS = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  const dayLabel = `${DAYS[today.getDay()]}, ${today.getDate()} ${MONTHS[today.getMonth()]}`;

  const lines = [`📋 *Afazeres do dia — ${dayLabel}*\n`];
  // tasks: lista estruturada para iOS Shortcuts
  // cada item: { title, notes, category }
  const tasks = [];

  // ── 1. Alunos sem pagamento ────────────────────────────────────────────────
  const caliPend   = (md.calistenia || []).filter(a => !a.pago && !a.pausado);
  const onlinePend = (md.personal?.online || []).filter(a => !a.pago && !a.pausado);
  const presPend   = (md.personal?.presencial || []).filter(a => !a.pago && !a.pausado);
  const totalAlunos = caliPend.length + onlinePend.length + presPend.length;

  if (totalAlunos > 0) {
    lines.push(`👥 *Cobrar alunos (${totalAlunos})*`);
    caliPend.forEach(a => {
      const v = money(a.valorFinal ?? a.valorBase ?? a.valor);
      lines.push(`  • ${a.nome} — ${v}`);
      tasks.push({ title: `Cobrar ${a.nome}`, notes: `Calistenia • ${v}`, category: 'cobranca' });
    });
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

  // ── 3. Gastos pendentes ───────────────────────────────────────────────────
  const gastosPend = (md.balanco?.gastos || []).filter(g => !g.pago);
  if (gastosPend.length > 0) {
    const total = gastosPend.reduce((s, g) => s + (g.valor || 0), 0);
    lines.push(`💸 *Pagar contas (${gastosPend.length}) — ${money(total)}*`);
    gastosPend.slice(0, 6).forEach(g => {
      lines.push(`  • ${g.nome} — ${money(g.valor)}`);
      tasks.push({ title: `Pagar ${g.nome}`, notes: money(g.valor), category: 'gasto' });
    });
    if (gastosPend.length > 6) {
      lines.push(`  _...e mais ${gastosPend.length - 6}_`);
      tasks.push({ title: `+${gastosPend.length - 6} contas a pagar`, notes: '', category: 'gasto' });
    }
    lines.push('');
  }

  // ── 4. Ganhos avulsos pendentes ──────────────────────────────────────────
  const ganhosPend = (md.balanco?.ganhos || [])
    .filter(g => !g.recebido && !['calistenia','personal','tattoo','7force'].includes((g.categoria||'').toLowerCase()));
  if (ganhosPend.length > 0) {
    const total = ganhosPend.reduce((s, g) => s + (g.valor || 0), 0);
    lines.push(`💰 *A receber (${ganhosPend.length}) — ${money(total)}*`);
    ganhosPend.slice(0, 4).forEach(g => {
      lines.push(`  • ${g.nome} — ${money(g.valor)}`);
      tasks.push({ title: `Receber de ${g.nome}`, notes: money(g.valor), category: 'ganho' });
    });
    if (ganhosPend.length > 4) {
      lines.push(`  _...e mais ${ganhosPend.length - 4}_`);
      tasks.push({ title: `+${ganhosPend.length - 4} a receber`, notes: '', category: 'ganho' });
    }
    lines.push('');
  }

  // ── 5. Tatuagens não pagas ────────────────────────────────────────────────
  const tattooPend = (md.tattoo || []).filter(t => !t.pago);
  if (tattooPend.length > 0) {
    lines.push(`🎨 *Cobrar tatuagem (${tattooPend.length})*`);
    tattooPend.slice(0, 4).forEach(t => {
      const v = money(t.valor);
      lines.push(`  • ${t.cliente || 'Cliente'} — ${v}`);
      tasks.push({ title: `Cobrar tatuagem – ${t.cliente || 'Cliente'}`, notes: v, category: 'tattoo' });
    });
    lines.push('');
  }

  // ── 6. Story do dia ──────────────────────────────────────────────────────────
  const storyDia = STORIES_60DIAS.find(d => d.data === todayS);
  if (storyDia) {
    lines.push(`📱 *Story do dia — Dia ${storyDia.dia}*`);
    lines.push(`_${storyDia.categoria} · ${storyDia.tema}_`);
    storyDia.stories.forEach(s => {
      tasks.push({
        title: `Story ${s.num.replace('Story ', '')} — ${storyDia.tema}`,
        notes: s.copy,
        category: 'story',
      });
    });
    lines.push(`  ${storyDia.stories.length} stories para postar hoje`);
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
