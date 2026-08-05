// =====================================================================
//  ROBÔ DE ENVIO WHATSAPP  —  uso pessoal, envio pontual
//  ---------------------------------------------------------------------
//  - Lê contatos de contatos.csv (colunas: nome, telefone)
//  - Sorteia uma versão de mensagem de mensagens.js para cada pessoa
//  - Personaliza com {nome}
//  - Envia com intervalo ALEATÓRIO entre cada contato (reduz cara de robô)
//  - Gera um log em resultado.csv (enviado / erro)
//
//  MODO TESTE: rode com "node enviar.js --teste" para ver o que SERIA
//  enviado, sem disparar nada de verdade. Sempre teste antes.
// =====================================================================

const fs = require("fs");
const path = require("path");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const versoes = require("./mensagens");

// ----------------------- CONFIGURAÇÕES -------------------------------
const CONFIG = {
  arquivoContatos: "contatos.csv",
  codigoPais: "55",          // Brasil = 55. Coloque o DDI dos seus contatos.
  intervaloMinSegundos: 8,   // espera mínima entre um envio e outro
  intervaloMaxSegundos: 40,  // espera máxima entre um envio e outro
};
// ---------------------------------------------------------------------

const MODO_TESTE = process.argv.includes("--teste");

// Lê o CSV de forma simples (nome,telefone). Ignora cabeçalho e linhas vazias.
function lerContatos(arquivo) {
  const caminho = path.join(__dirname, arquivo);
  if (!fs.existsSync(caminho)) {
    console.error(`\n❌ Arquivo "${arquivo}" não encontrado. Crie-o com as colunas: nome,telefone\n`);
    process.exit(1);
  }
  const linhas = fs.readFileSync(caminho, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "");
  const contatos = [];
  linhas.forEach((linha, i) => {
    if (i === 0 && /nome/i.test(linha) && /telefone/i.test(linha)) return; // pula cabeçalho
    const [nome, telefone] = linha.split(",").map((c) => (c || "").trim());
    if (!telefone) return;
    contatos.push({ nome: nome || "", telefone });
  });
  return contatos;
}

// Monta o ID do WhatsApp: só dígitos, com DDI na frente. Ex: 5511987654321@c.us
function montarId(telefone) {
  let numero = telefone.replace(/\D/g, ""); // remove tudo que não é dígito
  if (!numero.startsWith(CONFIG.codigoPais)) {
    numero = CONFIG.codigoPais + numero;
  }
  return `${numero}@c.us`;
}

function sorteioVersao(nome) {
  const texto = versoes[Math.floor(Math.random() * versoes.length)];
  return texto.replace(/\{nome\}/g, nome);
}

function esperaAleatoria() {
  const min = CONFIG.intervaloMinSegundos;
  const max = CONFIG.intervaloMaxSegundos;
  const segundos = Math.floor(Math.random() * (max - min + 1)) + min;
  return segundos;
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function enviarTodos(client) {
  const contatos = lerContatos(CONFIG.arquivoContatos);
  if (contatos.length === 0) {
    console.error("\n❌ Nenhum contato válido no CSV.\n");
    process.exit(1);
  }

  console.log(`\n📋 ${contatos.length} contato(s) carregado(s).`);
  console.log(MODO_TESTE ? "🧪 MODO TESTE — nada será enviado de verdade.\n" : "🚀 Iniciando envios...\n");

  const resultado = [["nome", "telefone", "status", "mensagem"]];

  for (let i = 0; i < contatos.length; i++) {
    const { nome, telefone } = contatos[i];
    const id = montarId(telefone);
    const mensagem = sorteioVersao(nome);
    const prefixo = `[${i + 1}/${contatos.length}] ${nome || telefone}`;

    if (MODO_TESTE) {
      console.log(`${prefixo}  →  ${id}`);
      console.log(`   "${mensagem.replace(/\n/g, " / ")}"\n`);
      resultado.push([nome, telefone, "teste", mensagem.replace(/\n/g, " ")]);
      continue;
    }

    try {
      // Confere se o número tem WhatsApp antes de enviar
      const registrado = await client.isRegisteredUser(id);
      if (!registrado) {
        console.log(`${prefixo}  ⚠️  número sem WhatsApp — pulado.`);
        resultado.push([nome, telefone, "sem_whatsapp", ""]);
        continue;
      }

      await client.sendMessage(id, mensagem);
      console.log(`${prefixo}  ✅ enviado.`);
      resultado.push([nome, telefone, "enviado", mensagem.replace(/\n/g, " ")]);
    } catch (err) {
      console.log(`${prefixo}  ❌ erro: ${err.message}`);
      resultado.push([nome, telefone, "erro", err.message]);
    }

    // Espera aleatória antes do próximo (menos no último)
    if (i < contatos.length - 1) {
      const s = esperaAleatoria();
      console.log(`   ⏳ aguardando ${s}s...\n`);
      await dormir(s * 1000);
    }
  }

  // Salva log
  const csv = resultado.map((l) => l.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  fs.writeFileSync(path.join(__dirname, "resultado.csv"), csv, "utf8");
  console.log(`\n📝 Log salvo em resultado.csv`);
  console.log("✔️  Concluído.\n");
}

// --------------------------- MODO TESTE ------------------------------
// No modo teste não precisa nem abrir o WhatsApp — só mostra o preview.
if (MODO_TESTE) {
  enviarTodos(null).then(() => process.exit(0));
} else {
  // ------------------------ CLIENTE WHATSAPP -------------------------
  const client = new Client({
    authStrategy: new LocalAuth(), // salva a sessão: só escaneia o QR uma vez
    puppeteer: { headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] },
  });

  client.on("qr", (qr) => {
    console.log("\n📱 Abra o WhatsApp > Aparelhos conectados > Conectar aparelho e escaneie:\n");
    qrcode.generate(qr, { small: true });
  });

  client.on("ready", async () => {
    console.log("\n✅ WhatsApp conectado!");
    await enviarTodos(client);
    await client.destroy();
    process.exit(0);
  });

  client.on("auth_failure", (m) => console.error("❌ Falha de autenticação:", m));

  client.initialize();
}
