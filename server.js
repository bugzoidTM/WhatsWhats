/**
 * AGENTE IA WHATSAPP — MICROSAAS MULTI-INSTÂNCIA
 * Sistema proprietário. Proibida a venda, revenda ou distribuição sem autorização. © Nutef - Soluções Digitais
 * Backend com Express, WhatsApp Web.js, Groq AI, Socket.IO e Webhooks
 * Inspirado na Evolution API — múltiplas instâncias, webhooks configuráveis
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const session = require("express-session");
const QRCode = require("qrcode");
const { Client, LocalAuth } = require("whatsapp-web.js");
const OpenAI = require("openai");

// =====================================
// CONFIG GLOBAL
// =====================================
const PORT = process.env.PORT || 3000;
const HOST = process.env.LISTEN_HOST || "0.0.0.0";
const INSTANCES_DIR = path.join(__dirname, "instances");
const AUTH_FILE = process.env.AUTH_FILE_PATH || path.join(__dirname, "auth.json");
const RESERVED_NAMES = ["instances", "api", "socket.io", "public", "login", "setup"];

if (!fs.existsSync(INSTANCES_DIR)) fs.mkdirSync(INSTANCES_DIR, { recursive: true });

// =====================================
// AUTENTICAÇÃO
// =====================================
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function loadAuth() {
  try {
    if (fs.existsSync(AUTH_FILE)) return JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
  } catch (e) { console.error("Erro ao carregar auth.json:", e.message); }
  return null;
}

function saveAuth(data) {
  fs.writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2), "utf8");
}

// authData é null quando auth.json não existe → modo setup (primeiro acesso)
let authData = loadAuth();

function isSetupMode() { return authData === null; }

function verifyPassword(inputPassword) {
  if (!authData) return false;
  const hash = hashPassword(inputPassword, authData.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(authData.hash, "hex"));
}

if (isSetupMode()) {
  console.log("\n" + "=".repeat(60));
  console.log("⚙️  PRIMEIRA EXECUÇÃO — Acesse http://localhost:3000 para");
  console.log("    cadastrar sua senha de acesso.");
  console.log("=".repeat(60) + "\n");
}

// =====================================
// MAP DE INSTÂNCIAS (runtime)
// estructura: name => { config, groqClient, whatsappClient, connected }
// =====================================
const instances = new Map();

// =====================================
// HELPERS
// =====================================
const instanceDir = (name) => path.join(INSTANCES_DIR, name);
const configPath  = (name) => path.join(instanceDir(name), "config.json");
const delay       = (ms)   => new Promise((r) => setTimeout(r, ms));

/**
 * Valida o nome de uma instância — previne Directory Traversal e nomes inválidos.
 * Retorna true se válido, false caso contrário.
 */
function validateInstanceName(name) {
  if (!name || typeof name !== "string") return false;
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return false;
  if (RESERVED_NAMES.includes(name.toLowerCase())) return false;
  // Garantir que o caminho resolvido está dentro de INSTANCES_DIR
  const resolved = path.resolve(path.join(INSTANCES_DIR, name));
  const base = path.resolve(INSTANCES_DIR);
  return resolved.startsWith(base + path.sep) || resolved === base;
}

function defaultConfig(name) {
  return {
    name,
    groqApiKey: "",
    useAI: true,
    humanoAtendeu: false,
    model: "llama-3.1-8b-instant",
    promptSistema:
      "Você é o assistente virtual da empresa. Seja simpático, profissional e objetivo. " +
      "Responda dúvidas sobre horário, preços e serviços. Se não souber algo, peça para aguardar um atendente.",
    flows: [
      {
        id: "1",
        palavras: ["oi", "olá", "ola", "bom dia", "boa tarde", "boa noite", "menu"],
        resposta:
          "Olá! 👋 Sou o assistente virtual.\n\nComo posso ajudar?\n\n1 - Saber mais sobre nós\n2 - Falar com atendente\n3 - Horário de funcionamento\n\nDigite o número ou faça sua pergunta!",
      },
      { id: "2", palavras: ["1", "saber mais", "como funciona"], resposta: "Atendimento disponível! Envie sua dúvida que eu te ajudo ou repasso para um atendente." },
      { id: "3", palavras: ["2", "atendente", "humano"],          resposta: "Um atendente humano entrará em contato em breve. Por favor, aguarde." },
      { id: "4", palavras: ["3", "horário", "horario", "funcionamento"], resposta: "Consulte nosso horário de atendimento. (Edite esta resposta na aba Fluxos)" },
    ],
    webhooks: [],
  };
}

function loadConfig(name) {
  try {
    const p = configPath(name);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) { console.error(`[${name}] Erro ao carregar config:`, e.message); }
  return defaultConfig(name);
}

function saveConfig(name, config) {
  const dir = instanceDir(name);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath(name), JSON.stringify(config, null, 2), "utf8");
}

function getOrCreateInstance(name) {
  if (!instances.has(name)) {
    const config = loadConfig(name);
    const groqClient = config.groqApiKey?.trim()
      ? new OpenAI({ apiKey: config.groqApiKey, baseURL: "https://api.groq.com/openai/v1" })
      : null;
    instances.set(name, { config, groqClient, whatsappClient: null, connected: false, qrCode: null, initializing: false });
  }
  return instances.get(name);
}

function listInstanceNames() {
  if (!fs.existsSync(INSTANCES_DIR)) return [];
  return fs.readdirSync(INSTANCES_DIR).filter((n) => {
    try { return fs.statSync(path.join(INSTANCES_DIR, n)).isDirectory(); } catch { return false; }
  });
}

// =====================================
// WEBHOOKS
// Eventos suportados (Evolution API style + customizados):
//   messages.upsert      — mensagem recebida ou enviada pelo bot
//   connection.update    — WhatsApp conectado/desconectado
//   qrcode.updated       — novo QR Code gerado
//   messages.read        — mensagem lida (futuro)
//   presence.update      — digitando (futuro)
//   custom               — evento personalizado
// =====================================
const SUPPORTED_EVENTS = [
  "messages.upsert",
  "connection.update",
  "qrcode.updated",
  "messages.read",
  "presence.update",
  "custom",
];

async function dispatchWebhook(instanceName, event, data) {
  const inst = instances.get(instanceName);
  if (!inst) return;

  const webhooks = (inst.config.webhooks || []).filter(
    (w) => w.enabled !== false && w.url && Array.isArray(w.events) && w.events.includes(event)
  );
  if (webhooks.length === 0) return;

  const payload = {
    event,
    instance: instanceName,
    data,
    timestamp: Date.now(),
    date_time: new Date().toISOString(),
    server_url: `http://localhost:${PORT}`,
    apikey: null,
  };

  for (const wh of webhooks) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const headers = { "Content-Type": "application/json" };
      if (wh.token) headers["Authorization"] = `Bearer ${wh.token}`;
      await fetch(wh.url, { method: "POST", headers, body: JSON.stringify(payload), signal: controller.signal });
    } catch (e) {
      console.error(`[${instanceName}] Webhook error → ${wh.url}: ${e.message}`);
    } finally {
      // CORREÇÃO: clearTimeout sempre executado, mesmo em caso de erro
      clearTimeout(timeout);
    }
  }
}

// =====================================
// EXPRESS + SOCKET.IO
// =====================================
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());

// ── Sessão ──
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 8 * 60 * 60 * 1000, // 8 horas
  },
}));

// ── Middleware de autenticação ──
function requireAuth(req, res, next) {
  // Se ainda não há senha cadastrada, redireciona para /setup
  if (isSetupMode()) {
    if (req.path.startsWith("/api/")) {
      return res.status(503).json({ error: "Sistema não configurado. Acesse /setup para cadastrar a senha." });
    }
    return res.redirect("/setup");
  }
  if (req.session && req.session.authenticated) return next();
  // Requisições de API retornam 401; navegador redireciona para /login
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Não autenticado. Faça login em /login." });
  }
  return res.redirect("/login");
}

// ── Rotas públicas (sem autenticação) ──

// GET /ping — Rota pública simples de healthcheck
app.get("/ping", (req, res) => res.status(200).send("ok"));

// GET /setup — página de cadastro de senha (apenas quando não configurado)
app.get("/setup", (req, res) => {
  if (!isSetupMode()) return res.redirect("/login");
  res.sendFile(path.join(__dirname, "public", "setup.html"));
});

// POST /api/auth/setup — cria a senha inicial (só funciona em modo setup)
app.post("/api/auth/setup", (req, res) => {
  if (!isSetupMode())
    return res.status(403).json({ error: "Senha já configurada. Use 'Trocar Senha' no painel." });
  const { password, confirmPassword } = req.body || {};
  if (!password || !confirmPassword)
    return res.status(400).json({ error: "Preencha todos os campos." });
  if (password !== confirmPassword)
    return res.status(400).json({ error: "As senhas não coincidem." });
  if (password.length < 6)
    return res.status(400).json({ error: "A senha deve ter pelo menos 6 caracteres." });
  const salt = crypto.randomBytes(16).toString("hex");
  authData = { salt, hash: hashPassword(password, salt) };
  saveAuth(authData);
  console.log("✅ Senha de acesso configurada com sucesso.");
  req.session.authenticated = true;
  return res.json({ ok: true });
});

app.get("/login", (req, res) => {
  if (isSetupMode()) return res.redirect("/setup");
  if (req.session?.authenticated) return res.redirect("/");
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

// POST /api/auth/login
app.post("/api/auth/login", (req, res) => {
  if (isSetupMode())
    return res.status(503).json({ error: "Acesse /setup para configurar o sistema primeiro." });
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: "Senha obrigatória." });
  try {
    if (verifyPassword(password)) {
      req.session.authenticated = true;
      return res.json({ ok: true });
    }
  } catch (e) {
    console.error("Erro na verificação de senha:", e.message);
  }
  return res.status(401).json({ error: "Senha incorreta." });
});

// ── Arquivos estáticos protegidos — aplicar requireAuth antes do static ──
app.use(requireAuth, express.static(path.join(__dirname, "public")));

// ── Todas as rotas /api/* requerem autenticação ──
app.use("/api", requireAuth);

// POST /api/auth/logout
app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

// POST /api/auth/change-password
app.post("/api/auth/change-password", (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword)
    return res.status(400).json({ error: "Campos 'currentPassword' e 'newPassword' são obrigatórios." });
  if (newPassword.length < 6)
    return res.status(400).json({ error: "A nova senha deve ter pelo menos 6 caracteres." });
  try {
    if (!verifyPassword(currentPassword))
      return res.status(401).json({ error: "Senha atual incorreta." });
    const salt = crypto.randomBytes(16).toString("hex");
    authData = { salt, hash: hashPassword(newPassword, salt) };
    saveAuth(authData);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: "Erro ao trocar senha." });
  }
});

// ---- CRUD INSTÂNCIAS ----

// GET /api/instances — listar todas
app.get("/api/instances", (req, res) => {
  const names = listInstanceNames();
  const result = names.map((name) => {
    const inst = instances.get(name);
    const config = loadConfig(name);
    return {
      name,
      connected: inst?.connected || false,
      humanoAtendeu: config.humanoAtendeu || false,
      qrCode: inst?.qrCode || null,
      initializing: inst?.initializing || false,
    };
  });
  res.json(result);
});

// POST /api/instances — criar nova instância
app.post("/api/instances", (req, res) => {
  const { name } = req.body || {};
  // CORREÇÃO: validação completa do nome (previne Directory Traversal)
  if (!validateInstanceName(name))
    return res.status(400).json({ error: "Nome inválido. Use apenas letras, números, - e _ (sem espaços ou nomes reservados)." });
  if (listInstanceNames().includes(name))
    return res.status(400).json({ error: `Instância "${name}" já existe.` });

  const dir = instanceDir(name);
  fs.mkdirSync(dir, { recursive: true });
  const cfg = defaultConfig(name);
  saveConfig(name, cfg);
  getOrCreateInstance(name);
  res.json({ ok: true, name });
});

// DELETE /api/instances/:name — deletar instância
app.delete("/api/instances/:name", async (req, res) => {
  const { name } = req.params;
  // CORREÇÃO: validação do nome previne Path Traversal
  if (!validateInstanceName(name))
    return res.status(400).json({ error: "Nome de instância inválido." });

  const inst = instances.get(name);
  if (inst?.whatsappClient) {
    try { await inst.whatsappClient.destroy(); } catch (e) {}
  }
  instances.delete(name);
  const dir = instanceDir(name);
  if (fs.existsSync(dir)) {
    try { fs.rmSync(dir, { recursive: true }); } catch (e) {}
  }
  io.emit("instance_removed", { name });
  res.json({ ok: true });
});

// ---- ROTAS POR INSTÂNCIA ----

// Middleware de validação de nome de instância para rotas /api/:instance/*
function validateInstance(req, res, next) {
  const { instance } = req.params;
  if (!validateInstanceName(instance))
    return res.status(400).json({ error: "Nome de instância inválido." });
  next();
}

// GET /api/:instance/status
app.get("/api/:instance/status", validateInstance, (req, res) => {
  const inst = instances.get(req.params.instance);
  res.json({ connected: inst?.connected || false });
});

// GET /api/:instance/config — config mascarada
app.get("/api/:instance/config", validateInstance, (req, res) => {
  const inst = getOrCreateInstance(req.params.instance);
  const safe = { ...inst.config };
  if (safe.groqApiKey) safe.groqApiKey = safe.groqApiKey.substring(0, 8) + "***";
  res.json(safe);
});

// GET /api/:instance/config/full — config completa (protegida por requireAuth)
app.get("/api/:instance/config/full", validateInstance, (req, res) => {
  const inst = getOrCreateInstance(req.params.instance);
  res.json(inst.config);
});

// POST /api/:instance/config — salvar config
app.post("/api/:instance/config", validateInstance, (req, res) => {
  const { instance } = req.params;
  const inst = getOrCreateInstance(instance);
  inst.config = { ...inst.config, ...req.body };
  saveConfig(instance, inst.config);
  if (inst.config.groqApiKey?.trim()) {
    inst.groqClient = new OpenAI({ apiKey: inst.config.groqApiKey, baseURL: "https://api.groq.com/openai/v1" });
  }
  res.json({ ok: true });
});

// POST /api/:instance/humano-atendeu
app.post("/api/:instance/humano-atendeu", validateInstance, (req, res) => {
  const { instance } = req.params;
  const inst = getOrCreateInstance(instance);
  inst.config.humanoAtendeu = !!req.body.ativo;
  saveConfig(instance, inst.config);
  res.json({ ok: true, humanoAtendeu: inst.config.humanoAtendeu });
});

// POST /api/:instance/whatsapp/disconnect
app.post("/api/:instance/whatsapp/disconnect", validateInstance, async (req, res) => {
  const { instance } = req.params;
  const inst = instances.get(instance);
  if (inst?.whatsappClient) {
    inst.connected = false;
    inst.qrCode = null;
    inst.initializing = false;
    try { await inst.whatsappClient.destroy(); } catch (e) {}
    inst.whatsappClient = null;
    io.to(instance).emit("status", { conectado: false, mensagem: "Desconectado. Gere um novo QR para reconectar." });
    io.emit("instance_update", { name: instance, connected: false });
  }
  res.json({ ok: true });
});

// POST /api/:instance/whatsapp/restart — gerar QR
app.post("/api/:instance/whatsapp/restart", validateInstance, async (req, res) => {
  const { instance } = req.params;
  const inst = getOrCreateInstance(instance);
  if (inst.whatsappClient) {
    try { await inst.whatsappClient.destroy(); } catch (e) {}
    inst.whatsappClient = null;
  }
  inst.connected = false;
  inst.qrCode = null;
  inst.initializing = false;
  if (req.query.limpar === "1") {
    const authPath = path.join(instanceDir(instance), "auth");
    if (fs.existsSync(authPath)) {
      try { fs.rmSync(authPath, { recursive: true }); } catch (e) { console.error(e); }
    }
    console.log(`[${instance}] Sessão limpa.`);
  }
  io.to(instance).emit("qr", "loading");
  io.to(instance).emit("status", { conectado: false, mensagem: "Gerando QR Code... Pode levar 1-2 minutos." });
  initWhatsApp(instance, true);
  res.json({ ok: true });
});

// POST /api/:instance/send — enviar mensagem via HTTP (para integrações externas)
app.post("/api/:instance/send", validateInstance, async (req, res) => {
  const { instance } = req.params;
  const inst = instances.get(instance);
  if (!inst?.connected || !inst.whatsappClient)
    return res.status(503).json({ error: "WhatsApp não conectado nesta instância." });
  const { to, message } = req.body || {};
  if (!to || !message) return res.status(400).json({ error: "Campos 'to' e 'message' são obrigatórios." });
  try {
    const chatId = to.includes("@") ? to : `${to}@s.whatsapp.net`;
    await inst.whatsappClient.sendMessage(chatId, message);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/events/types — listar tipos de evento disponíveis
app.get("/api/events/types", (req, res) => {
  res.json(SUPPORTED_EVENTS);
});

// =====================================
// DETECÇÃO DO CHROME DO SISTEMA
// Usado como fallback quando o Chrome bundled do Puppeteer não está disponível
// =====================================
function findChromePath() {
  const localAppData = process.env.LOCALAPPDATA || "";
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";

  const candidates = [
    // Windows — Chrome instalado pelo usuário
    path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
    // Windows — Edge (Chromium)
    path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
    // Linux
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/snap/bin/chromium",
  ];

  for (const p of candidates) {
    try { if (fs.existsSync(p)) { console.log(`🌐 Chrome encontrado: ${p}`); return p; } } catch {}
  }
  return null; // usa o Chrome bundled do Puppeteer
}

const SYSTEM_CHROME = findChromePath();

function cleanChromeLocks(instanceName) {
  const authDataPath = path.join(instanceDir(instanceName), "auth");
  const sessionPath = path.join(authDataPath, `session-${instanceName}`);
  if (fs.existsSync(sessionPath)) {
    const lockFiles = ["SingletonLock", "SingletonCookie", "lock"];
    lockFiles.forEach(file => {
      const lockPath = path.join(sessionPath, file);
      if (fs.existsSync(lockPath)) {
        try {
          fs.unlinkSync(lockPath);
          console.log(`[${instanceName}] Lock file removido: ${lockPath}`);
        } catch (e) {
          console.error(`[${instanceName}] Erro ao remover lock file ${lockPath}:`, e.message);
        }
      }
    });
  }
}

// =====================================
// WHATSAPP POR INSTÂNCIA
// =====================================
function initWhatsApp(instanceName, force = false) {
  const inst = getOrCreateInstance(instanceName);
  if (inst.whatsappClient && !force) return;
  if (inst.initializing && !force) return;

  inst.whatsappClient = null;
  inst.initializing = true;
  inst.qrCode = null;

  cleanChromeLocks(instanceName);

  const authDataPath = path.join(instanceDir(instanceName), "auth");

  const puppeteerConfig = {
    headless: true,
    timeout: 120000,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-software-rasterizer",
      "--disable-extensions",
      "--no-first-run",
    ],
  };
  // Usa Chrome do sistema se o bundled não estiver disponível
  if (SYSTEM_CHROME) puppeteerConfig.executablePath = SYSTEM_CHROME;

  inst.whatsappClient = new Client({
    authStrategy: new LocalAuth({ clientId: instanceName, dataPath: authDataPath }),
    authTimeoutMs: 180000,
    puppeteer: puppeteerConfig,
  });

  inst.whatsappClient.on("qr", async (qr) => {
    try {
      const qrDataUrl = await QRCode.toDataURL(qr, { width: 300 });
      inst.qrCode = qrDataUrl;
      io.to(instanceName).emit("qr", qrDataUrl);
      io.to(instanceName).emit("status", { conectado: false, mensagem: "Escaneie o QR Code com o WhatsApp (Aparelhos conectados)" });
      await dispatchWebhook(instanceName, "qrcode.updated", { qrcode: qr, base64: qrDataUrl });
    } catch (e) { console.error(`[${instanceName}] Erro QR:`, e.message); }
  });

  inst.whatsappClient.on("ready", () => {
    inst.connected = true;
    inst.qrCode = null;
    inst.initializing = false;
    io.to(instanceName).emit("qr", null);
    io.to(instanceName).emit("status", { conectado: true, mensagem: "WhatsApp conectado!" });
    io.emit("instance_update", { name: instanceName, connected: true });
    dispatchWebhook(instanceName, "connection.update", { state: "open", statusReason: 200 });
    console.log(`✅ [${instanceName}] WhatsApp conectado.`);
  });

  inst.whatsappClient.on("disconnected", (reason) => {
    inst.connected = false;
    inst.qrCode = null;
    inst.initializing = false;
    io.to(instanceName).emit("status", { conectado: false, mensagem: "WhatsApp desconectado." });
    io.emit("instance_update", { name: instanceName, connected: false });
    dispatchWebhook(instanceName, "connection.update", { state: "close", statusReason: reason });
  });

  inst.whatsappClient.on("auth_failure", (msg) => {
    console.error(`[${instanceName}] Falha de autenticação:`, msg);
    inst.qrCode = null;
    inst.initializing = false;
    io.to(instanceName).emit("status", { conectado: false, mensagem: "Falha ao conectar. Clique em 'Limpar sessão e tentar'." });
  });

  inst.whatsappClient.on("message_ack", async (msg, ack) => {
    // ack: 1 = enviado, 2 = recebido, 3 = lido
    if (ack === 3) {
      await dispatchWebhook(instanceName, "messages.read", {
        key: { remoteJid: msg.to, fromMe: true, id: msg.id?._serialized },
        ack,
      });
    }
  });

  inst.whatsappClient.on("message", (msg) => handleMessage(instanceName, msg));

  inst.whatsappClient.initialize()
    .then(() => {
      inst.initializing = false;
    })
    .catch((err) => {
      console.error(`[${instanceName}] Erro ao inicializar:`, err.message);
      inst.whatsappClient = null;
      inst.initializing = false;
      inst.qrCode = null;
      io.to(instanceName).emit("status", { conectado: false, mensagem: "Erro ao iniciar. Feche outros processos e tente 'Limpar sessão'." });
    });
}

// =====================================
// LÓGICA DE MENSAGENS
// =====================================
async function respostaPorFluxo(flows, texto) {
  const txt = texto.trim().toLowerCase();
  for (const flow of flows || []) {
    for (const p of flow.palavras || []) {
      if (txt.includes(p.toLowerCase()) || txt === p.toLowerCase()) return flow.resposta;
    }
  }
  return null;
}

async function respostaPorIA(inst, texto) {
  if (!inst.groqClient || !inst.config.groqApiKey) return null;
  try {
    const sysContent = [
      inst.config.promptSistema || "Você é um assistente prestativo.",
      inst.config.knowledgeBase?.trim()
        ? `\n\n=== BASE DE CONHECIMENTO DO NEGÓCIO ===\n${inst.config.knowledgeBase}`
        : ""
    ].join("");

    const completion = await inst.groqClient.chat.completions.create({
      model: inst.config.model || "llama-3.1-8b-instant",
      messages: [
        { role: "system", content: sysContent },
        { role: "user", content: texto },
      ],
      max_tokens: 500,
      temperature: 0.7,
    });
    return completion.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    console.error("Erro Groq:", e.message);
    return null;
  }
}

async function handleMessage(instanceName, msg) {
  try {
    const inst = getOrCreateInstance(instanceName);
    if (!msg.from || msg.from.endsWith("@g.us")) return;
    const chat = await msg.getChat();
    if (chat.isGroup) return;
    const texto = msg.body?.trim();
    if (!texto) return;

    // Webhook — sempre dispara ao receber mensagem, independente do modo humano
    await dispatchWebhook(instanceName, "messages.upsert", {
      key: { remoteJid: msg.from, fromMe: false, id: msg.id?._serialized },
      message: { conversation: texto },
      messageType: "conversation",
      messageTimestamp: msg.timestamp,
      pushName: msg.notifyName || "",
    });

    // Humano atendendo → bot NÃO responde, mas o webhook já foi disparado acima
    if (inst.config.humanoAtendeu) return;

    const typing = async () => { await delay(800); await chat.sendStateTyping(); await delay(1200); };

    let resposta = await respostaPorFluxo(inst.config.flows, texto);
    if (!resposta && inst.config.useAI) resposta = await respostaPorIA(inst, texto);
    if (!resposta) resposta = "Desculpe, não entendi. Digite 'menu' para ver as opções.";

    await typing();
    await msg.reply(resposta);

    // Webhook — resposta enviada pelo bot
    await dispatchWebhook(instanceName, "messages.upsert", {
      key: { remoteJid: msg.from, fromMe: true },
      message: { conversation: resposta },
      messageType: "conversation",
      messageTimestamp: Math.floor(Date.now() / 1000),
    });
  } catch (e) {
    console.error(`[${instanceName}] Erro ao processar mensagem:`, e);
    try { await msg.reply("Ocorreu um erro. Tente novamente em instantes."); } catch (_) {}
  }
}

// =====================================
// SOCKET.IO — rooms por instância
// =====================================
io.on("connection", (socket) => {
  const instanceName = socket.handshake.query.instance;
  if (instanceName) {
    socket.join(instanceName);
    const inst = instances.get(instanceName);
    socket.emit("status", {
      conectado: inst?.connected || false,
      mensagem: inst?.connected ? "WhatsApp conectado!" : "Conecte escaneando o QR Code",
    });
    if (!inst?.connected) {
      if (inst?.qrCode) {
        socket.emit("qr", inst.qrCode);
      } else {
        socket.emit("qr", "loading");
      }
    }
  }
});

// =====================================
// INICIAR SERVIDOR
// =====================================
server.listen(PORT, HOST, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║  🤖 AGENTE IA WHATSAPP — MICROSAAS MULTI-INSTÂNCIA       ║
║  Sistema proprietário. © Nutef - Soluções Digitais       ║
║                                                          ║
║  Dashboard: http://localhost:${PORT}                        ║
║  Libere TCP ${PORT} no firewall da VPS                     ║
╚══════════════════════════════════════════════════════════╝
  `);

  // CORREÇÃO: Carregar e iniciar automaticamente todas as instâncias existentes
  const existentes = listInstanceNames();
  if (existentes.length === 0) {
    console.log("Nenhuma instância encontrada. Crie uma pelo dashboard.");
  } else {
    existentes.forEach((name) => {
      getOrCreateInstance(name);
      console.log(`📦 [${name}] instância carregada — iniciando conexão WhatsApp...`);
      initWhatsApp(name); // CORREÇÃO: auto-reconexão ao iniciar servidor
    });
  }
});
