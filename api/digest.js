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

function daysUntilAcerto(diaAcertoStr, todayNum) {
  const m = (diaAcertoStr || '').match(/\d+/);
  if (!m) return null;
  return parseInt(m[0]) - todayNum;
}

function buildDigest(md, lembretes = []) {
  const today    = new Date();
  const todayS   = today.toISOString().split('T')[0];
  const in3S     = new Date(today.getTime() + 3 * 86400000).toISOString().split('T')[0];
  const todayNum = today.getDate();

  const DAYS   = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  const MONTHS = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  const dayLabel = `${DAYS[today.getDay()]}, ${today.getDate()} ${MONTHS[today.getMonth()]}`;

  const lines = [`📋 *Afazeres do dia — ${dayLabel}*\n`];
  const tasks = [];

  // ── 1. Alunos online e presencial com renovação em ≤3 dias (ou já vencida)
  const onlinePend = (md.personal?.online || []).filter(a => {
    if (a.pago || a.pausado) return false;
    const diff = daysUntilAcerto(a.diaAcerto, todayNum);
    return diff !== null && diff <= 3;
  });
  const presPend = (md.personal?.presencial || []).filter(a => {
    if (a.pago || a.pausado) return false;
    const diff = daysUntilAcerto(a.diaAcerto, todayNum);
    return diff !== null && diff <= 3;
  });
  const totalPend = onlinePend.length + presPend.length;

  if (totalPend > 0) {
    lines.push(`👥 *Cobrar alunos (${totalPend})*`);
    onlinePend.forEach(a => {
      const diff = daysUntilAcerto(a.diaAcerto, todayNum);
      const when = diff < 0 ? `venceu ${Math.abs(diff)}d atrás` : diff === 0 ? 'vence hoje' : `vence em ${diff}d`;
      const v = money(a.valor);
      lines.push(`  • ${a.nome} — ${v} _(${when})_`);
      tasks.push({ title: `Cobrar ${a.nome}`, notes: `Online • ${v} • ${when}`, category: 'cobranca' });
    });
    presPend.forEach(a => {
      const diff = daysUntilAcerto(a.diaAcerto, todayNum);
      const when = diff < 0 ? `venceu ${Math.abs(diff)}d atrás` : diff === 0 ? 'vence hoje' : `vence em ${diff}d`;
      const v = money(a.valor);
      lines.push(`  • ${a.nome} — ${v} _(${when})_`);
      tasks.push({ title: `Cobrar ${a.nome}`, notes: `Presencial • ${v} • ${when}`, category: 'cobranca' });
    });
    lines.push('');
  }

  // ── 2. Treino vencendo (proxAtt ≤ hoje+3 dias, ou já vencido)
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

  // ── 3. Lembretes customizados (apenas não concluídos)
  const pendLembretes = lembretes.filter(l => !l.concluido);
  if (pendLembretes.length > 0) {
    lines.push(`🔔 *Lembretes (${pendLembretes.length})*`);
    pendLembretes.forEach(l => {
      lines.push(`  • ${l.texto}`);
      tasks.push({ title: l.texto, notes: '', category: 'lembrete' });
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

  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const key = monthKey();
    const [md, lembretes] = await Promise.all([
      fetchData(key, SUPABASE_URL, SUPABASE_KEY),
      fetchData('__lembretes__', SUPABASE_URL, SUPABASE_KEY),
    ]);

    const lembs = Array.isArray(lembretes) ? lembretes : [];

    // Modo JSON: retorna tarefas estruturadas para iOS Shortcuts
    if (req.query?.format === 'json') {
      if (!md) return res.status(200).json({ tasks: [], hasItems: false });
      const { tasks, hasItems, dayLabel } = buildDigest(md, lembs);
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

    const { message } = buildDigest(md, lembs);
    await sendTelegram(message);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Digest error:', err);
    return res.status(500).json({ error: err.message });
  }
}
