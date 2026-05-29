/**
 * Gestor Caldas — Daily Digest
 * Chamado pelo Vercel Cron às 08:00 BRT (11:00 UTC) todo dia.
 * Envia via Telegram um resumo dos afazeres do dia.
 */

import { fetchData, monthKey } from './_tools.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const TG_TOKEN     = process.env.TG_TOKEN;
const TG_CHAT_ID   = process.env.TG_CHAT_ID;

// ── Helpers ──────────────────────────────────────────────────────────────────

function money(v) {
  return 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
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

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();

  try {
    const key = monthKey();
    const md  = await fetchData(key, SUPABASE_URL, SUPABASE_KEY);

    if (!md) {
      await sendTelegram('📋 Sem dados para o mês atual.');
      return res.status(200).json({ ok: true });
    }

    const today   = new Date();
    const todayS  = today.toISOString().split('T')[0];
    const in7S    = new Date(today.getTime() + 7 * 86400000).toISOString().split('T')[0];

    const DAYS   = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
    const MONTHS = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
    const dayLabel = `${DAYS[today.getDay()]}, ${today.getDate()} ${MONTHS[today.getMonth()]}`;

    const lines = [`📋 *Afazeres do dia — ${dayLabel}*\n`];
    let hasItems = false;

    // ── 1. Alunos sem pagamento ────────────────────────────────────────────────
    const caliPend    = (md.calistenia || []).filter(a => !a.pago && !a.pausado);
    const onlinePend  = (md.personal?.online || []).filter(a => !a.pago && !a.pausado);
    const presPend    = (md.personal?.presencial || []).filter(a => !a.pago && !a.pausado);
    const totalAlunos = caliPend.length + onlinePend.length + presPend.length;

    if (totalAlunos > 0) {
      hasItems = true;
      lines.push(`👥 *Cobrar alunos (${totalAlunos})*`);
      caliPend.forEach(a   => lines.push(`  • ${a.nome} — ${money(a.valorFinal ?? a.valorBase ?? a.valor)}`));
      onlinePend.forEach(a => lines.push(`  • ${a.nome} — ${money(a.valor)}`));
      presPend.forEach(a   => lines.push(`  • ${a.nome} — ${money(a.valor)}`));
      lines.push('');
    }

    // ── 2. Treino vencendo (proxAtt ≤ hoje+7 dias) ────────────────────────────
    const allPersonal = [
      ...(md.personal?.online || []).map(a => ({ ...a, _tipo: 'Online' })),
      ...(md.personal?.presencial || []).map(a => ({ ...a, _tipo: 'Pres' })),
    ].filter(a => !a.pausado && a.proxAtt && a.proxAtt <= in7S);

    if (allPersonal.length > 0) {
      hasItems = true;
      lines.push(`🏋️ *Atualizar treino (${allPersonal.length})*`);
      allPersonal.forEach(a => {
        const venceu = a.proxAtt < todayS;
        const label  = venceu ? `⚠️ venceu ${fmtDate(a.proxAtt)}` : `vence ${fmtDate(a.proxAtt)}`;
        lines.push(`  • ${a.nome} (${a._tipo}) — ${label}`);
      });
      lines.push('');
    }

    // ── 3. Gastos pendentes ───────────────────────────────────────────────────
    const gastosPend = (md.balanco?.gastos || []).filter(g => !g.pago);
    if (gastosPend.length > 0) {
      hasItems = true;
      const total = gastosPend.reduce((s, g) => s + (g.valor || 0), 0);
      lines.push(`💸 *Pagar contas (${gastosPend.length}) — ${money(total)}*`);
      gastosPend.slice(0, 6).forEach(g => lines.push(`  • ${g.nome} — ${money(g.valor)}`));
      if (gastosPend.length > 6) lines.push(`  _...e mais ${gastosPend.length - 6}_`);
      lines.push('');
    }

    // ── 4. Ganhos avulsos pendentes ──────────────────────────────────────────
    const ganhosPend = (md.balanco?.ganhos || [])
      .filter(g => !g.recebido && !['calistenia','personal','tattoo','7force'].includes((g.categoria||'').toLowerCase()));
    if (ganhosPend.length > 0) {
      hasItems = true;
      const total = ganhosPend.reduce((s, g) => s + (g.valor || 0), 0);
      lines.push(`💰 *A receber (${ganhosPend.length}) — ${money(total)}*`);
      ganhosPend.slice(0, 4).forEach(g => lines.push(`  • ${g.nome} — ${money(g.valor)}`));
      if (ganhosPend.length > 4) lines.push(`  _...e mais ${ganhosPend.length - 4}_`);
      lines.push('');
    }

    // ── 5. Tatuagens não pagas ────────────────────────────────────────────────
    const tattooPend = (md.tattoo || []).filter(t => !t.pago);
    if (tattooPend.length > 0) {
      hasItems = true;
      lines.push(`🎨 *Cobrar tatuagem (${tattooPend.length})*`);
      tattooPend.slice(0, 4).forEach(t => lines.push(`  • ${t.cliente || 'Cliente'} — ${money(t.valor)}`));
      lines.push('');
    }

    if (!hasItems) {
      lines.push('✅ Tudo em dia! Nenhum afazer pendente.');
    }

    const message = lines.join('\n').trim();
    await sendTelegram(message);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Digest error:', err);
    return res.status(500).json({ error: err.message });
  }
}
