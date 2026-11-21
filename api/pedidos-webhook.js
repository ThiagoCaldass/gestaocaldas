/**
 * Gestor Caldas — webhook do MarcFlow (evento "message.received").
 * POST /api/pedidos-webhook?chave=<PEDIDOS_WEBHOOK_CHAVE>
 * Classifica a mensagem com o Claude; se for pedido de mudança no treino, guarda em __pedidos_treino__
 * e avisa o Thiago no Telegram. Nunca responde ao aluno.
 */

import { timingSafeEqual } from 'node:crypto';
import { fetchData, monthKey } from './_tools.js';
import { ultimasMensagens } from './_whatsapp.js';
import { lerPedidos, classificar, registrar, pedidoRecente, alunoPorTelefone, textoAviso, avisarTelegram, CHAVE } from './_pedidos.js';
import { salvarMes } from './_escrita.js';

const CHAVE_WEBHOOK = () => process.env.PEDIDOS_WEBHOOK_CHAVE;

export function chaveValida(req) {
  const certa = CHAVE_WEBHOOK();
  if (!certa) return false;
  const auth = req.headers?.authorization || '';
  const dada = String(req.query?.chave || (auth.startsWith('Bearer ') ? auth.slice(7) : ''));
  const a = Buffer.from(dada), b = Buffer.from(certa);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Tira do payload do MarcFlow o que interessa; null = ignorar (com o motivo). Exportada para teste. */
export function lerEvento(body) {
  if (body?.event !== 'message.received') return { ignorar: 'evento não é message.received' };
  const d = body.data || {};
  const jid = String(d.from || d.key?.remoteJid || '');
  if (d.key?.fromMe) return { ignorar: 'enviada por mim' };
  if (d.isGroup || jid.endsWith('@g.us') || (d.chatType && d.chatType !== 'PERSONAL')) return { ignorar: 'grupo ou status' };
  const texto = String(d.content || d.caption || '').trim();
  if (!texto || !/\p{L}/u.test(texto)) return { ignorar: 'sem texto' };
  const ts = Number(d.messageTimestamp);
  return {
    msgId: d.key?.id || null,
    jid,
    telefone: jid.endsWith('@s.whatsapp.net') ? jid.split('@')[0] : null,
    nomeContato: d.pushName || null,
    texto,
    quando: Number.isFinite(ts) && ts > 0 ? new Date(ts < 1e12 ? ts * 1000 : ts).toISOString() : null,
  };
}

/** Processa um evento. Dependências injetáveis para teste. */
export async function processar(body, deps = {}) {
  const {
    agora = new Date().toISOString(),
    lerLista = lerPedidos,
    gravarLista = l => salvarMes(CHAVE, l),
    lerMes = () => fetchData(monthKey(), process.env.SUPABASE_URL, process.env.SUPABASE_KEY),
    contexto = jid => ultimasMensagens(jid, 6),
    classificador = classificar,
    avisar = avisarTelegram,
  } = deps;
  const ev = lerEvento(body);
  if (ev.ignorar) return { ok: true, ignorada: ev.ignorar };

  // contexto: até 3 mensagens antes desta (se o MarcFlow não responder, segue sem)
  let anteriores = [];
  try { anteriores = (await contexto(ev.jid)).filter(m => m.id !== ev.msgId && m.texto).slice(-3); } catch { /* sem contexto */ }

  const [lista, md] = await Promise.all([lerLista(), lerMes().catch(() => null)]);
  const aberto = pedidoRecente(lista, { telefone: ev.telefone, jid: ev.jid, agora });

  let classe = null, falhou = null;
  try { classe = await classificador(ev.texto, anteriores, { resumoAberto: aberto?.resumo }); } catch (e) { falhou = e.message; console.error('pedidos: classificação falhou:', e.message); }
  if (classe && !classe.e_pedido) return { ok: true, ignorada: 'não é pedido' };

  const al = md ? alunoPorTelefone(md, ev.telefone) : null;
  const r = registrar(lista, { ...ev, aluno: al ? { nome: al.a.nome, modalidade: al.modalidade } : null, classe, agora });
  if (r.ignorada) return { ok: true, ignorada: r.ignorada };
  await gravarLista(r.lista);

  let avisado = false;
  if (r.avisar) {
    try { await avisar(textoAviso(r.pedido, { novo: r.novo, agora })); avisado = true; } catch (e) { console.error('pedidos: Telegram falhou:', e.message); }
  }
  return { ok: true, pedido: r.pedido.id, novo: r.novo, avisado, ...(falhou ? { nao_classificada: true } : {}) };
}

export default async function handler(req, res) {
  if (!chaveValida(req)) return res.status(401).json({ error: 'Não autorizado' });
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Use POST' }); }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'JSON inválido' }); } }
  if (body?.event === 'test') return res.status(200).json({ ok: true, teste: true });
  try {
    return res.status(200).json(await processar(body));
  } catch (e) {
    console.error('pedidos-webhook:', e);
    return res.status(500).json({ error: 'Falha ao registrar' });
  }
}
