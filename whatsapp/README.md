# Servidor WhatsApp — Gestor Caldas

Servidor Node.js usando **Baileys** (sem Chrome, ~80MB RAM).

---

## 1. Rodar localmente

```bash
npm install
npm start
```

Acesse `https://localhost:3001` no Safari e escaneie o QR pelo site.

---

## 2. Deploy na nuvem (Render.com — gratuito)

### 2a. Criar tabela no Supabase

No SQL Editor do seu projeto Supabase, rode:

```sql
CREATE TABLE IF NOT EXISTS wa_session (
  id TEXT PRIMARY KEY,
  data JSONB,
  updated_at TIMESTAMPTZ
);
```

### 2b. Deploy no Render

1. Acesse render.com e crie conta (grátis)
2. New → Web Service → Connect a repository → selecione gestaocaldas
3. Configure:
   - Root Directory: whatsapp
   - Build Command: npm install
   - Start Command: node server.js
4. Environment Variables:
   - RENDER = true
   - SUPABASE_URL = (URL do Supabase)
   - SUPABASE_KEY = (anon key do Supabase)
5. Create Web Service

### 2c. Configurar no site

Aba WhatsApp → campo URL do servidor → cole a URL do Render

### 2d. Manter acordado (UptimeRobot — gratuito)

Monitor HTTP a cada 5 min na URL: https://sua-url.onrender.com/status
