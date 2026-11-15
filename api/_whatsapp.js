/**
 * Gestor Caldas — ferramentas de WhatsApp (MarcFlow) para o conector MCP do Claude.
 * Leitura: conversas, histórico, busca, agendamentos e fluxos. Escrita: enviar texto ou arquivo, responder, agendar,
 * cancelar agendamento e marcar como lida — sempre no número de trabalho conectado no MarcFlow.
 */

import { jidDe, horaBR } from './enviar.js';

export class ErroWhats extends Error {}

function config() {
  const { MARCFLOW_URL, MARCFLOW_API_KEY, MARCFLOW_SESSION } = process.env;
  if (!MARCFLOW_URL || !MARCFLOW_API_KEY || !MARCFLOW_SESSION) throw new ErroWhats('MarcFlow não configurado no servidor do Gestor');
  return { base: MARCFLOW_URL.replace(/\/+$/, ''), key: MARCFLOW_API_KEY, sessao: encodeURIComponent(MARCFLOW_SESSION) };
}

async function api(caminho, { method = 'GET', body, form, fetchFn = fetch } = {}) {
  const cfg = config();
  const r = await fetchFn(`${cfg.base}/api${caminho.replace('{s}', cfg.sessao)}`, {
    method,
    headers: { 'X-API-Key': cfg.key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: form || (body ? JSON.stringify(body) : undefined),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.status === false) throw new ErroWhats(j.message || j.error || `MarcFlow ${r.status}`);
  return j;
}

// Aceita JID (…@s.whatsapp.net / @lid / @g.us) ou telefone (com ou sem 55)
function alvo(args) {
  const v = String(args.contato || '').trim();
  if (!v) throw new ErroWhats('Informe "contato": telefone com DDD ou o jid que veio de whatsapp_conversas');
  if (v.includes('@')) return v;
  const jid = jidDe(v);
  if (!jid) throw new ErroWhats(`Telefone inválido: ${v}`);
  return jid;
}

// ── Arquivos por link ────────────────────────────────────────────────────────

const LIMITE_MB = 50;

// Link de compartilhamento do Google Drive → link de download direto
export function linkDireto(url) {
  const u = String(url || '').trim();
  const id = u.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:[^#]*&)?id=)([\w-]{10,})/)?.[1];
  if (id) return { url: `https://drive.google.com/uc?export=download&id=${id}`, drive: true };
  const doc = u.match(/docs\.google\.com\/(document|spreadsheets|presentation)\/d\/([\w-]{10,})/);
  if (doc) return { url: `https://docs.google.com/${doc[1]}/d/${doc[2]}/export?format=pdf`, drive: true };
  return { url: u, drive: false };
}

export function tipoDe(mime, nome) {
  const m = String(mime || '').toLowerCase(), ext = String(nome || '').toLowerCase().split('.').pop();
  if (m.startsWith('image/') && !m.includes('svg') || ['jpg', 'jpeg', 'png', 'webp'].includes(ext)) return 'image';
  if (m.startsWith('video/') || ['mp4', 'mov', '3gp'].includes(ext)) return 'video';
  if (m.startsWith('audio/') || ['mp3', 'ogg', 'm4a', 'opus', 'wav'].includes(ext)) return 'audio';
  return 'document';
}

function nomeDoLink(r, url) {
  const cd = r.headers.get('content-disposition') || '';
  const n = cd.match(/filename\*=UTF-8''([^;]+)/i)?.[1] || cd.match(/filename="?([^";]+)"?/i)?.[1];
  if (n) { try { return decodeURIComponent(n.trim()); } catch { return n.trim(); } }
  try { const ult = new URL(url).pathname.split('/').pop(); if (/\.\w{2,5}$/.test(ult)) return decodeURIComponent(ult); } catch {}
  return null;
}

async function baixar(link, fetchFn) {
  const { url, drive } = linkDireto(link);
  if (!/^https:\/\//i.test(url)) throw new ErroWhats('O link precisa começar com https://');
  let r;
  try { r = await fetchFn(url, { redirect: 'follow' }); } catch { throw new ErroWhats('Não consegui abrir o link'); }
  const mime = (r.headers.get('content-type') || '').split(';')[0].trim();
  if (!r.ok || mime === 'text/html') {
    throw new ErroWhats(drive
      ? 'Não consegui baixar do Drive. Deixe o arquivo como "Qualquer pessoa com o link" (Compartilhar → Acesso geral) e tente de novo. Arquivos acima de ~100 MB o Drive não libera assim.'
      : `Não consegui baixar o arquivo (${r.ok ? 'o link abre uma página, não um arquivo' : `erro ${r.status}`})`);
  }
  const tam = Number(r.headers.get('content-length') || 0);
  if (tam > LIMITE_MB * 1024 * 1024) throw new ErroWhats(`Arquivo grande demais (máximo ${LIMITE_MB} MB)`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length) throw new ErroWhats('O arquivo veio vazio');
  if (buf.length > LIMITE_MB * 1024 * 1024) throw new ErroWhats(`Arquivo grande demais (máximo ${LIMITE_MB} MB)`);
  return { buf, mime: mime || 'application/octet-stream', nome: nomeDoLink(r, url) };
}

const telDe = jid => (jid.endsWith('@s.whatsapp.net') ? jid.split('@')[0] : null);
const BR = d => (d ? new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }) : null);
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const ignorar = jid => !jid || jid === 'status@broadcast' || jid.endsWith('@newsletter');

function msg(m) {
  return {
    id: m.keyId,
    de: m.fromMe ? 'Thiago' : (m.pushName || 'contato'),
    texto: m.content || null,
    tipo: String(m.type || 'TEXT').toLowerCase(),
    quando: BR(m.timestamp),
    ...(m.fromMe ? { status: String(m.status || '').toLowerCase() } : {}),
  };
}

// ── Definições ───────────────────────────────────────────────────────────────

const CONTATO = { type: 'string', description: 'Telefone com DDD (ex: 14999998888) ou o jid que veio de whatsapp_conversas' };
const leitura = { readOnlyHint: true, openWorldHint: false };
const escrita = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const AVISO_ENVIO = 'ENVIA DE VERDADE pelo WhatsApp de trabalho do Thiago. Antes de chamar, mostre ao Thiago o destinatário e o texto exato e só chame depois que ele confirmar.';

export const WA_TOOLS = [
  {
    name: 'whatsapp_status', title: 'WhatsApp: situação',
    description: 'Se o número de trabalho está conectado no MarcFlow.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: leitura,
  },
  {
    name: 'whatsapp_conversas', title: 'WhatsApp: conversas',
    description: 'Lista as conversas do WhatsApp de trabalho, das mais recentes para as mais antigas, com a última mensagem e quantas estão sem ler. Use "nao_lidas" para só as pendentes e "busca" para achar alguém por nome ou telefone.',
    inputSchema: {
      type: 'object',
      properties: {
        nao_lidas: { type: 'boolean', description: 'Só conversas com mensagens não lidas' },
        busca: { type: 'string', description: 'Trecho do nome ou do telefone' },
        incluir_grupos: { type: 'boolean', description: 'Incluir grupos (padrão: não)' },
        limite: { type: 'integer', minimum: 1, maximum: 200, description: 'Padrão 30' },
      },
      additionalProperties: false,
    },
    annotations: leitura,
  },
  {
    name: 'whatsapp_ler_conversa', title: 'WhatsApp: ler conversa',
    description: 'Mensagens de uma conversa (até as 100 mais recentes), da mais antiga para a mais nova. Cada mensagem tem um "id" que serve para responder citando.',
    inputSchema: {
      type: 'object',
      properties: { contato: CONTATO, limite: { type: 'integer', minimum: 1, maximum: 100, description: 'Quantas das últimas mensagens (padrão 30)' } },
      required: ['contato'], additionalProperties: false,
    },
    annotations: leitura,
  },
  {
    name: 'whatsapp_buscar_mensagens', title: 'WhatsApp: buscar mensagens',
    description: 'Procura um texto em todas as conversas (ou em uma só), das mais novas para as mais antigas.',
    inputSchema: {
      type: 'object',
      properties: {
        texto: { type: 'string', description: 'Trecho a procurar' },
        contato: { ...CONTATO, description: 'Opcional: só nesta conversa' },
        so_recebidas: { type: 'boolean', description: 'Só mensagens que o contato mandou' },
        limite: { type: 'integer', minimum: 1, maximum: 100, description: 'Padrão 20' },
      },
      required: ['texto'], additionalProperties: false,
    },
    annotations: leitura,
  },
  {
    name: 'whatsapp_agendados', title: 'WhatsApp: mensagens agendadas',
    description: 'Mensagens agendadas no MarcFlow (pendentes por padrão).',
    inputSchema: { type: 'object', properties: { todas: { type: 'boolean', description: 'Incluir as já enviadas/falhas' } }, additionalProperties: false },
    annotations: leitura,
  },
  {
    name: 'whatsapp_fluxos', title: 'WhatsApp: fluxos automáticos',
    description: 'Fluxos automáticos do MarcFlow (ex: "Primeiro contato") e, para um fluxo, os contatos que passaram por ele: em andamento, concluídos, cancelados (quando o Thiago assume a conversa) ou com erro.',
    inputSchema: {
      type: 'object',
      properties: { fluxo: { type: 'string', description: 'Opcional: nome (ou parte) do fluxo para ver os contatos dele' }, limite: { type: 'integer', minimum: 1, maximum: 100, description: 'Padrão 30' } },
      additionalProperties: false,
    },
    annotations: leitura,
  },
  {
    name: 'whatsapp_enviar', title: 'WhatsApp: enviar mensagem',
    description: `Envia uma mensagem de texto agora. Com "responder_id" (o id de uma mensagem de whatsapp_ler_conversa) sai como resposta citando a mensagem. Responder manualmente encerra o fluxo automático que estiver rodando com esse contato. ${AVISO_ENVIO}`,
    inputSchema: {
      type: 'object',
      properties: {
        contato: CONTATO,
        texto: { type: 'string', description: 'Texto exato a enviar' },
        responder_id: { type: 'string', description: 'Opcional: id da mensagem a citar' },
      },
      required: ['contato', 'texto'], additionalProperties: false,
    },
    annotations: escrita,
  },
  {
    name: 'whatsapp_enviar_arquivo', title: 'WhatsApp: enviar arquivo',
    description: `Envia um arquivo (PDF, planilha, foto, vídeo, áudio) a partir de um link. Aceita link de compartilhamento do Google Drive (o arquivo precisa estar como "Qualquer pessoa com o link"), Google Docs/Planilhas/Apresentações (vão como PDF) ou qualquer link https direto para o arquivo. Máximo ${LIMITE_MB} MB. Arquivo anexado no chat não serve: precisa de um link. Foto e vídeo vão como mídia; o resto vai como documento. ${AVISO_ENVIO.replace('o texto exato', 'o arquivo (nome) e a legenda')}`,
    inputSchema: {
      type: 'object',
      properties: {
        contato: CONTATO,
        link: { type: 'string', description: 'Link do arquivo (Drive, Docs ou https direto)' },
        nome_arquivo: { type: 'string', description: 'Opcional: nome que aparece no WhatsApp, com extensão (ex: Treino Andressa.pdf). Padrão: o nome original' },
        legenda: { type: 'string', description: 'Opcional: texto que vai junto com o arquivo' },
        como: { type: 'string', enum: ['auto', 'documento', 'midia'], description: 'auto (padrão): foto/vídeo como mídia, resto como documento. documento: sempre como arquivo (foto sem compressão)' },
      },
      required: ['contato', 'link'], additionalProperties: false,
    },
    annotations: escrita,
  },
  {
    name: 'whatsapp_agendar', title: 'WhatsApp: agendar mensagem',
    description: `Agenda uma mensagem de texto para um horário (de Brasília). O MarcFlow envia sozinho. ${AVISO_ENVIO}`,
    inputSchema: {
      type: 'object',
      properties: {
        contato: CONTATO,
        texto: { type: 'string', description: 'Texto exato a enviar' },
        quando: { type: 'string', description: 'Data e hora de Brasília no formato YYYY-MM-DDTHH:mm, ex: 2026-11-20T09:00' },
      },
      required: ['contato', 'texto', 'quando'], additionalProperties: false,
    },
    annotations: escrita,
  },
  {
    name: 'whatsapp_cancelar_agendamento', title: 'WhatsApp: cancelar agendamento',
    description: 'Apaga uma mensagem agendada que ainda não foi enviada (id de whatsapp_agendados). Confirme com o Thiago antes.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'whatsapp_marcar_lida', title: 'WhatsApp: marcar como lida',
    description: 'Marca a conversa como lida (o contato vê os tiques azuis). Tira a conversa do card de mensagens da Central.',
    inputSchema: { type: 'object', properties: { contato: CONTATO }, required: ['contato'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
];

export const WA_NOMES = new Set(WA_TOOLS.map(t => t.name));

// ── Execução ─────────────────────────────────────────────────────────────────

export async function executarWhatsapp(nome, args = {}, { fetchFn = fetch, agora = new Date() } = {}) {
  const o = { fetchFn };
  switch (nome) {
    case 'whatsapp_status': {
      const j = await api('/sessions', o);
      const s = (j.data || []).find(x => encodeURIComponent(x.sessionId) === config().sessao);
      const st = String(s?.status || 'desconhecido').toUpperCase();
      return { conectado: st === 'CONNECTED', status: st };
    }
    case 'whatsapp_conversas': {
      const j = await api('/chat/{s}', o);
      const q = norm(args.busca).replace(/\D/g, '') || null, qn = norm(args.busca).trim();
      let lista = (j.data || []).filter(c => !ignorar(c.jid) && (args.incluir_grupos || !c.jid.endsWith('@g.us')));
      if (args.nao_lidas) lista = lista.filter(c => (c.unreadCount || 0) > 0);
      if (qn) lista = lista.filter(c => norm(`${c.name || ''} ${c.notify || ''}`).includes(qn) || (q && c.jid.includes(q)));
      const limite = Math.min(200, Math.max(1, Number(args.limite) || 30));
      return {
        total: lista.length,
        conversas: lista.slice(0, limite).map(c => ({
          jid: c.jid, nome: c.name || c.notify || null, telefone: telDe(c.jid),
          nao_lidas: c.unreadCount || 0,
          ultima: c.lastMessage ? { texto: (c.lastMessage.content || '').slice(0, 200) || null, tipo: String(c.lastMessage.type || '').toLowerCase() || null, quando: BR(c.lastMessage.timestamp) } : null,
        })),
      };
    }
    case 'whatsapp_ler_conversa': {
      const jid = alvo(args);
      const j = await api(`/chat/{s}/${encodeURIComponent(jid)}`, o);
      const limite = Math.min(100, Math.max(1, Number(args.limite) || 30));
      const msgs = (j.data || []).slice(-limite);
      return { jid, telefone: telDe(jid), mensagens: msgs.map(msg), aviso: msgs.length ? undefined : 'Nenhuma mensagem guardada para esse contato' };
    }
    case 'whatsapp_buscar_mensagens': {
      const t = String(args.texto || '').trim();
      if (!t) throw new ErroWhats('"texto" vazio');
      const p = new URLSearchParams({ q: t, limit: String(Math.min(100, Math.max(1, Number(args.limite) || 20))) });
      if (args.contato) p.set('jid', alvo(args));
      if (args.so_recebidas) p.set('fromMe', 'false');
      const j = await api(`/messages/{s}/search?${p}`, o);
      return {
        total: j.pagination?.total ?? (j.data || []).length,
        mensagens: (j.data || []).map(m => ({ ...msg(m), jid: m.remoteJid, contato: m.contract?.name || m.contract?.notify || telDe(m.remoteJid) })),
      };
    }
    case 'whatsapp_agendados': {
      const j = await api('/scheduler/{s}', o);
      const lista = (j.data || []).filter(m => args.todas || String(m.status).toUpperCase() === 'PENDING');
      return { agendados: lista.map(m => ({ id: m.id, jid: m.jid, telefone: telDe(m.jid), texto: m.content, quando: BR(m.sendAt), status: String(m.status).toLowerCase(), recorrente: !!m.cronExpression })) };
    }
    case 'whatsapp_fluxos': {
      const fluxos = (await api('/flows/{s}', o)).data || [];
      const base = fluxos.map(f => ({ id: f.id, nome: f.name, status: f.status }));
      if (!args.fluxo) return { fluxos: base };
      const f = fluxos.find(x => norm(x.name).includes(norm(args.fluxo).trim()));
      if (!f) return { fluxos: base, erro: `Nenhum fluxo com "${args.fluxo}"` };
      const runs = ((await api(`/flows/{s}/${encodeURIComponent(f.id)}/runs`, o)).data || []).filter(r => !r.isTest);
      const limite = Math.min(100, Math.max(1, Number(args.limite) || 30));
      return {
        fluxo: f.name,
        contatos: runs.slice(0, limite).map(r => ({
          jid: r.contactJid, telefone: telDe(r.contactJid), nome: r.contactName || null,
          situacao: { RUNNING: 'em andamento', WAITING_INPUT: 'esperando resposta', WAITING_DELAY: 'esperando para mandar a próxima', COMPLETED: 'concluído', CANCELLED: 'encerrado (Thiago assumiu a conversa)', FAILED: 'erro', EXPIRED: 'expirou' }[r.status] || String(r.status).toLowerCase(),
          etapa: r.currentNodeId || null, retoma_em: BR(r.resumeAt), inicio: BR(r.startedAt), atualizado: BR(r.updatedAt), erro: r.error || undefined,
        })),
      };
    }
    case 'whatsapp_enviar': {
      const jid = alvo(args), texto = String(args.texto || '').trim();
      if (!texto) throw new ErroWhats('"texto" vazio');
      const body = args.responder_id ? { messageId: String(args.responder_id), message: { text: texto } } : { message: { text: texto } };
      await api(`/messages/{s}/${encodeURIComponent(jid)}/${args.responder_id ? 'reply' : 'send'}`, { ...o, method: 'POST', body });
      return { enviado: true, para: telDe(jid) || jid, texto };
    }
    case 'whatsapp_enviar_arquivo': {
      const jid = alvo(args);
      if (!args.link) throw new ErroWhats('Informe o "link" do arquivo');
      const arq = await baixar(args.link, fetchFn);
      let nome = String(args.nome_arquivo || '').trim() || arq.nome || 'arquivo';
      if (!/\.\w{2,5}$/.test(nome) && arq.nome?.includes('.')) nome += '.' + arq.nome.split('.').pop();
      const tipo = args.como === 'documento' ? 'document' : tipoDe(arq.mime, nome);
      const form = new FormData();
      form.append('file', new Blob([arq.buf], { type: arq.mime }), nome);
      form.append('type', tipo);
      if (args.legenda) form.append('caption', String(args.legenda));
      await api(`/messages/{s}/${encodeURIComponent(jid)}/media`, { ...o, method: 'POST', form });
      return { enviado: true, para: telDe(jid) || jid, arquivo: nome, como: { image: 'foto', video: 'vídeo', audio: 'áudio', document: 'documento' }[tipo], tamanho_kb: Math.round(arq.buf.length / 1024), legenda: args.legenda || null };
    }
    case 'whatsapp_agendar': {
      const jid = alvo(args), texto = String(args.texto || '').trim();
      if (!texto) throw new ErroWhats('"texto" vazio');
      const m = String(args.quando || '').match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})$/);
      if (!m) throw new ErroWhats('"quando" deve ser YYYY-MM-DDTHH:mm (horário de Brasília)');
      const quando = `${m[1]}T${m[2]}`;
      if (quando <= horaBR(agora)) throw new ErroWhats('Esse horário já passou');
      const j = await api('/scheduler/{s}', { ...o, method: 'POST', body: { jid, content: texto, sendAt: quando } });
      return { agendado: true, id: j.data?.id, para: telDe(jid) || jid, quando: quando.replace('T', ' '), texto };
    }
    case 'whatsapp_cancelar_agendamento': {
      if (!args.id) throw new ErroWhats('Informe o "id"');
      await api(`/scheduler/{s}/${encodeURIComponent(args.id)}`, { ...o, method: 'DELETE' });
      return { cancelado: true, id: args.id };
    }
    case 'whatsapp_marcar_lida': {
      const jid = alvo(args);
      await api(`/chat/{s}/${encodeURIComponent(jid)}/read`, { ...o, method: 'PUT', body: {} });
      return { lida: true, jid };
    }
    default:
      throw new ErroWhats(`Ferramenta desconhecida: ${nome}`);
  }
}
