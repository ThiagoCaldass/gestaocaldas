// =====================================================================
//  SERVIDOR WHATSAPP — Gestor Caldas  (Baileys v6 — sem Chrome)
//  Local:  npm start
//  Cloud:  deploy no Render.com (veja README)
// =====================================================================

import path from 'path';
import fs from 'fs';
import express from 'express';
import cors from 'cors';
import qrcode from 'qrcode';
import { fileURLToPath } from 'url';
import {
  makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3001;
const IS_RENDER = !!process.env.RENDER;

app.use(cors());
app.use(express.json());

// ── Estado global ─────────────────────────────────────────────────────
let waStatus = 'iniciando';   // iniciando | qr | conectado | reconectando | desconectado | pausado
let waQR     = null;
let sock     = null;
let autoReplies = [];
let job = { running: false, total: 0, results: [], done: false };
let isPaused = false;  // desconectado intencionalmente — não reconecta automaticamente

const AUTH_DIR = path.join(__dirname, 'wa_auth');

// Logger silencioso (evita flood de pino no console)
const logger = {
  level: 'silent',
  trace(){}, debug(){}, info(){}, warn(){},
  error(o, m){ console.error('[WA]', m||o); },
  fatal(){}, child(){ return logger; },
};

// ── Supabase — persiste sessão entre deploys ──────────────────────────
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_KEY;

async function sbFetch(path, opts = {}) {
  if (!SB_URL || !SB_KEY) return null;
  return fetch(`${SB_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      ...opts.headers,
    },
  });
}

async function saveSessionToSupabase() {
  if (!SB_URL || !SB_KEY) return;
  try {
    if (!fs.existsSync(AUTH_DIR)) return;
    const files = {};
    fs.readdirSync(AUTH_DIR).forEach(f => {
      try { files[f] = fs.readFileSync(path.join(AUTH_DIR, f), 'utf8'); } catch {}
    });
    if (!Object.keys(files).length) return;
    const res = await sbFetch('wa_session', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ id: 'main', data: files, updated_at: new Date().toISOString() }),
    });
    if (res && !res.ok) {
      const txt = await res.text();
      console.error(`❌ Supabase save HTTP ${res.status}:`, txt);
    } else {
      console.log('💾 Sessão salva no Supabase');
    }
  } catch (e) { console.error('❌ Supabase save:', e.message); }
}

async function loadSessionFromSupabase() {
  if (!SB_URL || !SB_KEY) { console.log('⚠️  Supabase não configurado — sem persistência de sessão'); return; }
  try {
    const r = await sbFetch('wa_session?id=eq.main&select=data');
    if (!r.ok) { console.error(`❌ Supabase load HTTP ${r.status}:`, await r.text()); return; }
    const rows = await r.json();
    if (!rows?.length || !rows[0].data) { console.log('ℹ️  Nenhuma sessão no Supabase — aguardando QR'); return; }
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
    Object.entries(rows[0].data).forEach(([name, content]) => {
      fs.writeFileSync(path.join(AUTH_DIR, name), content);
    });
    console.log(`✅ Sessão restaurada do Supabase (${Object.keys(rows[0].data).length} arquivo(s))`);
  } catch (e) { console.error('❌ Supabase load:', e.message); }
}

// ── Cliente WhatsApp ──────────────────────────────────────────────────
async function initClient() {
  await loadSessionFromSupabase();
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: true,
    markOnlineOnConnect: false,   // não transmite "online" → celular recebe notificações normalmente
    syncFullHistory: false,       // não sincroniza histórico antigo ao conectar
  });

  sock.ev.on('creds.update', async () => {
    await saveCreds();
    await saveSessionToSupabase();
  });

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      waStatus = 'qr';
      waQR = await qrcode.toDataURL(qr);
      console.log('\n📱 QR gerado — escaneie pelo site\n');
    }
    if (connection === 'open') {
      waStatus = 'conectado';
      waQR = null;
      console.log('✅ WhatsApp conectado!\n');
      // Volta para "offline" imediatamente — evita suprimir notificações no celular
      try { await sock.sendPresenceUpdate('unavailable'); } catch {}
    }
    if (connection === 'close') {
      waQR = null;
      if (isPaused) {
        waStatus = 'pausado';
        console.log('⏸️  Conexão pausada — celular recebe notificações normalmente');
        return;
      }
      const code = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode : 0;
      const retry = code !== DisconnectReason.loggedOut;
      waStatus = retry ? 'reconectando' : 'desconectado';
      if (retry) {
        console.log('⚠️  Desconectado. Reconectando em 5s...');
        setTimeout(initClient, 5000);
      } else {
        console.log('⚠️  Sessão encerrada (logout). Limpando e gerando novo QR em 3s...');
        // Apaga arquivos locais de autenticação
        try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch {}
        // Apaga sessão do Supabase (estava inválida de qualquer forma)
        try { await sbFetch('wa_session?id=eq.main', { method: 'DELETE' }); } catch {}
        setTimeout(initClient, 3000);
      }
    }
  });

  // Auto-respostas
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' || !autoReplies.length) return;
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const texto = (
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text || ''
      ).toLowerCase().trim();
      if (!texto) continue;

      const regra = autoReplies.find(r =>
        r.palavras?.some(p => texto.includes(p.toLowerCase()))
      );
      if (!regra?.resposta) continue;

      try {
        const nome = msg.pushName || 'você';
        const resposta = regra.resposta.replace(/\{nome\}/g, nome);
        await sock.sendMessage(msg.key.remoteJid, { text: resposta });
        try { await sock.sendPresenceUpdate('unavailable'); } catch {}
        console.log(`🤖 Auto-resposta → ${nome}: "${texto.slice(0,40)}"`);
      } catch (e) { console.error('❌ Auto-resposta:', e.message); }
    }
  });
}

// ── Serve site local (quando rodando no Mac) ──────────────────────────
const SITE = path.resolve(__dirname, '..');
if (!IS_RENDER && fs.existsSync(path.join(SITE, 'index.html'))) {
  app.use(express.static(SITE));
}

// Página de status com QR — acessível em qualquer ambiente
app.get('/', (req, res) => {
  const icons = { iniciando:'⏳', qr:'📱', conectado:'✅', reconectando:'🔄', desconectado:'🔴', pausado:'⏸️' };
  const cor   = waStatus === 'conectado' ? '#22c55e' : waStatus === 'qr' ? '#f59e0b' : waStatus === 'pausado' ? '#888' : '#ef4444';
  const qrHtml = waQR
    ? `<img src="${waQR}" style="width:220px;height:220px;border-radius:12px;background:#fff;padding:10px;margin:16px 0"><p style="color:#aaa;font-size:13px">WhatsApp → Aparelhos conectados → Conectar aparelho</p>`
    : '';
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>WA Gestor Caldas</title>
    <meta http-equiv="refresh" content="5">
    <style>*{box-sizing:border-box}body{margin:0;background:#111;color:#eee;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
    .box{text-align:center;padding:32px 40px;background:#1a1a1a;border-radius:16px;border:1px solid #333;max-width:400px;width:100%}
    h2{margin:8px 0 4px}p{color:#888;margin:4px 0 0}</style></head>
    <body><div class="box">
      <div style="font-size:48px">${icons[waStatus]||'⏳'}</div>
      <h2>WhatsApp — Gestor Caldas</h2>
      <p>Status: <strong style="color:${cor}">${waStatus}</strong></p>
      ${qrHtml}
      ${!waQR && waStatus !== 'qr' ? '<p style="margin-top:16px;font-size:13px">Página atualiza automaticamente a cada 5s</p>' : ''}
    </div></body></html>`);
});

// ── Rotas da API ──────────────────────────────────────────────────────

app.get('/status', (req, res) => res.json({ status: waStatus, qr: waQR }));

app.post('/send', async (req, res) => {
  if (waStatus !== 'conectado') return res.status(400).json({ erro: 'WhatsApp não conectado' });
  if (job.running)              return res.status(400).json({ erro: 'Já há um envio em andamento' });
  const { contatos = [], mensagens = [], intervaloMin = 8, intervaloMax = 30 } = req.body;
  if (!contatos.length || !mensagens.length) return res.status(400).json({ erro: 'Contatos ou mensagens vazios' });

  job = { running: true, total: contatos.length, results: [], done: false };
  res.json({ ok: true, total: contatos.length });

  (async () => {
    const dormir = ms => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < contatos.length; i++) {
      const { nome, telefone } = contatos[i];
      const tel = (telefone || '').replace(/\D/g, '');
      const num = tel.startsWith('55') ? tel : '55' + tel;
      const jid = num + '@s.whatsapp.net';
      const msg = mensagens[Math.floor(Math.random() * mensagens.length)].replace(/\{nome\}/g, nome);

      try {
        const [info] = await sock.onWhatsApp(num);
        if (!info?.exists) {
          console.log(`[${i+1}/${contatos.length}] ${nome} — ⚠️  sem WhatsApp`);
          job.results.push({ nome, status: 'sem_whatsapp' });
        } else {
          await sock.sendMessage(jid, { text: msg });
          try { await sock.sendPresenceUpdate('unavailable'); } catch {}
          console.log(`[${i+1}/${contatos.length}] ${nome} — ✅ enviado`);
          job.results.push({ nome, status: 'enviado' });
        }
      } catch (e) {
        console.log(`[${i+1}/${contatos.length}] ${nome} — ❌ ${e.message}`);
        job.results.push({ nome, status: 'erro', erro: e.message });
      }

      if (i < contatos.length - 1) {
        const s = Math.floor(Math.random() * (intervaloMax - intervaloMin + 1)) + intervaloMin;
        console.log(`   ⏳ aguardando ${s}s...`);
        await dormir(s * 1000);
      }
    }
    job.running = false;
    job.done = true;
    console.log('\n✔️  Envio concluído.\n');
  })();
});

app.get('/send-status', (req, res) =>
  res.json({ running: job.running, total: job.total, done: job.done, results: job.results })
);

// Pausa conexão (socket fecha, celular volta a receber notificações)
app.post('/pause', (req, res) => {
  isPaused = true;
  waStatus = 'pausado';
  if (sock) { try { sock.end(new Error('paused')); } catch {} }
  console.log('⏸️  Pausado pelo usuário');
  res.json({ ok: true, status: 'pausado' });
});

// Retoma conexão
app.post('/resume', async (req, res) => {
  if (!isPaused) return res.json({ ok: true, status: waStatus });
  isPaused = false;
  waStatus = 'iniciando';
  console.log('▶️  Retomando conexão...');
  res.json({ ok: true, status: 'iniciando' });
  await initClient();
});

app.get('/autoreplies', (req, res) => res.json({ regras: autoReplies }));
app.post('/autoreplies', (req, res) => {
  autoReplies = req.body.regras || [];
  console.log(`🤖 Auto-respostas: ${autoReplies.length} regra(s) ativa(s)`);
  res.json({ ok: true });
});

// ── Inicia ────────────────────────────────────────────────────────────
async function start() {
  console.log('\n🤖 Servidor WhatsApp — Gestor Caldas');

  if (!IS_RENDER && fs.existsSync(path.join(__dirname, 'localhost.pem'))) {
    // HTTPS local (mkcert)
    const { default: https } = await import('https');
    const opts = {
      key:  fs.readFileSync(path.join(__dirname, 'localhost-key.pem')),
      cert: fs.readFileSync(path.join(__dirname, 'localhost.pem')),
    };
    https.createServer(opts, app).listen(PORT, () => {
      console.log(`   https://localhost:${PORT}\n`);
    });
  } else {
    // HTTP — Render termina o TLS antes de chegar aqui
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`   http://0.0.0.0:${PORT}\n`);
    });
  }

  await initClient();
}

start();
