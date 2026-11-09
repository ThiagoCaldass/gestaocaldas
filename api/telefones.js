/**
 * Gestor Caldas — fontes de telefone para completar o cadastro dos alunos
 * GET /api/telefones  (só o dono logado)
 * Devolve [{ nome, telefone, fonte }] dos contatos do MarcFlow (agenda do WhatsApp) e das respostas dos formulários.
 * Quem casa nome ↔ aluno é o app; aqui só junta as listas.
 */

import { donoLogado } from './_auth.js';
import { todasRespostas } from './central.js';

async function contatosMarcFlow(fetchFn) {
  const { MARCFLOW_URL, MARCFLOW_API_KEY, MARCFLOW_SESSION } = process.env;
  if (!MARCFLOW_URL || !MARCFLOW_API_KEY || !MARCFLOW_SESSION) return [];
  const r = await fetchFn(`${MARCFLOW_URL.replace(/\/+$/, '')}/api/contacts/${encodeURIComponent(MARCFLOW_SESSION)}?limit=all`, {
    headers: { 'X-API-Key': MARCFLOW_API_KEY },
  });
  if (!r.ok) throw new Error(`MarcFlow ${r.status}`);
  const j = await r.json();
  const fone = jid => /^(\d{10,15})@s\.whatsapp\.net$/.exec(jid || '')?.[1];
  return (j.data || []).map(c => ({
    nome: c.name || c.verifiedName || c.notify || '',
    telefone: fone(c.jid) || fone(c.remoteJidAlt),
    fonte: c.name ? 'Agenda do WhatsApp' : 'Nome no WhatsApp',
  })).filter(c => c.nome && c.telefone);
}

export async function montarTelefones(req, fetchFn = fetch) {
  if (!(await donoLogado(req, fetchFn))) return { status: 401, corpo: { error: 'Não autorizado' } };
  const erros = [];
  const [mf, fm] = await Promise.all([
    contatosMarcFlow(fetchFn).catch(e => { erros.push(e.message); return []; }),
    todasRespostas(fetchFn).catch(e => { erros.push(e.message); return []; }),
  ]);
  return { status: 200, corpo: { itens: [...fm, ...mf], ...(erros.length ? { erro: erros.join('; ') } : {}) } };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'Use GET' }); }
  const { status, corpo } = await montarTelefones(req);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json(corpo);
}
