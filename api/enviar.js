/**
 * Gestor Caldas — envio de WhatsApp pelo MarcFlow (substitui o servidor wa-caldas)
 *
 * GET  /api/enviar  → { conectado, status }  situação do número no MarcFlow
 * POST /api/enviar  { contatos: [{ nome, telefone }], mensagens: [versão, ...], intervaloMin?: 1 }
 *   - 1 contato  → envia na hora
 *   - vários     → agenda no MarcFlow, um a cada `intervaloMin` minutos (o MarcFlow envia mesmo com o app fechado)
 *   Cada contato recebe uma versão sorteada; {nome} = nome no Gestor, {primeiro_nome} = só o primeiro nome.
 * Só o dono logado.
 */

import { donoLogado } from './_auth.js';

const MAX_CONTATOS = 100;

function config() {
  const { MARCFLOW_URL, MARCFLOW_API_KEY, MARCFLOW_SESSION } = process.env;
  if (!MARCFLOW_URL || !MARCFLOW_API_KEY || !MARCFLOW_SESSION) return null;
  return { base: MARCFLOW_URL.replace(/\/+$/, ''), key: MARCFLOW_API_KEY, sessao: MARCFLOW_SESSION };
}

// Telefone → JID do WhatsApp (assume Brasil quando vem sem DDI)
export function jidDe(telefone) {
  let d = String(telefone || '').replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) d = '55' + d;
  return d.length >= 12 && d.length <= 15 ? `${d}@s.whatsapp.net` : null;
}

export function montarTexto(versao, nome) {
  const n = String(nome || '').trim();
  return String(versao).replace(/\{nome\}/g, n).replace(/\{primeiro_nome\}/g, n.split(/\s+/)[0] || '');
}

// "YYYY-MM-DDTHH:mm" no horário de Brasília (o agendador do MarcFlow lê no fuso configurado: America/Sao_Paulo)
export function horaBR(d) {
  const b = new Date(d.getTime() - 3 * 3600 * 1000);
  return b.toISOString().slice(0, 16);
}

export async function enviar(body, fetchFn = fetch, agora = new Date(), sorteio = Math.random) {
  const cfg = config();
  if (!cfg) return { status: 503, corpo: { error: 'MarcFlow não configurado' } };
  const versoes = (body?.mensagens || []).map(m => String(m || '').trim()).filter(Boolean);
  const contatos = (body?.contatos || []).map(c => ({ nome: c?.nome, jid: jidDe(c?.telefone) }));
  if (!versoes.length) return { status: 400, corpo: { error: 'Escreva a mensagem' } };
  if (!contatos.length) return { status: 400, corpo: { error: 'Nenhum contato' } };
  if (contatos.length > MAX_CONTATOS) return { status: 400, corpo: { error: `No máximo ${MAX_CONTATOS} contatos por vez` } };
  const intervalo = Math.min(30, Math.max(1, Number(body?.intervaloMin) || 1));
  const H = { 'X-API-Key': cfg.key, 'Content-Type': 'application/json' };

  const resultados = [];
  for (let i = 0; i < contatos.length; i++) {
    const { nome, jid } = contatos[i];
    if (!jid) { resultados.push({ nome, status: 'telefone_invalido' }); continue; }
    const texto = montarTexto(versoes[Math.floor(sorteio() * versoes.length)], nome);
    try {
      if (contatos.length === 1) {
        const r = await fetchFn(`${cfg.base}/api/messages/${encodeURIComponent(cfg.sessao)}/${encodeURIComponent(jid)}/send`, {
          method: 'POST', headers: H, body: JSON.stringify({ message: { text: texto } }),
        });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || `MarcFlow ${r.status}`);
        resultados.push({ nome, status: 'enviado' });
      } else {
        const quando = new Date(agora.getTime() + (i + 1) * intervalo * 60000);
        const r = await fetchFn(`${cfg.base}/api/scheduler/${encodeURIComponent(cfg.sessao)}`, {
          method: 'POST', headers: H, body: JSON.stringify({ jid, content: texto, sendAt: horaBR(quando) }),
        });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || `MarcFlow ${r.status}`);
        resultados.push({ nome, status: 'agendado', em: quando.toISOString() });
      }
    } catch (e) {
      resultados.push({ nome, status: 'erro', erro: e.message });
    }
  }
  return { status: 200, corpo: { resultados, painel: `${cfg.base}/dashboard/scheduler` } };
}

async function situacao(fetchFn = fetch) {
  const cfg = config();
  if (!cfg) return { conectado: false, status: 'nao_configurado' };
  const r = await fetchFn(`${cfg.base}/api/sessions`, { headers: { 'X-API-Key': cfg.key } });
  if (!r.ok) return { conectado: false, status: `erro_${r.status}` };
  const j = await r.json().catch(() => ({}));
  const s = (j.data || []).find(x => x.sessionId === cfg.sessao);
  const st = String(s?.status || 'desconhecido').toUpperCase();
  return { conectado: st === 'CONNECTED' || st === 'OPEN' || st === 'CONECTADO', status: st, url: cfg.base };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!(await donoLogado(req))) return res.status(401).json({ error: 'Não autorizado' });
  if (req.method === 'GET') return res.status(200).json(await situacao());
  if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'Use GET ou POST' }); }
  const { status, corpo } = await enviar(req.body);
  return res.status(status).json(corpo);
}
