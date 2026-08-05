// =====================================================================
//  SERVIDOR WHATSAPP — Gestor Caldas
//  Rode: npm start
//  O site chama http://localhost:3001/ para enviar mensagens.
// =====================================================================

const express  = require('express');
const cors     = require('cors');
const qrcode   = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

const app  = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// ── Estado global ────────────────────────────────────────────────────
let waStatus  = 'iniciando';   // iniciando | qr | conectado | desconectado
let waQR      = null;          // data-URL do QR code (PNG base64)
let waClient  = null;

let job = {
  running: false,
  total:   0,
  results: [],   // { nome, status, msg? }
  done:    false,
};

// ── Cliente WhatsApp ─────────────────────────────────────────────────
// Caminho do Chrome for Testing (versão 148 — funcional no cache local)
const CHROME_PATH = '/Users/thiagocaldas/.cache/puppeteer/chrome/mac_arm-148.0.7778.97/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

function initClient() {
  waClient = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
    puppeteer: {
      headless: true,
      executablePath: CHROME_PATH,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  });

  waClient.on('qr', async (qr) => {
    waStatus = 'qr';
    waQR = await qrcode.toDataURL(qr);
    console.log('\n📱 QR gerado — abra o site e escaneie pela interface.\n');
  });

  waClient.on('ready', () => {
    waStatus = 'conectado';
    waQR = null;
    console.log('✅ WhatsApp conectado! O site pode enviar mensagens.\n');
  });

  waClient.on('auth_failure', () => {
    waStatus = 'desconectado';
    console.error('❌ Falha de autenticação.');
  });

  waClient.on('disconnected', () => {
    waStatus = 'desconectado';
    waQR = null;
    console.log('⚠️  WhatsApp desconectado. Reconectando em 5s...');
    setTimeout(initClient, 5000);
  });

  waClient.initialize();
}

// ── Rotas da API ─────────────────────────────────────────────────────

// Página de status (acesso direto pelo browser)
app.get('/', (req, res) => {
  const icons = { iniciando:'⏳', qr:'📱', conectado:'✅', desconectado:'🔴' };
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>WA Gestor Caldas</title>
    <style>body{font-family:sans-serif;background:#111;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
    .box{text-align:center;padding:40px;background:#1a1a1a;border-radius:16px;border:1px solid #333}
    h2{margin:0 0 8px}p{color:#888;margin:0 0 24px}code{background:#222;padding:4px 10px;border-radius:6px;font-size:14px}</style></head>
    <body><div class="box">
      <div style="font-size:48px">${icons[waStatus]||'⏳'}</div>
      <h2>Servidor WhatsApp</h2>
      <p>Status: <strong style="color:#${waStatus==='conectado'?'22c55e':waStatus==='qr'?'f59e0b':'ef4444'}">${waStatus}</strong></p>
      <p>Este servidor é usado pelo site Gestor Caldas.<br>Abra o site normalmente e clique em 📲 WA.</p>
      <code>http://localhost:3001/status</code>
    </div></body></html>`);
});

// Status e QR code
app.get('/status', (req, res) => {
  res.json({ status: waStatus, qr: waQR });
});

// Inicia um disparo
app.post('/send', async (req, res) => {
  if (waStatus !== 'conectado') {
    return res.status(400).json({ erro: 'WhatsApp não conectado' });
  }
  if (job.running) {
    return res.status(400).json({ erro: 'Já há um envio em andamento' });
  }

  const {
    contatos   = [],
    mensagens  = [],
    intervaloMin = 8,
    intervaloMax = 30,
  } = req.body;

  if (!contatos.length || !mensagens.length) {
    return res.status(400).json({ erro: 'Contatos ou mensagens vazios' });
  }

  // Responde imediatamente — envio roda em background
  job = { running: true, total: contatos.length, results: [], done: false };
  res.json({ ok: true, total: contatos.length });

  (async () => {
    const dormir = ms => new Promise(r => setTimeout(r, ms));

    for (let i = 0; i < contatos.length; i++) {
      const { nome, telefone } = contatos[i];
      const tel = (telefone || '').replace(/\D/g, '');
      const id  = (tel.startsWith('55') ? tel : '55' + tel) + '@c.us';
      const msg = mensagens[Math.floor(Math.random() * mensagens.length)]
                    .replace(/\{nome\}/g, nome);

      try {
        const registrado = await waClient.isRegisteredUser(id);
        if (!registrado) {
          console.log(`[${i+1}/${contatos.length}] ${nome} — ⚠️  sem WhatsApp`);
          job.results.push({ nome, status: 'sem_whatsapp' });
          continue;
        }
        await waClient.sendMessage(id, msg);
        console.log(`[${i+1}/${contatos.length}] ${nome} — ✅ enviado`);
        job.results.push({ nome, status: 'enviado', msg });
      } catch (e) {
        console.log(`[${i+1}/${contatos.length}] ${nome} — ❌ erro: ${e.message}`);
        job.results.push({ nome, status: 'erro', erro: e.message });
      }

      if (i < contatos.length - 1) {
        const s = Math.floor(Math.random() * (intervaloMax - intervaloMin + 1)) + intervaloMin;
        console.log(`   ⏳ aguardando ${s}s...\n`);
        await dormir(s * 1000);
      }
    }

    job.running = false;
    job.done    = true;
    console.log('\n✔️  Envio concluído.\n');
  })();
});

// Progresso do envio atual
app.get('/send-status', (req, res) => {
  res.json({
    running: job.running,
    total:   job.total,
    done:    job.done,
    results: job.results,
  });
});

// ── Inicia ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🤖 Servidor Gestor Caldas WhatsApp`);
  console.log(`   Rodando em http://localhost:${PORT}`);
  console.log(`   Iniciando WhatsApp...\n`);
  initClient();
});
