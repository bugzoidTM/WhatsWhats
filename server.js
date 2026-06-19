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
const os = require("os");
const { spawn } = require("child_process");
const crypto = require("crypto");
const session = require("express-session");
const QRCode = require("qrcode");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const OpenAI = require("openai");

// =====================================
// CONFIG GLOBAL
// =====================================
const PORT = process.env.PORT || 3000;
const HOST = process.env.LISTEN_HOST || "0.0.0.0";
const INSTANCES_DIR = process.env.INSTANCES_DIR || path.join(__dirname, "instances");
const AUTH_FILE = process.env.AUTH_FILE_PATH || path.join(__dirname, "auth.json");
const RESERVED_NAMES = ["instances", "api", "socket.io", "public", "login", "setup"];
const LOCAL_STT_URL = process.env.LOCAL_STT_URL || "http://whisper-stt:8000/transcribe";
const KOKORO_TTS_URL = process.env.KOKORO_TTS_URL || "http://kokoro:8880/v1/audio/speech";
const KOKORO_TTS_VOICE = process.env.KOKORO_TTS_VOICE || "pf_dora";
const KOKORO_TTS_MODEL = process.env.KOKORO_TTS_MODEL || "kokoro";

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
// estructura: name => { config, aiClient, groqClient, whatsappClient, connected }
// =====================================
const instances = new Map();
const conversationState = new Map();
const pendingResponses = new Map();

// =====================================
// HELPERS
// =====================================
const instanceDir = (name) => path.join(INSTANCES_DIR, name);
const configPath  = (name) => path.join(instanceDir(name), "config.json");
const crmPath     = (name) => path.join(instanceDir(name), "crm.json");
const delay       = (ms)   => new Promise((r) => setTimeout(r, ms));

function readJsonFileSafe(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    console.error(`Erro ao ler JSON ${filePath}:`, e.message);
  }
  return fallback;
}

function writeJsonFileAtomic(filePath, data) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

function normalizeCustomerJid(remoteJid = "") {
  const jid = String(remoteJid || "").trim();
  if (!jid || jid === "0@c.us" || jid.endsWith("@g.us")) return "";
  return jid;
}

function cleanPhoneNumber(value = "") {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits || digits === "0") return "";
  // Números WhatsApp reais costumam ter 8 a 15 dígitos. IDs @lid podem ter 14/15 dígitos,
  // então só use esta função para campos vindos explicitamente de contato/número, não do @lid.
  if (digits.length < 8 || digits.length > 15) return "";
  return digits;
}

function phoneFromJid(remoteJid = "") {
  const jid = String(remoteJid || "");
  if (jid.endsWith("@c.us") || jid.endsWith("@s.whatsapp.net")) return cleanPhoneNumber(jid.split("@")[0]);
  // @lid não é telefone público do cliente; é um identificador interno do WhatsApp.
  return "";
}

function bestCustomerPhone(record = {}, remoteJid = "") {
  return cleanPhoneNumber(record.contactNumber || record.phone || record.number) || phoneFromJid(remoteJid);
}

function bestCustomerName(record = {}) {
  return String(
    record.contactName ||
    record.pushName ||
    record.profileName ||
    record.verifiedName ||
    record.name ||
    ""
  ).trim();
}

function scrubStoredPhoneForJid(phone = "", remoteJid = "") {
  const digits = cleanPhoneNumber(phone);
  const jid = String(remoteJid || "");
  if (!digits) return "";
  if (jid.endsWith("@lid") && digits === jid.split("@")[0].replace(/\D/g, "")) return "";
  return digits;
}

async function getCustomerContactSnapshot(msg) {
  const snapshot = {
    pushName: msg.notifyName || "",
    contactName: "",
    profileName: "",
    verifiedName: "",
    contactNumber: "",
    contactId: "",
  };
  try {
    const contact = await msg.getContact();
    snapshot.contactId = contact?.id?._serialized || contact?.id?.user || "";
    const contactJid = contact?.id?._serialized || "";
    snapshot.contactNumber = cleanPhoneNumber(contact?.number || (contactJid.endsWith("@c.us") ? contact?.id?.user : ""));
    snapshot.contactName = String(contact?.name || contact?.pushname || contact?.shortName || "").trim();
    snapshot.profileName = String(contact?.pushname || contact?.shortName || "").trim();
    snapshot.verifiedName = String(contact?.verifiedName || "").trim();
    if (!snapshot.pushName) snapshot.pushName = snapshot.profileName || snapshot.contactName;
  } catch (e) {
    console.warn(`Não consegui obter contato de ${msg.from || "mensagem"}:`, e.message);
  }
  return snapshot;
}

function loadCrm(instanceName) {
  const data = readJsonFileSafe(crmPath(instanceName), { contacts: [] });
  const contacts = Array.isArray(data) ? data : Array.isArray(data.contacts) ? data.contacts : [];
  return {
    version: 1,
    updatedAt: data.updatedAt || null,
    contacts: contacts.filter((c) => c && c.remoteJid),
  };
}

function saveCrm(instanceName, crm) {
  const dir = instanceDir(instanceName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  writeJsonFileAtomic(crmPath(instanceName), {
    version: 1,
    updatedAt: new Date().toISOString(),
    contacts: crm.contacts || [],
  });
}

function upsertCrmContact(instanceName, record) {
  const remoteJid = normalizeCustomerJid(record.remoteJid);
  if (!remoteJid || record.fromMe) return null;

  const nowIso = new Date(record.timestamp || Date.now()).toISOString();
  const crm = loadCrm(instanceName);
  const idx = crm.contacts.findIndex((c) => c.remoteJid === remoteJid);
  const current = idx >= 0 ? crm.contacts[idx] : {};
  const text = String(record.text || "").trim();
  const incomingName = bestCustomerName(record);
  const incomingPhone = bestCustomerPhone(record, remoteJid);
  const currentPhone = scrubStoredPhoneForJid(current.phone, remoteJid);
  const next = {
    remoteJid,
    phone: incomingPhone || currentPhone || "",
    name: incomingName || current.name || "",
    contactId: record.contactId || current.contactId || "",
    contactName: record.contactName || current.contactName || "",
    profileName: record.profileName || current.profileName || "",
    firstSeenAt: current.firstSeenAt || nowIso,
    lastSeenAt: nowIso,
    messageCount: Number(current.messageCount || 0) + 1,
    lastMessage: text.slice(0, 500),
    lastMessageAt: nowIso,
    lastMessageType: record.messageType || current.lastMessageType || "conversation",
    status: current.status || "novo",
    tags: Array.isArray(current.tags) ? current.tags : [],
    notes: current.notes || "",
    updatedAt: new Date().toISOString(),
    createdAt: current.createdAt || nowIso,
  };
  if (idx >= 0) crm.contacts[idx] = next;
  else crm.contacts.push(next);
  crm.contacts.sort((a, b) => new Date(b.lastSeenAt || 0) - new Date(a.lastSeenAt || 0));
  saveCrm(instanceName, crm);
  if (typeof io !== "undefined" && io) io.to(instanceName).emit("crm_contact_upserted", next);
  return next;
}

function rebuildCrmFromMessages(instanceName) {
  const filePath = path.join(instanceDir(instanceName), "messages.jsonl");
  const existing = loadCrm(instanceName);
  const manual = new Map(existing.contacts.map((c) => [c.remoteJid, {
    name: c.name || "",
    phone: scrubStoredPhoneForJid(c.phone, c.remoteJid),
    status: c.status || "novo",
    tags: Array.isArray(c.tags) ? c.tags : [],
    notes: c.notes || "",
  }]));
  const byJid = new Map();
  if (!fs.existsSync(filePath)) return existing;
  const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    let record;
    try { record = JSON.parse(line); } catch (_) { continue; }
    const remoteJid = normalizeCustomerJid(record.remoteJid);
    if (!remoteJid || record.fromMe) continue;
    const ts = record.timestamp || Date.now();
    const seenAt = new Date(ts).toISOString();
    const current = byJid.get(remoteJid) || {
      remoteJid,
      phone: "",
      name: "",
      contactId: "",
      contactName: "",
      profileName: "",
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
      messageCount: 0,
      lastMessage: "",
      lastMessageAt: seenAt,
      lastMessageType: "conversation",
      status: "novo",
      tags: [],
      notes: "",
      createdAt: seenAt,
      updatedAt: seenAt,
    };
    const incomingPhone = bestCustomerPhone(record, remoteJid);
    const incomingName = bestCustomerName(record);
    if (incomingPhone) current.phone = incomingPhone;
    if (incomingName) current.name = incomingName;
    if (record.contactId) current.contactId = record.contactId;
    if (record.contactName) current.contactName = record.contactName;
    if (record.profileName) current.profileName = record.profileName;
    current.messageCount += 1;
    if (new Date(seenAt) >= new Date(current.lastSeenAt || 0)) {
      current.lastSeenAt = seenAt;
      current.lastMessageAt = seenAt;
      current.lastMessage = String(record.text || "").trim().slice(0, 500);
      current.lastMessageType = record.messageType || current.lastMessageType;
    }
    if (new Date(seenAt) < new Date(current.firstSeenAt || seenAt)) current.firstSeenAt = seenAt;
    byJid.set(remoteJid, current);
  }
  const contacts = Array.from(byJid.values()).map((c) => {
    const preserved = manual.get(c.remoteJid) || {};
    return {
      ...c,
      ...preserved,
      name: c.name || preserved.name || "",
      phone: c.phone || preserved.phone || "",
    };
  });
  contacts.sort((a, b) => new Date(b.lastSeenAt || 0) - new Date(a.lastSeenAt || 0));
  const crm = { version: 1, contacts };
  saveCrm(instanceName, crm);
  return crm;
}

function saveMessageEvent(instanceName, data) {
  try {
    const dir = instanceDir(instanceName);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, "messages.jsonl");
    const record = {
      timestamp: data.messageTimestamp ? Number(data.messageTimestamp) * 1000 : Date.now(),
      fromMe: data.key?.fromMe || false,
      remoteJid: data.key?.remoteJid || "",
      messageId: data.key?.id || "",
      text: data.message?.conversation || "",
      pushName: data.pushName || "",
      contactName: data.contactName || "",
      profileName: data.profileName || "",
      verifiedName: data.verifiedName || "",
      contactNumber: data.contactNumber || "",
      contactId: data.contactId || "",
      messageType: data.messageType || "conversation",
    };
    fs.appendFileSync(filePath, JSON.stringify(record) + "\n", "utf8");
    upsertCrmContact(instanceName, record);
    if (typeof io !== "undefined" && io) {
      io.to(instanceName).emit("message_logged", record);
    }
  } catch (e) {
    console.error(`[${instanceName}] Erro ao salvar histórico de mensagem:`, e.message);
  }
}

function getRecentConversation(instanceName, remoteJid, limit = 12, maxAgeMs = 72 * 60 * 60 * 1000) {
  try {
    const filePath = path.join(instanceDir(instanceName), "messages.jsonl");
    if (!fs.existsSync(filePath) || !remoteJid) return [];
    const cutoff = Date.now() - maxAgeMs;
    const lines = fs.readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean);
    const result = [];
    for (let i = lines.length - 1; i >= 0 && result.length < limit; i--) {
      let record;
      try { record = JSON.parse(lines[i]); } catch (_) { continue; }
      if (record.remoteJid !== remoteJid) continue;
      if (record.timestamp && record.timestamp < cutoff) break;
      const text = (record.text || "").trim();
      if (!text) continue;
      result.push({
        role: record.fromMe ? "assistant" : "user",
        text,
        timestamp: record.timestamp || 0,
      });
    }
    return result.reverse();
  } catch (e) {
    console.error(`[${instanceName}] Erro ao carregar contexto recente:`, e.message);
    return [];
  }
}

function detectarContextoComercial(history = [], textoAtual = "") {
  const inbound = history.filter((m) => m.role === "user").map((m) => m.text).join("\n");
  const outbound = history.filter((m) => m.role === "assistant").map((m) => m.text).join("\n");
  const allUserTxt = normalizarTexto(`${inbound}\n${textoAtual}`);
  const allBotTxt = normalizarTexto(outbound);
  const currentTxt = normalizarTexto(textoAtual);

  const querProjetoExtensao = /projeto\s+de\s+extens[aã]o|projeto\s+extens[aã]o|\bextens[aã]o\b/i.test(allUserTxt)
    || /projeto\s+de\s+extens[aã]o/i.test(allBotTxt);
  const querPronto = /\bpronto\b|modelo pronto|trabalho pronto|download imediato/i.test(allUserTxt)
    || /trabalho pronto|modelo pronto/i.test(allBotTxt);
  const pediuDados = /envie[:\s]+curso\/faculdade|curso e faculdade|informe curso|curso\/faculdade/i.test(allBotTxt);
  const mencionouCursoFaculdade = /(criminologia|pedagogia|direito|administra[cç][aã]o|enfermagem|servi[cç]o social|educa[cç][aã]o f[ií]sica|unopar|anhanguera|pit[aá]goras|faculdade|universidade|curso)/i.test(allUserTxt);
  const respostaCurtaDeDados = currentTxt.length <= 80 && mencionouCursoFaculdade && !/(quero|preciso|valor|pre[cç]o|prazo|pagamento|site)/i.test(currentTxt);

  return { querProjetoExtensao, querPronto, pediuDados, mencionouCursoFaculdade, respostaCurtaDeDados };
}

function respostaContextualPorHistorico(texto, history = []) {
  const contexto = detectarContextoComercial(history, texto);

  if (contexto.querProjetoExtensao && contexto.querPronto && (contexto.mencionouCursoFaculdade || contexto.respostaCurtaDeDados)) {
    return "Perfeito — entendi que você quer um projeto de extensão pronto. 😊\n\nTemos projeto de extensão pronto/modelo completo e editável em Word. O valor do pronto é R$ 50,00 no site, com acesso/download após confirmação do pagamento.\n\nComo você informou curso/faculdade, o próximo passo é verificar o modelo pronto mais adequado. Quer que eu te envie o link para comprar agora?";
  }

  if (contexto.pediuDados && contexto.mencionouCursoFaculdade && contexto.respostaCurtaDeDados) {
    return "Perfeito, já ajuda. 😊\n\nPara eu te direcionar corretamente: você quer modelo pronto para comprar agora ou trabalho exclusivo sob encomenda? Se já tiver prazo final e orientações/prints do AVA, pode enviar também.";
  }

  return null;
}


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
    aiProvider: "groq",
    aiApiKey: "",
    aiBaseURL: "https://api.groq.com/openai/v1",
    groqApiKey: "",
    useAI: true,
    humanoAtendeu: false,
    model: "llama-3.1-8b-instant",
    maxTokens: 220,
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

const AI_PROVIDER_PRESETS = {
  groq: { label: "Groq", baseURL: "https://api.groq.com/openai/v1", defaultModel: "llama-3.1-8b-instant" },
  openai: { label: "OpenAI", baseURL: "https://api.openai.com/v1", defaultModel: "gpt-4o-mini" },
  openrouter: { label: "OpenRouter", baseURL: "https://openrouter.ai/api/v1", defaultModel: "openai/gpt-4o-mini" },
  deepseek: { label: "DeepSeek", baseURL: "https://api.deepseek.com", defaultModel: "deepseek-chat" },
  together: { label: "Together AI", baseURL: "https://api.together.xyz/v1", defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo-Free" },
  gemini: { label: "Google Gemini (OpenAI compatível)", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/", defaultModel: "gemini-1.5-flash" },
  custom: { label: "OpenAI compatível (custom)", baseURL: "", defaultModel: "" },
};

function normalizeAiConfig(config = {}) {
  const provider = (config.aiProvider || "groq").trim().toLowerCase();
  const preset = AI_PROVIDER_PRESETS[provider] || AI_PROVIDER_PRESETS.groq;
  const legacyGroqKey = config.groqApiKey?.trim() || "";
  const apiKey = config.aiApiKey?.trim() || legacyGroqKey;
  const baseURL = (config.aiBaseURL || preset.baseURL || "").trim().replace(/\/+$/, "");
  const model = (config.model || preset.defaultModel || "").trim();
  return { provider, apiKey, baseURL, model };
}

function createAiClient(config = {}) {
  const ai = normalizeAiConfig(config);
  if (!ai.apiKey || !ai.baseURL) return null;
  return new OpenAI({ apiKey: ai.apiKey, baseURL: ai.baseURL });
}

function getOrCreateInstance(name) {
  if (!instances.has(name)) {
    const config = loadConfig(name);
    const aiClient = createAiClient(config);
    instances.set(name, { config, aiClient, groqClient: aiClient, whatsappClient: null, connected: false, qrCode: null, initializing: false });
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

// POST /api/:instance/internal/test-attendant-notification — teste local-only da automação interna, sem expor ao dashboard público
app.post("/api/:instance/internal/test-attendant-notification", validateInstance, async (req, res) => {
  if (!isLocalRequest(req)) return res.status(403).json({ error: "Endpoint permitido apenas via localhost." });

  const { instance } = req.params;
  const inst = getOrCreateInstance(instance);
  const tipo = req.body?.tipo === "atendente" ? "atendente" : "sugestao_curso";
  const texto = req.body?.texto || `[TESTE INTERNO] ${tipo} — ${new Date().toISOString()}`;
  const fakeMsg = {
    from: req.body?.from || "teste-interno@local",
    notifyName: req.body?.pushName || "Teste interno Hermes",
    getContact: async () => ({ pushname: req.body?.pushName || "Teste interno Hermes" }),
  };

  const result = await notificarAtendente(inst, instance, tipo, fakeMsg, texto);
  if (!result?.ok) return res.status(500).json(result || { ok: false, error: "Falha desconhecida" });
  res.json({ ok: true, destino: result.destino, messageId: result.messageId, tipo });
});

// POST /api/:instance/internal/test-attendant-audio — envia áudio local TTS para o WhatsApp do atendente
app.post("/api/:instance/internal/test-attendant-audio", validateInstance, async (req, res) => {
  if (!isLocalRequest(req)) return res.status(403).json({ error: "Endpoint permitido apenas via localhost." });

  const { instance } = req.params;
  const inst = getOrCreateInstance(instance);
  const destinoInfo = await resolverDestinoAtendente(inst, instance);
  if (!destinoInfo.ok) return res.status(500).json(destinoInfo);

  const texto = req.body?.texto || "Teste de resposta em áudio do agente Apostileiros. A transcrição e a voz estão sendo processadas localmente, sem API externa de transcrição.";
  try {
    const audio = await sintetizarAudioResposta(instance, texto);
    const sent = await inst.whatsappClient.sendMessage(destinoInfo.destino, audio, { sendAudioAsVoice: true });
    const messageId = sent?.id?._serialized || sent?.id?.id || "";
    saveMessageEvent(instance, {
      key: { remoteJid: destinoInfo.destino, fromMe: true, id: messageId },
      message: { conversation: `[teste áudio atendente] ${texto}` },
      pushName: "Automação interna",
    });
    res.json({ ok: true, destino: destinoInfo.destino, messageId, voice: KOKORO_TTS_VOICE });
  } catch (e) {
    console.error(`[${instance}] Erro no teste de áudio para atendente:`, e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
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

function isLocalRequest(req) {
  const ip = req.ip || req.socket?.remoteAddress || "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

// GET /api/:instance/status
app.get("/api/:instance/status", validateInstance, (req, res) => {
  const inst = instances.get(req.params.instance);
  res.json({ connected: inst?.connected || false });
});

// GET /api/:instance/messages — obter histórico de mensagens da instância
app.get("/api/:instance/messages", validateInstance, (req, res) => {
  try {
    const filePath = path.join(instanceDir(req.params.instance), "messages.jsonl");
    if (!fs.existsSync(filePath)) {
      return res.json([]);
    }
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.trim().split("\n");
    const messages = [];
    const limit = 200;
    const startIndex = Math.max(0, lines.length - limit);
    for (let i = lines.length - 1; i >= startIndex; i--) {
      if (lines[i].trim()) {
        try {
          messages.push(JSON.parse(lines[i]));
        } catch (_) {}
      }
    }
    res.json(messages);
  } catch (e) {
    console.error(`[${req.params.instance}] Erro ao ler mensagens:`, e.message);
    res.status(500).json({ error: "Erro ao ler histórico de mensagens." });
  }
});

// GET /api/:instance/crm — listar contatos cadastrados automaticamente a partir das mensagens recebidas
app.get("/api/:instance/crm", validateInstance, (req, res) => {
  try {
    const { instance } = req.params;
    const rebuild = req.query.rebuild === "1";
    const hasCrm = fs.existsSync(crmPath(instance));
    const hasMessages = fs.existsSync(path.join(instanceDir(instance), "messages.jsonl"));
    const crm = rebuild || (!hasCrm && hasMessages) ? rebuildCrmFromMessages(instance) : loadCrm(instance);
    const q = normalizarTexto(req.query.q || "");
    const status = String(req.query.status || "").trim().toLowerCase();
    let contacts = crm.contacts || [];
    if (q) {
      contacts = contacts.filter((c) => normalizarTexto(`${c.name || ""} ${c.phone || ""} ${c.remoteJid || ""} ${c.lastMessage || ""} ${(c.tags || []).join(" ")}`).includes(q));
    }
    if (status) contacts = contacts.filter((c) => String(c.status || "novo").toLowerCase() === status);
    res.json({ contacts, total: contacts.length, updatedAt: crm.updatedAt || null });
  } catch (e) {
    console.error(`[${req.params.instance}] Erro ao ler CRM:`, e.message);
    res.status(500).json({ error: "Erro ao ler CRM da instância." });
  }
});

// PATCH /api/:instance/crm/:remoteJid — atualizar campos manuais do contato no CRM
app.patch("/api/:instance/crm/:remoteJid", validateInstance, (req, res) => {
  try {
    const { instance, remoteJid } = req.params;
    const decodedJid = decodeURIComponent(remoteJid);
    const crm = loadCrm(instance);
    const idx = crm.contacts.findIndex((c) => c.remoteJid === decodedJid);
    if (idx < 0) return res.status(404).json({ error: "Contato não encontrado no CRM." });

    const allowedStatus = new Set(["novo", "em_atendimento", "orcamento", "cliente", "perdido", "arquivado"]);
    const current = crm.contacts[idx];
    const next = { ...current };
    if (typeof req.body.name === "string") next.name = req.body.name.trim().slice(0, 120);
    if (typeof req.body.status === "string") {
      const status = req.body.status.trim().toLowerCase();
      if (!allowedStatus.has(status)) return res.status(400).json({ error: "Status inválido." });
      next.status = status;
    }
    if (Array.isArray(req.body.tags)) next.tags = req.body.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 12);
    if (typeof req.body.notes === "string") next.notes = req.body.notes.trim().slice(0, 2000);
    next.updatedAt = new Date().toISOString();
    crm.contacts[idx] = next;
    saveCrm(instance, crm);
    io.to(instance).emit("crm_contact_upserted", next);
    res.json({ ok: true, contact: next });
  } catch (e) {
    console.error(`[${req.params.instance}] Erro ao atualizar CRM:`, e.message);
    res.status(500).json({ error: "Erro ao atualizar contato no CRM." });
  }
});

// GET /api/:instance/config — config mascarada
app.get("/api/:instance/config", validateInstance, (req, res) => {
  const inst = getOrCreateInstance(req.params.instance);
  const safe = { ...inst.config };
  if (safe.groqApiKey) safe.groqApiKey = safe.groqApiKey.substring(0, 8) + "***";
  if (safe.aiApiKey) safe.aiApiKey = safe.aiApiKey.substring(0, 8) + "***";
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
  const nextConfig = { ...inst.config, ...req.body };
  const ai = normalizeAiConfig(nextConfig);
  nextConfig.aiProvider = ai.provider;
  nextConfig.aiBaseURL = ai.baseURL;
  nextConfig.model = ai.model || nextConfig.model;
  if (nextConfig.aiApiKey?.trim()) nextConfig.groqApiKey = nextConfig.aiApiKey;
  else if (nextConfig.groqApiKey?.trim()) nextConfig.aiApiKey = nextConfig.groqApiKey;

  inst.config = nextConfig;
  saveConfig(instance, inst.config);
  inst.aiClient = createAiClient(inst.config);
  inst.groqClient = inst.aiClient; // compatibilidade com versões/configs antigas
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
    const lockFiles = ["SingletonLock", "SingletonCookie", "SingletonSocket", "DevToolsActivePort", "lock"];
    lockFiles.forEach(file => {
      const lockPath = path.join(sessionPath, file);
      let exists = false;
      try { exists = fs.existsSync(lockPath) || fs.lstatSync(lockPath).isSymbolicLink(); } catch (_) {}
      if (exists) {
        try {
          fs.rmSync(lockPath, { force: true });
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
function normalizarTexto(texto) {
  return (texto || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function textoContemQualquer(texto, termos) {
  const txt = normalizarTexto(texto);
  return termos.some((termo) => txt.includes(normalizarTexto(termo)));
}

function detectarIntencaoInterna(texto) {
  const courseTerms = [
    "sugerir curso",
    "sugestão de curso",
    "sugestao de curso",
    "sugerir um novo curso",
    "sugerir novo curso",
    "novo curso para a plataforma",
    "novo curso",
    "curso para a plataforma",
    "curso na plataforma",
    "indicar curso",
    "sugiro um curso",
    "gostaria de sugerir",
  ];
  const humanTerms = [
    "atendente",
    "humano",
    "falar com alguém",
    "falar com alguem",
    "falar com uma pessoa",
    "pessoa real",
    "suporte humano",
    "quero falar com",
    "me liga",
    "ligação",
    "ligacao",
  ];

  if (textoContemQualquer(texto, courseTerms)) return "sugestao_curso";
  if (textoContemQualquer(texto, humanTerms)) return "atendente";
  return null;
}

async function resolverDestinoAtendente(inst, instanceName) {
  const numero = (inst.config.attendantWhatsApp || "5573999921633").replace(/\D/g, "");
  if (!numero) return { ok: false, error: "attendantWhatsApp não configurado" };
  if (!inst.whatsappClient || !inst.connected) return { ok: false, error: "WhatsApp da instância não está conectado" };

  let destino = `${numero}@c.us`;
  try {
    const numberId = await inst.whatsappClient.getNumberId(numero);
    if (numberId?._serialized) destino = numberId._serialized;
  } catch (e) {
    console.warn(`[${instanceName}] Não consegui resolver LID do atendente ${numero}, tentando ${destino}:`, e.message);
  }
  return { ok: true, destino };
}

async function notificarAtendente(inst, instanceName, tipo, msg, texto, options = {}) {
  const destinoInfo = await resolverDestinoAtendente(inst, instanceName);
  if (!destinoInfo.ok) return destinoInfo;
  const destino = destinoInfo.destino;

  let contato = null;
  try { contato = await msg.getContact(); } catch (_) {}

  const nome = msg.notifyName || contato?.pushname || contato?.name || "não informado";
  const jid = msg.from || "não informado";
  const origem = jid.endsWith("@c.us") ? `+${jid.replace("@c.us", "")}` : jid;
  const titulo = tipo === "sugestao_curso"
    ? "📌 Sugestão de novo curso recebida"
    : tipo === "midia_cliente"
      ? "📎 Cliente enviou mídia/arquivo para análise"
      : "🚨 Cliente pediu atendimento humano";

  const detalhesMidia = options.mediaInfo
    ? [
        "",
        "Mídia/arquivo:",
        `Tipo: ${options.mediaInfo.tipo || "não informado"}`,
        `MIME: ${options.mediaInfo.mimetype || "não informado"}`,
        options.mediaInfo.filename ? `Arquivo: ${options.mediaInfo.filename}` : null,
      ].filter(Boolean)
    : [];

  const textoInterno = [
    titulo,
    "",
    `Instância: ${instanceName}`,
    `Cliente: ${nome}`,
    `Contato/JID: ${origem}`,
    `Data: ${new Date().toLocaleString("pt-BR", { timeZone: "America/Bahia" })}`,
    "",
    "Mensagem do cliente:",
    texto,
    ...detalhesMidia,
  ].join("\n");

  try {
    const sent = await inst.whatsappClient.sendMessage(destino, textoInterno);
    const messageId = sent?.id?._serialized || sent?.id?.id || "";
    saveMessageEvent(instanceName, {
      key: { remoteJid: destino, fromMe: true, id: messageId },
      message: { conversation: textoInterno },
      pushName: "Automação interna",
    });

    let mediaMessageId = "";
    if (options.media) {
      try {
        const mediaCaption = `Arquivo enviado pelo cliente ${nome} (${origem}) para análise.`;
        const sentMedia = await inst.whatsappClient.sendMessage(destino, options.media, { caption: mediaCaption });
        mediaMessageId = sentMedia?.id?._serialized || sentMedia?.id?.id || "";
        saveMessageEvent(instanceName, {
          key: { remoteJid: destino, fromMe: true, id: mediaMessageId },
          message: { conversation: `[mídia encaminhada ao atendente] ${options.mediaInfo?.mimetype || ""}`.trim() },
          pushName: "Automação interna",
        });
      } catch (e) {
        console.error(`[${instanceName}] Notificação textual enviada, mas falhou ao encaminhar mídia ao atendente:`, e.message);
      }
    }

    return { ok: true, destino, messageId, mediaMessageId, text: textoInterno };
  } catch (e) {
    console.error(`[${instanceName}] Erro ao notificar atendente interno:`, e.message);
    return { ok: false, error: e.message };
  }
}

function classificarMidiaCliente(msg, media) {
  const mimetype = media?.mimetype || "";
  const filename = media?.filename || "";
  const tipoMsg = msg.type || "media";
  const isImage = tipoMsg === "image" || mimetype.startsWith("image/");
  const isAudio = ["audio", "ptt", "voice"].includes(tipoMsg) || mimetype.startsWith("audio/");
  const isDocument = tipoMsg === "document"
    || mimetype === "application/pdf"
    || /officedocument\.wordprocessingml\.document|msword/i.test(mimetype)
    || /\.(pdf|docx?|odt)$/i.test(filename);
  return {
    tipo: isAudio ? "audio" : isImage ? "imagem" : isDocument ? "documento" : tipoMsg,
    mimetype,
    filename,
    isImage,
    isAudio,
    isDocument,
  };
}

async function transcreverAudioLocal(instanceName, media) {
  if (!media?.data) throw new Error("Áudio recebido sem conteúdo para transcrição.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.LOCAL_STT_TIMEOUT_MS || 120000));
  try {
    const response = await fetch(LOCAL_STT_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        audio_base64: media.data,
        mimetype: media.mimetype || "audio/ogg",
        filename: media.filename || "audio.ogg",
        language: "pt",
      }),
      signal: controller.signal,
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`STT local HTTP ${response.status}: ${raw.slice(0, 500)}`);
    const data = JSON.parse(raw);
    const text = String(data.text || "").trim();
    if (!text) throw new Error("STT local não retornou texto.");
    console.log(`[${instanceName}] Áudio transcrito localmente: ${JSON.stringify(text.slice(0, 180))}`);
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

function limitarTextoParaAudio(texto) {
  const clean = String(texto || "").replace(/[*_~`#>\[\]()]/g, "").replace(/\s+/g, " ").trim();
  if (clean.length <= 850) return clean;
  return clean.slice(0, 820).replace(/\s+\S*$/, "") + ". Posso continuar por texto se quiser.";
}

function runFfmpeg(args, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("ffmpeg excedeu tempo limite"));
    }, timeoutMs);

    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(true);
      reject(new Error(`ffmpeg falhou (${code}): ${stderr.slice(-1000)}`));
    });
  });
}

async function converterMp3ParaOggOpus(buffer, instanceName) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "apostileiros-audio-"));
  const inputPath = path.join(dir, "tts.mp3");
  const outputPath = path.join(dir, "resposta.ogg");
  try {
    await fs.promises.writeFile(inputPath, buffer);
    await runFfmpeg([
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", inputPath,
      "-vn", "-ac", "1", "-ar", "48000",
      "-c:a", "libopus", "-b:a", "32k", "-vbr", "on", "-application", "voip",
      outputPath,
    ]);
    const opus = await fs.promises.readFile(outputPath);
    if (opus.length < 500) throw new Error("conversão OGG/Opus gerou arquivo pequeno demais");
    console.log(`[${instanceName}] Áudio convertido para OGG/Opus compatível com WhatsApp (${opus.length} bytes).`);
    return opus;
  } finally {
    fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function sintetizarAudioResposta(instanceName, texto) {
  const input = limitarTextoParaAudio(texto);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.KOKORO_TTS_TIMEOUT_MS || 90000));
  try {
    const response = await fetch(KOKORO_TTS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "audio/mpeg",
        "x-raw-response": "true",
      },
      body: JSON.stringify({
        model: KOKORO_TTS_MODEL,
        voice: KOKORO_TTS_VOICE,
        input,
        response_format: "mp3",
        speed: 0.95,
        lang_code: "p",
      }),
      signal: controller.signal,
    });
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (!response.ok) throw new Error(`Kokoro TTS HTTP ${response.status}: ${buffer.toString("utf8").slice(0, 500)}`);
    if (buffer.length < 500) throw new Error("Kokoro TTS retornou áudio vazio/pequeno demais.");
    const opusBuffer = await converterMp3ParaOggOpus(buffer, instanceName);
    console.log(`[${instanceName}] Áudio TTS gerado localmente (${buffer.length} bytes MP3) e preparado como OGG/Opus (${opusBuffer.length} bytes, voz ${KOKORO_TTS_VOICE}).`);
    return new MessageMedia("audio/ogg; codecs=opus", opusBuffer.toString("base64"), "resposta-apostileiros.ogg");
  } finally {
    clearTimeout(timeout);
  }
}

async function responderComAudio(instanceName, msg, resposta) {
  const audio = await sintetizarAudioResposta(instanceName, resposta);
  await msg.reply(audio, undefined, { sendAudioAsVoice: true });
}

async function handleCustomerAudio(instanceName, inst, msg, chat, media, mediaInfo) {
  const textoLegenda = (msg.body || msg.caption || "").trim();
  const incomingPayload = {
    key: { remoteJid: msg.from, fromMe: false, id: msg.id?._serialized },
    message: { conversation: textoLegenda || "[áudio recebido]" },
    messageType: "audio",
    messageTimestamp: msg.timestamp,
    ...(await getCustomerContactSnapshot(msg)),
  };
  await dispatchWebhook(instanceName, "messages.upsert", incomingPayload);
  saveMessageEvent(instanceName, incomingPayload);

  if (inst.config.humanoAtendeu) return;

  await chat.sendStateRecording();
  let transcricao;
  try {
    transcricao = await transcreverAudioLocal(instanceName, media);
  } catch (e) {
    console.error(`[${instanceName}] Falha na transcrição local do áudio:`, e.message);
    const fallback = "Não consegui entender esse áudio com segurança. Pode reenviar falando mais perto do microfone ou mandar por texto?";
    await msg.reply(fallback);
    const outgoingPayload = {
      key: { remoteJid: msg.from, fromMe: true },
      message: { conversation: fallback },
      messageType: "conversation",
      messageTimestamp: Math.floor(Date.now() / 1000),
    };
    await dispatchWebhook(instanceName, "messages.upsert", outgoingPayload);
    saveMessageEvent(instanceName, outgoingPayload);
    return;
  }

  const textoParaAgente = textoLegenda
    ? `${textoLegenda}\n\nTranscrição do áudio: ${transcricao}`
    : transcricao;
  const resposta = await gerarRespostaParaTexto(instanceName, inst, msg, textoParaAgente);

  await delay(700);
  await chat.sendStateRecording();
  try {
    await responderComAudio(instanceName, msg, resposta);
  } catch (e) {
    console.error(`[${instanceName}] Falha ao enviar resposta em áudio; enviando texto:`, e.message);
    await msg.reply(resposta);
  }

  const outgoingPayload = {
    key: { remoteJid: msg.from, fromMe: true },
    message: { conversation: `[resposta em áudio] ${resposta}` },
    messageType: "audio",
    messageTimestamp: Math.floor(Date.now() / 1000),
  };
  await dispatchWebhook(instanceName, "messages.upsert", outgoingPayload);
  saveMessageEvent(instanceName, outgoingPayload);
}

async function handleCustomerMedia(instanceName, inst, msg, chat) {
  let media = null;
  let mediaInfo = { tipo: msg.type || "media", mimetype: "", filename: "" };
  const texto = (msg.body || msg.caption || "").trim();

  try {
    media = await msg.downloadMedia();
    mediaInfo = classificarMidiaCliente(msg, media);
  } catch (e) {
    console.error(`[${instanceName}] Erro ao baixar mídia recebida de ${msg.from}:`, e.message);
  }

  if (mediaInfo.isAudio) {
    await handleCustomerAudio(instanceName, inst, msg, chat, media, mediaInfo);
    return;
  }

  const incomingPayload = {
    key: { remoteJid: msg.from, fromMe: false, id: msg.id?._serialized },
    message: { conversation: texto || `[${mediaInfo.tipo} recebida]` },
    messageType: mediaInfo.tipo,
    messageTimestamp: msg.timestamp,
    ...(await getCustomerContactSnapshot(msg)),
  };
  await dispatchWebhook(instanceName, "messages.upsert", incomingPayload);
  saveMessageEvent(instanceName, incomingPayload);

  const pergunta = texto || "Cliente enviou mídia/arquivo sem texto.";
  await notificarAtendente(inst, instanceName, "midia_cliente", msg, pergunta, { media, mediaInfo });

  if (inst.config.humanoAtendeu) return;

  const resposta = mediaInfo.isImage
    ? "Recebi a foto e encaminhei para a equipe verificar com segurança se temos esse item/serviço. Se puder, envie também qualquer detalhe que apareça na imagem ou o nome do que você procura."
    : mediaInfo.isDocument
      ? "Recebi o arquivo e encaminhei para a equipe analisar. Se puder, informe também o curso/faculdade, tipo de trabalho e prazo final para agilizar o retorno."
      : "Recebi o anexo e encaminhei para a equipe analisar. Se puder, envie também uma mensagem explicando o que você precisa.";

  await delay(800);
  await chat.sendStateTyping();
  await delay(1200);
  await msg.reply(resposta);

  const outgoingPayload = {
    key: { remoteJid: msg.from, fromMe: true },
    message: { conversation: resposta },
    messageType: "conversation",
    messageTimestamp: Math.floor(Date.now() / 1000),
  };
  await dispatchWebhook(instanceName, "messages.upsert", outgoingPayload);
  saveMessageEvent(instanceName, outgoingPayload);
}

async function respostaPorFluxo(flows, texto, state = {}) {
  const txt = normalizarTexto(texto);
  const sent = new Set(state.sentFlowIds || []);

  for (const flow of flows || []) {
    if (flow.oncePerChat && sent.has(flow.id)) continue;

    for (const p of flow.exactPhrases || []) {
      if (txt === normalizarTexto(p)) return { resposta: flow.resposta, flow };
    }

    for (const p of flow.palavras || []) {
      const key = normalizarTexto(p);
      if (key && (txt.includes(key) || txt === key)) return { resposta: flow.resposta, flow };
    }
  }
  return null;
}

function respostaContinuidadeSemIA(texto, state = {}) {
  const txt = normalizarTexto(texto);
  const sent = new Set(state.sentFlowIds || []);

  if ((txt === "oi" || txt === "ola" || txt === "olá" || txt === "bom dia" || txt === "boa tarde" || txt === "boa noite") && sent.size > 0) {
    return "Oi! 😊 Me diga como posso continuar te ajudando: trabalho pronto, trabalho exclusivo, pagamento, prazo ou outro tipo de trabalho?";
  }

  if ((txt === "ola apostileiros" || txt === "olá apostileiros") && sent.has("projeto_extensao_apostileiros_inicial")) {
    return "Oi! Já te enviei as informações principais sobre projeto de extensão. Quer comprar o pronto, solicitar o exclusivo ou tirar alguma dúvida sobre prazo/pagamento?";
  }

  return null;
}

function respostaContextualPorEstado(texto, state = {}) {
  const txt = normalizarTexto(texto);
  const lastFlow = state.lastFlowId || "";

  const contextoOrcamento = [
    "trabalho_academico_orcamento_inteligente",
    "relatorio_estagio_supervisionado",
    "projeto_extensao_apostileiros_inicial",
    "4",
    "10",
    "12",
    "6",
    "9",
  ].includes(lastFlow);

  if (contextoOrcamento) {
    const temCursoOuFaculdade = /(curso|licenciatura|bacharelado|pedagogia|administracao|enfermagem|faculdade|anhanguera|unopar|pitagoras|semestre)/i.test(txt);
    if (temCursoOuFaculdade) {
      return "Perfeito, já ajuda. 😊\n\nPara fechar a análise do trabalho, envie também:\n• tipo de trabalho/atividade e tema\n• prazo final de postagem\n• orientações ou prints do AVA, se tiver\n\nCom isso a equipe avalia se é modelo pronto ou exclusivo e passa valor/prazo.";
    }
  }

  return null;
}

function respostaParaTextoSolto(texto) {
  const txt = normalizarTexto(texto);
  if (!txt) return null;

  if (/^(oi|ola|olá|bom dia|boa tarde|boa noite|menu)$/.test(txt)) return null;

  if (txt.length <= 24 && txt.split(" ").length <= 3) {
    return "Não entendi exatamente o que você precisa. 😊\n\nVocê procura trabalho pronto, trabalho exclusivo/orçamento, certificado/ACO, prazo ou pagamento?";
  }

  const termosTrabalho = ["trabalho", "atividade", "portfolio", "portifolio", "projeto", "relatorio", "estagio", "tcc", "abnt", "faculdade", "ava"];
  if (termosTrabalho.some((termo) => txt.includes(termo))) {
    return "Podemos ajudar com modelos prontos e trabalhos exclusivos sob encomenda.\n\nPara orientar melhor, envie: curso/faculdade, tipo de trabalho, tema ou disciplina, prazo final e orientações do AVA.";
  }

  return null;
}

async function respostaPorIA(inst, texto, history = []) {
  const aiClient = inst.aiClient || inst.groqClient;
  const ai = normalizeAiConfig(inst.config || {});
  if (!aiClient || !ai.apiKey) return null;
  try {
    const sysContent = [
      inst.config.promptSistema || "Você é um assistente prestativo.",
      "\n\nNunca responda uma mensagem curta isolada sem considerar o contexto recente da conversa. Se o cliente já pediu projeto de extensão pronto e depois enviou curso/faculdade, continue esse atendimento e indique o projeto de extensão pronto em vez de reiniciar perguntas.",
      inst.config.knowledgeBase?.trim()
        ? `\n\n=== BASE DE CONHECIMENTO DO NEGÓCIO ===\n${inst.config.knowledgeBase}`
        : ""
    ].join("");

    const contextualMessages = (history || []).slice(-10).map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.text,
    }));

    const completion = await aiClient.chat.completions.create({
      model: ai.model || inst.config.model || "llama-3.1-8b-instant",
      messages: [
        { role: "system", content: sysContent },
        ...contextualMessages,
        { role: "user", content: texto },
      ],
      max_tokens: Number(inst.config.maxTokens || 180),
      temperature: 0.25,
    });
    return completion.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    console.error("Erro IA:", e.message);
    return null;
  }
}

function getResponseDelayMs(inst, texto) {
  const base = Number(inst.config.responseDelayMs || 9000);
  const normalized = normalizarTexto(texto);
  if (normalized.length <= 2 || normalized === "?") return Math.max(base, 12000);
  return Math.max(3000, Math.min(base, 20000));
}

function scheduleBufferedResponse(instanceName, msg, chat, texto) {
  const inst = getOrCreateInstance(instanceName);
  const key = `${instanceName}:${msg.from}`;
  const existing = pendingResponses.get(key);
  if (existing?.timer) clearTimeout(existing.timer);

  const item = existing || { texts: [], firstAt: Date.now() };
  item.texts.push(texto);
  item.msg = msg;
  item.chat = chat;
  item.instanceName = instanceName;
  item.updatedAt = Date.now();

  const combined = item.texts.join("\n");
  const delayMs = getResponseDelayMs(inst, combined);
  item.timer = setTimeout(() => {
    pendingResponses.delete(key);
    processBufferedCustomerText(item).catch((e) => {
      console.error(`[${instanceName}] Erro ao processar buffer de mensagem:`, e);
      try { item.msg.reply("Ocorreu um erro. Tente novamente em instantes."); } catch (_) {}
    });
  }, delayMs);
  pendingResponses.set(key, item);
}

async function gerarRespostaParaTexto(instanceName, inst, msg, texto) {
  const stateKey = `${instanceName}:${msg.from}`;
  const state = conversationState.get(stateKey) || {};
  const history = getRecentConversation(instanceName, msg.from);
  let intencaoInterna = detectarIntencaoInterna(texto);
  if (!intencaoInterna && state.pendingCourseSuggestion) {
    intencaoInterna = "sugestao_curso";
    state.pendingCourseSuggestion = false;
  }
  if (intencaoInterna === "sugestao_curso") {
    await notificarAtendente(inst, instanceName, "sugestao_curso", msg, texto);
    state.pendingCourseSuggestion = true;
    state.updatedAt = Date.now();
    conversationState.set(stateKey, state);
  } else if (intencaoInterna === "atendente") {
    await notificarAtendente(inst, instanceName, "atendente", msg, texto);
    state.pendingHumanRequest = true;
    state.updatedAt = Date.now();
    conversationState.set(stateKey, state);
  }

  let resposta = respostaContinuidadeSemIA(texto, state);
  if (!resposta) resposta = respostaContextualPorHistorico(texto, history);
  if (!resposta) resposta = respostaContextualPorEstado(texto, state);
  let fluxoMatch = null;
  if (!resposta) {
    fluxoMatch = await respostaPorFluxo(inst.config.flows, texto, state);
    resposta = fluxoMatch?.resposta || null;
  }
  if (fluxoMatch?.flow?.id) {
    state.sentFlowIds = Array.from(new Set([...(state.sentFlowIds || []), fluxoMatch.flow.id]));
    state.lastFlowId = fluxoMatch.flow.id;
    state.updatedAt = Date.now();
    conversationState.set(stateKey, state);
  }
  if (!resposta) resposta = respostaParaTextoSolto(texto);
  if (!resposta && inst.config.useAI) resposta = await respostaPorIA(inst, texto, history);
  if (!resposta) resposta = "Me envie mais detalhes para eu te orientar melhor.";
  return resposta;
}

async function processBufferedCustomerText(item) {
  const { instanceName, msg, chat } = item;
  const inst = getOrCreateInstance(instanceName);
  const texto = item.texts.join("\n").trim();
  if (!texto) return;

  const textoNormalizado = normalizarTexto(texto);
  const somentePontuacao = !textoNormalizado && /^[\s?!.…]+$/.test(texto);
  if (somentePontuacao) {
    console.log(`[${instanceName}] Ignorando mensagem isolada só com pontuação de ${msg.from}: ${JSON.stringify(texto)}`);
    return;
  }

  const typing = async () => { await delay(800); await chat.sendStateTyping(); await delay(1200); };
  const resposta = await gerarRespostaParaTexto(instanceName, inst, msg, texto);

  await typing();
  await msg.reply(resposta);

  const outgoingPayload = {
    key: { remoteJid: msg.from, fromMe: true },
    message: { conversation: resposta },
    messageType: "conversation",
    messageTimestamp: Math.floor(Date.now() / 1000),
  };
  await dispatchWebhook(instanceName, "messages.upsert", outgoingPayload);
  saveMessageEvent(instanceName, outgoingPayload);
}

async function handleMessage(instanceName, msg) {
  try {
    const inst = getOrCreateInstance(instanceName);
    if (!msg.from || msg.from.endsWith("@g.us")) return;
    const chat = await msg.getChat();
    if (chat.isGroup) return;

    // Mídias e arquivos não devem cair no fluxo textual/IA comum: encaminha para análise humana.
    if (msg.hasMedia) {
      await handleCustomerMedia(instanceName, inst, msg, chat);
      return;
    }

    const texto = msg.body?.trim();
    if (!texto) return;

    // Webhook/histórico — sempre registra ao receber, independente do modo humano/debounce
    const incomingPayload = {
      key: { remoteJid: msg.from, fromMe: false, id: msg.id?._serialized },
      message: { conversation: texto },
      messageType: "conversation",
      messageTimestamp: msg.timestamp,
      ...(await getCustomerContactSnapshot(msg)),
    };
    await dispatchWebhook(instanceName, "messages.upsert", incomingPayload);
    saveMessageEvent(instanceName, incomingPayload);

    if (inst.config.humanoAtendeu) return;
    scheduleBufferedResponse(instanceName, msg, chat, texto);
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
