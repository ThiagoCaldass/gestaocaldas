/**
 * Gestor Caldas — dados externos da página Central
 * GET /api/central  (Authorization: Bearer <token do login do app>)
 *
 * Junta, só para leitura:
 *  - formulários (Google Sheets das consultorias) ainda não marcados como "Feito"
 *  - conversas não lidas do MarcFlow
 * Cada fonte é opcional: sem as variáveis de ambiente dela, volta { configurado: false }.
 *
 * Variáveis de ambiente (Vercel):
 *  SUPABASE_URL, SUPABASE_KEY         — já existentes (validação do login)
 *  GOOGLE_SA_JSON                     — JSON da conta de serviço do Google (com acesso de leitura às planilhas)
 *  MARCFLOW_URL, MARCFLOW_API_KEY,    — ex.: https://whatsapp.teamcaldas.com.br, chave do perfil, id da sessão
 *  MARCFLOW_SESSION
 */

import { createSign } from 'node:crypto';
import { donoLogado } from './_auth.js';

export const PLANILHAS = [
  { id: '1_W1oxu9TXN7Kn_MI_o_1p5hq10gjBmmruGa75r8y8o4', consultoria: 'Feminina' },
  { id: '18mdnU_zViHoiesW2rhfLup1-Zm7MGfrQu-BbcYQf2ow', consultoria: 'Masculina' },
  { id: '1xG5k7GGj_ooBGT8c_5UoiYuphPZLhOVnRQPXFEofACc', consultoria: 'Calistenia' },
];
const ABAS = [
  { aba: 'Anamnese',         tipo: 'anamnese' },
  { aba: 'Atualizar treino', tipo: 'atualizar' },
];

// ── Google Sheets ────────────────────────────────────────────────────────────

const b64url = v => Buffer.from(v).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

export async function tokenGoogle(sa, fetchFn, escrita = false) {
  const agora = Math.floor(Date.now() / 1000);
  const cab = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const corpo = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: `https://www.googleapis.com/auth/spreadsheets${escrita ? '' : '.readonly'}`,
    aud: 'https://oauth2.googleapis.com/token',
    iat: agora, exp: agora + 3600,
  }));
  const assinatura = createSign('RSA-SHA256').update(`${cab}.${corpo}`).sign(sa.private_key, 'base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const r = await fetchFn('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${cab}.${corpo}.${assinatura}`,
    }),
  });
  if (!r.ok) throw new Error(`Google token ${r.status}`);
  return (await r.json()).access_token;
}

export const semAcento = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

// "04/09/2026 21:53:39" (fuso de Brasília) → ISO
function dataPlanilha(v) {
  const m = String(v || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const [, d, mo, a, h = '0', mi = '0', s = '0'] = m;
  return new Date(Date.UTC(+a, +mo - 1, +d, +h + 3, +mi, +s)).toISOString();
}

/** Linhas de uma aba → formulários sem "Feito" marcado. Exportada para teste. */
export function formulariosPendentes(valores, { planilha, consultoria, aba, tipo, gid }) {
  if (!valores?.length) return [];
  const cab = valores[0].map(semAcento);
  const col = pred => cab.findIndex(pred);
  const iFeito = col(c => c === 'feito');
  const iData  = col(c => c.startsWith('carimbo'));
  const iNome  = col(c => c.startsWith('nome'));
  const iTel   = col(c => c.startsWith('telefone'));
  const iEmail = col(c => c === 'email' || c === 'e-mail');
  const out = [];
  for (let i = 1; i < valores.length; i++) {
    const l = valores[i] || [];
    const nome = (l[iNome] || '').trim();
    if (!nome) continue;
    if (iFeito >= 0 && String(l[iFeito]).toUpperCase() === 'TRUE') continue;
    out.push({
      consultoria, tipo, nome,
      telefone: iTel >= 0 ? String(l[iTel] || '').replace(/\D/g, '') || null : null,
      email: iEmail >= 0 ? (l[iEmail] || '').trim() || null : null,
      enviadoEm: iData >= 0 ? dataPlanilha(l[iData]) : null,
      link: `https://docs.google.com/spreadsheets/d/${planilha}/edit#gid=${gid ?? 0}&range=A${i + 1}`,
    });
  }
  return out;
}

async function buscarFormularios(fetchFn) {
  if (!process.env.GOOGLE_SA_JSON) return { configurado: false, itens: [] };
  const sa = JSON.parse(process.env.GOOGLE_SA_JSON);
  const token = await tokenGoogle(sa, fetchFn);
  const H = { Authorization: `Bearer ${token}` };
  const erros = [];
  const porPlanilha = await Promise.all(PLANILHAS.map(p => lerPlanilha(p, H, fetchFn).catch(e => {
    console.error('central:', e.message); erros.push(e.message); return [];
  })));
  const itens = porPlanilha.flat().sort((a, b) => String(b.enviadoEm).localeCompare(String(a.enviadoEm)));
  return { configurado: true, itens, ...(erros.length ? { erro: erros.join('; ') } : {}) };
}

async function lerPlanilha(p, H, fetchFn) {
  {
    const base = `https://sheets.googleapis.com/v4/spreadsheets/${p.id}`;
    const [meta, vals] = await Promise.all([
      fetchFn(`${base}?fields=sheets.properties(sheetId,title)`, { headers: H }).then(r => r.ok ? r.json() : null),
      fetchFn(`${base}/values:batchGet?${ABAS.map(a => `ranges=${encodeURIComponent(`'${a.aba}'!A1:Z`)}`).join('&')}`, { headers: H })
        .then(r => { if (!r.ok) throw new Error(`Sheets ${p.consultoria} ${r.status}`); return r.json(); }),
    ]);
    const gids = Object.fromEntries((meta?.sheets || []).map(s => [s.properties.title, s.properties.sheetId]));
    return ABAS.flatMap((a, k) => formulariosPendentes(vals.valueRanges?.[k]?.values, {
      planilha: p.id, consultoria: p.consultoria, aba: a.aba, tipo: a.tipo, gid: gids[a.aba],
    }));
  }
}

/** Todas as respostas de formulário (nome, telefone, data, planilha, aba, Feito), para cruzar com o vencimento dos treinos. */
export async function respostasFormulario(fetchFn) {
  if (!process.env.GOOGLE_SA_JSON) return null;
  const token = await tokenGoogle(JSON.parse(process.env.GOOGLE_SA_JSON), fetchFn);
  const H = { Authorization: `Bearer ${token}` };
  const out = [];
  await Promise.all(PLANILHAS.map(async p => {
    const r = await fetchFn(`https://sheets.googleapis.com/v4/spreadsheets/${p.id}/values:batchGet?${ABAS.map(a => `ranges=${encodeURIComponent(`'${a.aba}'!A1:Z`)}`).join('&')}`, { headers: H });
    if (!r.ok) throw new Error(`Sheets ${p.consultoria} ${r.status}`);
    const j = await r.json();
    (j.valueRanges || []).forEach((vr, k) => {
      const v = vr.values || []; if (!v.length) return;
      const cab = v[0].map(semAcento), col = f => cab.findIndex(f);
      const iNome = col(c => c.startsWith('nome')), iTel = col(c => c.startsWith('telefone')),
        iData = col(c => c.startsWith('carimbo')), iFeito = col(c => c === 'feito');
      if (iNome < 0) return;
      for (const l of v.slice(1)) {
        const nome = (l[iNome] || '').trim(); if (!nome) continue;
        out.push({ nome, telefone: iTel >= 0 ? String(l[iTel] || '').replace(/\D/g, '') : '', data: iData >= 0 ? dataPlanilha(l[iData]) : null,
          consultoria: p.consultoria, aba: ABAS[k].aba, feito: iFeito >= 0 && String(l[iFeito]).toUpperCase() === 'TRUE' });
      }
    });
  }));
  return out;
}

/** Todas as respostas das planilhas (nome + telefone), para sugerir telefones de alunos. */
export async function todasRespostas(fetchFn) {
  if (!process.env.GOOGLE_SA_JSON) return [];
  const token = await tokenGoogle(JSON.parse(process.env.GOOGLE_SA_JSON), fetchFn);
  const H = { Authorization: `Bearer ${token}` };
  const out = [];
  await Promise.all(PLANILHAS.map(async p => {
    const r = await fetchFn(`https://sheets.googleapis.com/v4/spreadsheets/${p.id}/values:batchGet?${ABAS.map(a => `ranges=${encodeURIComponent(`'${a.aba}'!A1:Z`)}`).join('&')}`, { headers: H });
    if (!r.ok) return;
    const j = await r.json();
    for (const vr of j.valueRanges || []) {
      const v = vr.values || []; if (!v.length) continue;
      const cab = v[0].map(semAcento);
      const iNome = cab.findIndex(c => c.startsWith('nome')), iTel = cab.findIndex(c => c.startsWith('telefone'));
      if (iNome < 0 || iTel < 0) continue;
      for (const l of v.slice(1)) {
        const nome = (l[iNome] || '').trim(), tel = String(l[iTel] || '').replace(/\D/g, '');
        if (nome && tel.length >= 10) out.push({ nome, telefone: tel, fonte: `Formulário ${p.consultoria}` });
      }
    }
  }));
  return out;
}

// Mesma pessoa? Telefone (8 últimos dígitos) ou primeiro + último nome
export function mesmaPessoa(a, b) {
  const fim8 = t => { const d = String(t || '').replace(/\D/g, ''); return d.length >= 8 ? d.slice(-8) : null; };
  const ta = fim8(a.telefone), tb = fim8(b.telefone);
  if (ta && tb) return ta === tb;
  const pa = semAcento(a.nome).split(/\s+/).filter(Boolean), pb = semAcento(b.nome).split(/\s+/).filter(Boolean);
  if (!pa.length || !pb.length) return false;
  if (pa.length === 1 || pb.length === 1) return pa.join(' ') === pb.join(' ');
  return pb[0] === pa[0] && pb[pb.length - 1] === pa[pa.length - 1];
}

const colLetra = i => { let s = ''; for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s; return s; };

/** Marca "Feito" nas respostas do aluno feitas depois de `desde` (YYYY-MM-DD). Chamado ao entregar o treino. */
export async function marcarFeito({ nome, telefone, desde }, fetchFn = fetch) {
  if (!process.env.GOOGLE_SA_JSON) return { marcados: 0, erro: 'conta do Google não configurada' };
  if (!nome) return { marcados: 0, erro: 'nome vazio' };
  const token = await tokenGoogle(JSON.parse(process.env.GOOGLE_SA_JSON), fetchFn, true);
  const H = { Authorization: `Bearer ${token}` };
  let marcados = 0, erro = null;
  await Promise.all(PLANILHAS.map(async p => {
    const base = `https://sheets.googleapis.com/v4/spreadsheets/${p.id}`;
    const r = await fetchFn(`${base}/values:batchGet?${ABAS.map(a => `ranges=${encodeURIComponent(`'${a.aba}'!A1:Z`)}`).join('&')}`, { headers: H });
    if (!r.ok) { erro = `não consegui ler a planilha ${p.consultoria} (${r.status})`; return; }
    const j = await r.json();
    const data = [];
    (j.valueRanges || []).forEach((vr, k) => {
      const v = vr.values || []; if (!v.length) return;
      const cab = v[0].map(semAcento), col = f => cab.findIndex(f);
      const iFeito = col(c => c === 'feito'), iNome = col(c => c.startsWith('nome')),
        iTel = col(c => c.startsWith('telefone')), iData = col(c => c.startsWith('carimbo'));
      if (iFeito < 0 || iNome < 0) return;
      v.forEach((l, i) => {
        if (!i || String(l[iFeito]).toUpperCase() === 'TRUE') return;
        if (!mesmaPessoa({ nome, telefone }, { nome: l[iNome], telefone: iTel >= 0 ? l[iTel] : '' })) return;
        const quando = iData >= 0 ? dataPlanilha(l[iData]) : null;
        if (desde && quando && quando.slice(0, 10) <= desde) return;
        data.push({ range: `'${ABAS[k].aba}'!${colLetra(iFeito)}${i + 1}`, values: [[true]] });
      });
    });
    if (!data.length) return;
    const w = await fetchFn(`${base}/values:batchUpdate`, {
      method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
    });
    if (w.ok) marcados += data.length;
    else erro = w.status === 403
      ? 'a conta do Google do Gestor não tem permissão de editor nas planilhas'
      : `não consegui marcar na planilha ${p.consultoria} (${w.status})`;
  }));
  return { marcados, ...(erro ? { erro } : {}) };
}

// ── MarcFlow ─────────────────────────────────────────────────────────────────

/** Lista de conversas do MarcFlow → só as com mensagens não lidas, sem grupos. Exportada para teste. */
export function conversasNaoLidas(lista, baseUrl) {
  return (lista || [])
    .filter(c => (c.unreadCount || 0) > 0 && !String(c.jid).endsWith('@g.us') && c.jid !== 'status@broadcast')
    .map(c => ({
      jid: c.jid,
      nome: c.name || c.notify || null,
      telefone: c.jid.endsWith('@s.whatsapp.net') ? c.jid.split('@')[0] : null,
      naoLidas: c.unreadCount,
      ultima: c.lastMessage ? {
        texto: (c.lastMessage.content || '').slice(0, 140) || null,
        tipo: c.lastMessage.type || null,
        em: c.lastMessage.timestamp || null,
      } : null,
      link: `${baseUrl}/dashboard/chat/${encodeURIComponent(c.jid)}`,
    }));
}

async function buscarConversas(fetchFn) {
  const { MARCFLOW_URL, MARCFLOW_API_KEY, MARCFLOW_SESSION } = process.env;
  if (!MARCFLOW_URL || !MARCFLOW_API_KEY || !MARCFLOW_SESSION) return { configurado: false, itens: [] };
  const base = MARCFLOW_URL.replace(/\/+$/, '');
  const r = await fetchFn(`${base}/api/chat/${encodeURIComponent(MARCFLOW_SESSION)}`, {
    headers: { 'X-API-Key': MARCFLOW_API_KEY },
  });
  if (!r.ok) throw new Error(`MarcFlow ${r.status}`);
  const j = await r.json();
  return { configurado: true, url: base, itens: conversasNaoLidas(j.data, base) };
}

// ── Handler ──────────────────────────────────────────────────────────────────

async function seguro(fn) {
  try { return await fn(); }
  catch (e) { console.error('central:', e.message); return { configurado: true, erro: e.message, itens: [] }; }
}

export async function montarCentral(req, fetchFn = fetch) {
  if (!(await donoLogado(req, fetchFn))) return { status: 401, corpo: { error: 'Não autorizado' } };
  const [formularios, conversas] = await Promise.all([seguro(() => buscarFormularios(fetchFn)), seguro(() => buscarConversas(fetchFn))]);
  return { status: 200, corpo: { geradoEm: new Date().toISOString(), formularios, conversas } };
}

export default async function handler(req, res) {
  if (req.method === 'POST') {
    // POST { acao: 'feito', nome, telefone, desde } → marca "Feito" na planilha do formulário
    if (!(await donoLogado(req))) return res.status(401).json({ error: 'Não autorizado' });
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (b.acao !== 'feito') return res.status(400).json({ error: 'Ação desconhecida' });
    const desde = /^\d{4}-\d{2}-\d{2}$/.test(b.desde || '') ? b.desde : null;
    try { return res.status(200).json(await marcarFeito({ nome: String(b.nome || ''), telefone: String(b.telefone || ''), desde })); }
    catch (e) { console.error('central feito:', e.message); return res.status(200).json({ marcados: 0, erro: e.message }); }
  }
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'Use GET' }); }
  const { status, corpo } = await montarCentral(req);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json(corpo);
}
