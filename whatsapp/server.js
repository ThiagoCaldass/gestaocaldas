// =====================================================================
//  SERVIDOR WHATSAPP — Gestor Caldas
//  Rode: npm start
//  O site chama https://localhost:3001/ para enviar mensagens.
// =====================================================================

const express  = require('express');
const cors     = require('cors');
const qrcode   = require('qrcode');
const path     = require('path');
const https    = require('https');
const fs       = require('fs');
const { Client, LocalAuth } = require('whatsapp-web.js');

const app  = express();
const PORT = 3001;

// Certificado mkcert (gerado com: mkcert localhost)
const sslOptions = {
  key:  fs.readFileSync(path.join(__dirname, 'localhost-key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'localhost.pem')),
};

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

// Serve o site principal (resolve o bloqueio de mixed content HTTPS→HTTP)
const SITE_PATH = path.resolve(__dirname, '..');
app.use(express.static(SITE_PATH));
app.get('/', (req, res) => {
  res.sendFile(path.join(SITE_PATH, 'index.html'));
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
https.createServer(sslOptions, app).listen(PORT, () => {
  console.log(`\n🤖 Servidor Gestor Caldas WhatsApp`);
  console.log(`   Rodando em https://localhost:${PORT}`);
  console.log(`   Iniciando WhatsApp...\n`);
  initClient();
});
