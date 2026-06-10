# 🤖 Agente IA WhatsApp — MicroSaaS Multi-Instância

> Sistema de automação WhatsApp com IA, suporte a múltiplas instâncias e webhooks configuráveis.  
> Inspirado na Evolution API. 

---

## 📋 Índice

- [Visão Geral](#-visão-geral)
- [Funcionalidades](#-funcionalidades)
- [Requisitos](#-requisitos)
- [Instalação](#-instalação)
- [Como usar](#-como-usar)
- [Dashboard de Instâncias](#-dashboard-de-instâncias)
- [Painel de Instância](#-painel-de-instância)
- [API REST](#-api-rest)
- [Webhooks](#-webhooks)
- [Estrutura de Arquivos](#-estrutura-de-arquivos)
- [Variáveis de Ambiente](#-variáveis-de-ambiente)

---

## 🌐 Visão Geral

O sistema permite criar **múltiplas instâncias independentes**, cada uma conectada a um número de WhatsApp diferente. Cada instância tem:

- **Bot com fluxos** — respostas automáticas por palavras-chave
- **IA com Groq** — responde perguntas fora dos fluxos usando LLMs gratuitos
- **Webhooks** — envia eventos para URLs externas em tempo real (padrão Evolution API)
- **Painel web** — gerenciamento completo sem precisar abrir o terminal

```
Browser ──► Dashboard (/)
              │
              ├── Criar / deletar instâncias
              └── Gerenciar instância (/instance.html?instance=<nome>)
                    │
                    ├── Conectar WhatsApp (QR Code)
                    ├── Configurar IA (Groq)
                    ├── Editar Fluxos do bot
                    ├── Ajustar Modelo e Prompt
                    └── Gerenciar Webhooks
```

---

## ✨ Funcionalidades

| Funcionalidade | Descrição |
|---|---|
| **Multi-instância** | Crie quantas instâncias quiser, cada uma com seu número WhatsApp |
| **QR Code no browser** | Escaneie direto pelo painel, sem abrir terminal |
| **Bot por fluxos** | Resposta automática por palavras-chave configuráveis |
| **IA com Groq (grátis)** | Integração com LLMs via API Groq (Llama, Mixtral, Gemma) |
| **Modo Humano** | Pause o bot para atender manualmente |
| **Webhooks** | Receba eventos em qualquer URL externa |
| **API REST** | Envie mensagens e gerencie instâncias via HTTP |
| **Tempo real** | Status atualizado via Socket.IO sem recarregar a página |
| **Persistência** | Sessões WhatsApp e configurações salvas em disco |

---

## 🖥️ Requisitos

- **Node.js** 18 ou superior (usa `fetch` nativo)
- **npm** 8+
- Google Chrome ou Chromium instalado (usado pelo Puppeteer internamente)
- Porta **3000** liberada no firewall (ou outra via `PORT`)

> ⚠️ Em VPS Linux, instale as dependências do Chromium antes:
> ```bash
> sudo apt-get install -y \
>   gconf-service libasound2 libatk1.0-0 libc6 libcairo2 libcups2 \
>   libdbus-1-3 libexpat1 libfontconfig1 libgcc1 libgconf-2-4 \
>   libgdk-pixbuf2.0-0 libglib2.0-0 libgtk-3-0 libnspr4 libpango-1.0-0 \
>   libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 \
>   libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 \
>   libxrandr2 libxrender1 libxss1 libxtst6 ca-certificates fonts-liberation \
>   libappindicator1 libnss3 lsb-release xdg-utils wget
> ```

---

## 🚀 Instalação

```bash
# 1. Clone ou baixe o projeto
git clone <url-do-repositorio>
cd AgenteIAChatbot_FREE_VPS

# 2. Instale as dependências
npm install

# 3. Inicie o servidor
npm start
```

Acesse o painel em: **http://localhost:3000**  
Em VPS: **http://IP_DA_VPS:3000** (libere a porta TCP 3000 no firewall)

> No Windows, você pode usar o arquivo `INICIAR.bat` para iniciar com duplo clique.

---

## 📖 Como usar

### 1. Criar uma instância

1. Acesse o **Dashboard** em `http://localhost:3000`
2. Digite um nome para a instância no campo (ex: `loja-centro`, `bot-vendas`)
   - Use apenas letras, números, `-` e `_`
3. Clique em **+ Criar instância**

### 2. Conectar o WhatsApp

1. Clique em **⚙️ Gerenciar** no card da instância
2. Clique em **🔄 Gerar QR Code**
3. Aguarde 1-2 minutos (na primeira vez o Chromium precisa iniciar)
4. Escaneie o QR Code com o WhatsApp → **Dispositivos conectados → Conectar dispositivo**

> Se o QR não aparecer ou não conectar, clique em **🧹 Limpar sessão e tentar**.

### 3. Configurar a IA (opcional)

1. Na aba **🔑 Groq (IA)**, clique em **Obter chave GRÁTIS no Groq**
2. Crie conta em [console.groq.com](https://console.groq.com/keys)
3. Gere uma API Key e cole no campo
4. Clique em **💾 Salvar**

### 4. Criar fluxos do bot

1. Vá na aba **📋 Fluxos**
2. Edite as palavras-chave e respostas dos fluxos existentes
3. Clique em **+ Adicionar fluxo** para criar novos
4. Clique em **💾 Salvar fluxos**

### 5. Ativar modo Humano

- Marque **👤 Humano atendendo** para pausar o bot/IA temporariamente
- Desmarque quando quiser que o bot volte a responder

---

## 🗂️ Dashboard de Instâncias

**URL:** `http://localhost:3000`

O dashboard exibe todas as instâncias criadas com:

- **Total de instâncias** — quantas existem no sistema
- **Conectadas agora** — com WhatsApp ativo
- **Desconectadas** — offline ou sem QR escaneado

Cada card de instância mostra:
- Nome e identificador (`/:nome`)
- Badge de status com ponto pulsante (🟢 Conectado / ⚫ Offline)
- Indicador de "Humano atendendo" quando ativo
- Botão **⚙️ Gerenciar** → abre o painel da instância
- Botão **🗑** → deleta a instância (encerra sessão e remove todos os dados)

O status dos cards atualiza **em tempo real** via Socket.IO — sem necessidade de recarregar a página.

---

## ⚙️ Painel de Instância

**URL:** `http://localhost:3000/instance.html?instance=<nome>`

### Aba Groq (IA)

Configure a chave de API Groq para habilitar respostas de IA para perguntas fora dos fluxos pré-definidos.

- A IA só responde quando **nenhum fluxo** correspondeu
- Pode ser desativada desmarcando **"Usar IA quando a pergunta não estiver nos fluxos"**

### Aba Fluxos

Defina respostas automáticas por palavras-chave:

```
Palavras-chave: oi, olá, bom dia, boa tarde
Resposta: Olá! 👋 Como posso ajudar?
```

- Palavras separadas por vírgula
- Não diferencia maiúsculas/minúsculas
- Verificação por correspondência parcial (se a mensagem *contém* a palavra)

### Aba Modelo

Configure o comportamento da IA:

- **Prompt do sistema** — personalidade e instruções do bot (substitua `[SUA EMPRESA]`)
- **Modelo Groq** — escolha entre:
  - `llama-3.1-8b-instant` — rápido, ideal para atendimento
  - `llama-3.3-70b-versatile` — mais inteligente, respostas mais elaboradas
  - `mixtral-8x7b-32768` — bom equilíbrio
  - `gemma2-9b-it` — alternativa Google

### Aba Webhooks

Configure URLs para receber eventos da instância. Ver seção [Webhooks](#-webhooks).

---

## 🔌 API REST

Base URL: `http://localhost:3000`

### Gerenciamento de instâncias

| Método | Endpoint | Descrição |
|---|---|---|
| `GET` | `/api/instances` | Lista todas as instâncias e seus status |
| `POST` | `/api/instances` | Cria uma nova instância |
| `DELETE` | `/api/instances/:name` | Deleta uma instância (encerra sessão e apaga dados) |

**Criar instância:**
```bash
curl -X POST http://localhost:3000/api/instances \
  -H "Content-Type: application/json" \
  -d '{"name": "minha-loja"}'
```

**Listar instâncias:**
```bash
curl http://localhost:3000/api/instances
# Resposta:
# [
#   { "name": "minha-loja", "connected": true, "humanoAtendeu": false },
#   { "name": "bot-suporte", "connected": false, "humanoAtendeu": false }
# ]
```

---

### Por instância

Substitua `:instance` pelo nome da sua instância.

| Método | Endpoint | Descrição |
|---|---|---|
| `GET` | `/api/:instance/status` | Status de conexão |
| `GET` | `/api/:instance/config` | Configuração (chave Groq mascarada) |
| `GET` | `/api/:instance/config/full` | Configuração completa |
| `POST` | `/api/:instance/config` | Salvar configuração |
| `POST` | `/api/:instance/whatsapp/restart` | Gerar novo QR Code |
| `POST` | `/api/:instance/whatsapp/restart?limpar=1` | Limpar sessão e gerar QR |
| `POST` | `/api/:instance/whatsapp/disconnect` | Desconectar WhatsApp |
| `POST` | `/api/:instance/humano-atendeu` | Ativar/desativar modo humano |
| `POST` | `/api/:instance/send` | **Enviar mensagem** |
| `GET` | `/api/events/types` | Listar tipos de evento disponíveis |

**Enviar mensagem via API:**
```bash
curl -X POST http://localhost:3000/api/minha-loja/send \
  -H "Content-Type: application/json" \
  -d '{
    "to": "5531999999999",
    "message": "Olá! Sua mensagem foi enviada com sucesso. 🎉"
  }'
```

> O campo `to` aceita o número no formato `5511999999999` (DDI + DDD + número) ou `5511999999999@s.whatsapp.net`.

**Ativar/desativar modo humano:**
```bash
# Ativar (bot para de responder)
curl -X POST http://localhost:3000/api/minha-loja/humano-atendeu \
  -H "Content-Type: application/json" \
  -d '{"ativo": true}'

# Desativar (bot volta a responder)
curl -X POST http://localhost:3000/api/minha-loja/humano-atendeu \
  -H "Content-Type: application/json" \
  -d '{"ativo": false}'
```

---

## 🔗 Webhooks

Configure URLs para receber eventos da instância em tempo real. Cada evento dispara uma requisição `POST` para a URL configurada.

### Eventos disponíveis

| Evento | Quando é disparado |
|---|---|
| `messages.upsert` | Mensagem recebida de um cliente **ou** resposta enviada pelo bot |
| `connection.update` | WhatsApp conectou (`state: "open"`) ou desconectou (`state: "close"`) |
| `qrcode.updated` | Novo QR Code gerado (contém o QR em texto e base64) |
| `messages.read` | Mensagem enviada pelo bot foi lida pelo destinatário |
| `presence.update` | Indicador de presença/digitação (reservado para uso futuro) |
| `custom` | Evento personalizado para integrações externas |

### Payload padrão

Todos os eventos seguem o mesmo formato:

```json
{
  "event": "messages.upsert",
  "instance": "minha-loja",
  "data": { ... },
  "timestamp": 1713983200000,
  "date_time": "2025-04-24T20:00:00.000Z",
  "server_url": "http://localhost:3000"
}
```

### Exemplos de payload por evento

**`messages.upsert` — mensagem recebida:**
```json
{
  "event": "messages.upsert",
  "instance": "minha-loja",
  "data": {
    "key": {
      "remoteJid": "5511999999999@s.whatsapp.net",
      "fromMe": false,
      "id": "ABCDEF123456"
    },
    "message": { "conversation": "Oi, qual o horário de vocês?" },
    "messageType": "conversation",
    "messageTimestamp": 1713983200,
    "pushName": "João Silva"
  }
}
```

**`connection.update` — conectado:**
```json
{
  "event": "connection.update",
  "instance": "minha-loja",
  "data": { "state": "open", "statusReason": 200 }
}
```

**`qrcode.updated` — novo QR:**
```json
{
  "event": "qrcode.updated",
  "instance": "minha-loja",
  "data": {
    "qrcode": "2@AbCdEfGh...",
    "base64": "data:image/png;base64,iVBORw0KGgo..."
  }
}
```

### Configurar um webhook pelo painel

1. Vá para o painel da instância → aba **🔗 Webhooks**
2. Preencha a **URL de destino** (ex: `https://meu-n8n.com/webhook/abc123`)
3. Informe o **Token Bearer** (opcional, para autenticação)
4. Marque os **eventos** que deseja receber
5. Clique em **+ Adicionar**

### Autenticação do webhook

Quando um token é configurado, o sistema envia o header:

```
Authorization: Bearer <token>
```

### Configurar webhook via API

```bash
curl -X POST http://localhost:3000/api/minha-loja/config \
  -H "Content-Type: application/json" \
  -d '{
    "webhooks": [
      {
        "url": "https://meu-sistema.com/webhook",
        "token": "meu-token-secreto",
        "events": ["messages.upsert", "connection.update"],
        "enabled": true
      }
    ]
  }'
```

### Testando webhooks

Recomendamos o [webhook.site](https://webhook.site) para testar — gera uma URL temporária gratuita que exibe todos os payloads recebidos em tempo real.

---

## 📁 Estrutura de Arquivos

```
AgenteIAChatbot_FREE_VPS/
│
├── server.js               # Servidor principal (Express + Socket.IO + WhatsApp)
├── package.json            # Dependências Node.js
│
├── public/
│   ├── index.html          # Dashboard de instâncias
│   └── instance.html       # Painel de gerenciamento por instância
│
└── instances/              # Criado automaticamente ao criar a primeira instância
    ├── minha-loja/
    │   ├── config.json     # Configuração da instância (fluxos, IA, webhooks)
    │   └── auth/           # Sessão WhatsApp (Puppeteer / LocalAuth)
    │       └── session-minha-loja/
    └── bot-suporte/
        ├── config.json
        └── auth/
```

### Estrutura do `config.json`

```json
{
  "name": "minha-loja",
  "groqApiKey": "gsk_...",
  "useAI": true,
  "humanoAtendeu": false,
  "model": "llama-3.1-8b-instant",
  "promptSistema": "Você é o assistente virtual da [SUA EMPRESA]...",
  "flows": [
    {
      "id": "1",
      "palavras": ["oi", "olá", "menu"],
      "resposta": "Olá! Como posso ajudar?"
    }
  ],
  "webhooks": [
    {
      "url": "https://meu-sistema.com/webhook",
      "token": "meu-token",
      "events": ["messages.upsert", "connection.update"],
      "enabled": true
    }
  ]
}
```

---

## 🔧 Variáveis de Ambiente

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3000` | Porta do servidor HTTP |
| `LISTEN_HOST` | `0.0.0.0` | Interface de escuta (use `0.0.0.0` para aceitar conexões externas) |

**Exemplo com variáveis personalizadas:**
```bash
PORT=8080 LISTEN_HOST=0.0.0.0 npm start
```

---

## 🔄 Lógica de resposta do bot

Para cada mensagem recebida, o sistema segue esta ordem:

```
1. Humano atendendo?
   └─ SIM → ignora a mensagem (não responde)
   └─ NÃO → continua

2. É mensagem de grupo?
   └─ SIM → ignora
   └─ NÃO → continua

3. Algum fluxo corresponde à mensagem?
   └─ SIM → responde com a mensagem do fluxo
   └─ NÃO → continua

4. IA ativada e chave Groq configurada?
   └─ SIM → envia para Groq e responde com a IA
   └─ NÃO → continua

5. Fallback → "Desculpe, não entendi. Digite 'menu' para ver as opções."
```

---

## 📡 Socket.IO — Eventos em tempo real

O painel usa Socket.IO para atualização instantânea sem recarregar a página.

| Evento | Direção | Descrição |
|---|---|---|
| `qr` | Server → Client | QR Code gerado (data URL) ou `null` quando conectado |
| `status` | Server → Client | `{ conectado: bool, mensagem: string }` |
| `instance_update` | Server → Broadcast | `{ name, connected }` — atualiza o dashboard |
| `instance_removed` | Server → Broadcast | `{ name }` — remove card do dashboard |

Cada painel de instância entra em uma **room** própria via `socket.handshake.query.instance`, garantindo que eventos de uma instância não apareçam em outras.

---

## ⚠️ Avisos Importantes

- **Sessões WhatsApp** ficam salvas em `instances/<nome>/auth/`. Não delete esta pasta enquanto a sessão estiver ativa.
- **Chaves Groq** ficam salvas em `config.json`. Não compartilhe este arquivo publicamente.
- O sistema usa **Puppeteer** para automatizar o WhatsApp Web. Certifique-se de ter o Chromium instalado e recursos suficientes (mínimo 1GB RAM por instância).
- O uso do WhatsApp desta forma **pode violar os Termos de Serviço** do WhatsApp. Use com responsabilidade.

---

## 📞 Suporte

Desenvolvido por **Sâmara | TSG Soluções Digitais**

- 🌐 [tsgsites.com.br](https://tsgsites.com.br)
- 💬 [WhatsApp](https://wa.me/5531973534157)
- 🔗 [Sistema Conexão](https://conexao.tsgsites.com.br)

---

*Sistema proprietário. Proibida a venda, revenda ou distribuição sem autorização do autor. © TSG Soluções Digitais*
