# Robô de WhatsApp — envio pessoal

Envia mensagens **personalizadas** (com o nome de cada pessoa) para uma lista de
contatos, sorteando entre **várias versões de texto** e com **intervalos
aleatórios** entre um envio e outro. Roda no seu computador, de graça.

---

## 1. Instalar o Node.js (uma vez só)

Se ainda não tem, baixe em https://nodejs.org (versão LTS). Para conferir, abra o
Terminal e rode:

```
node -v
```

## 2. Instalar as dependências (uma vez só)

Coloque todos os arquivos numa pasta, abra o Terminal **dentro dessa pasta** e rode:

```
npm install
```

Isso baixa a biblioteca do WhatsApp (inclui um navegador interno — pode demorar
alguns minutos na primeira vez).

## 3. Preencher seus contatos

Abra `contatos.csv` (no Excel ou bloco de notas) e substitua pelos seus contatos.
Duas colunas: **nome** e **telefone**. O telefone pode ter espaços/parênteses,
o script limpa sozinho. Não precisa colocar o +55; ele já é adicionado
automaticamente (ajustável em `enviar.js`, campo `codigoPais`).

```
nome,telefone
Maria,11987654321
João,21991234567
```

## 4. Escrever suas mensagens

Abra `mensagens.js` e edite as versões. Use `{nome}` onde quiser o nome da pessoa.
Quanto mais versões diferentes, melhor (varia o texto e reduz cara de robô).

## 5. TESTAR antes (não envia nada)

**Sempre faça isso primeiro.** Mostra exatamente o que seria enviado para cada um:

```
npm run teste
```

## 6. Enviar de verdade

```
npm start
```

Na **primeira vez**, vai aparecer um QR Code no Terminal. No celular:
WhatsApp → Configurações → **Aparelhos conectados** → **Conectar um aparelho** →
escaneie o QR. A sessão fica salva, então nas próximas vezes não precisa escanear
de novo.

Ao final, um arquivo `resultado.csv` é gerado com o status de cada envio
(enviado / erro / sem_whatsapp).

---

## Ajustes rápidos (no topo do `enviar.js`)

- `codigoPais`: DDI dos contatos (`55` = Brasil).
- `intervaloMinSegundos` / `intervaloMaxSegundos`: faixa de espera entre envios.
  Deixar mais espaçado (ex: 15–60) é mais seguro.

---

## Avisos importantes

- Isso usa uma biblioteca **não-oficial** do WhatsApp. Funciona bem em volume
  baixo, mas **existe risco de bloqueio** do número — não há como zerar esse risco.
- Reduza o risco: use um **número secundário**, mantenha **muitas versões** de
  texto, intervalos **espaçados e aleatórios**, e **não** dispare para quem não
  te conhece (a denúncia de quem recebe é o que mais causa bloqueio).
- Mantenha a pasta `.wwebjs_auth` (criada automaticamente) — é a sua sessão salva.
```
