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
const MANUAL_PAUSE_MS = Number(process.env.MANUAL_PAUSE_MS || 24 * 60 * 60 * 1000);
const RECOVERY_SCAN_INTERVAL_MS = Number(process.env.RECOVERY_SCAN_INTERVAL_MS || 10 * 60 * 1000);
const RECOVERY_DEFAULT_AFTER_MS = 24 * 60 * 60 * 1000;   // silêncio até o follow-up
const RECOVERY_DEFAULT_MAX_AGE_MS = 72 * 60 * 60 * 1000; // conversa mais velha que isso não recebe follow-up
const AUTOMATION_OUTGOING_GRACE_MS = Number(process.env.AUTOMATION_OUTGOING_GRACE_MS || 120000);

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
// Rajadas de mídia (vários arquivos seguidos do mesmo cliente) geram UMA só
// confirmação de recebimento, nunca uma resposta por arquivo.
const pendingMediaAcks = new Map();

// =====================================
// HELPERS
// =====================================
const instanceDir = (name) => path.join(INSTANCES_DIR, name);
const configPath  = (name) => path.join(instanceDir(name), "config.json");
const crmPath     = (name) => path.join(instanceDir(name), "crm.json");
const manualPausesPath = (name) => path.join(instanceDir(name), "manual-pauses.json");
const recoveryStatePath = (name) => path.join(instanceDir(name), "recovery-state.json");
const delay       = (ms)   => new Promise((r) => setTimeout(r, ms));
const automatedOutgoing = new Map();
// Catálogo de produtos por instância (feature opcional: config.catalogoUrl).
const productCatalogCache = new Map(); // instanceName -> { loadedAt, products }

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

function loadManualPauses(instanceName) {
  const data = readJsonFileSafe(manualPausesPath(instanceName), { customers: {} });
  return data && typeof data === "object" && data.customers && typeof data.customers === "object"
    ? data
    : { customers: {} };
}

function saveManualPauses(instanceName, pauses) {
  const dir = instanceDir(instanceName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  writeJsonFileAtomic(manualPausesPath(instanceName), {
    version: 1,
    updatedAt: new Date().toISOString(),
    customers: pauses.customers || {},
  });
}

function cleanupManualPauses(instanceName, pauses = loadManualPauses(instanceName), now = Date.now()) {
  let changed = false;
  for (const [jid, data] of Object.entries(pauses.customers || {})) {
    const pausedUntil = Number(data?.pausedUntil || 0);
    if (!pausedUntil || pausedUntil <= now) {
      delete pauses.customers[jid];
      changed = true;
    }
  }
  if (changed) saveManualPauses(instanceName, pauses);
  return pauses;
}

function pauseAutomationForCustomer(instanceName, remoteJid, reason = "manual_whatsapp_outbound", durationMs = MANUAL_PAUSE_MS) {
  const jid = normalizeCustomerJid(remoteJid);
  if (!jid) return null;
  const now = Date.now();
  const pauses = cleanupManualPauses(instanceName, loadManualPauses(instanceName), now);
  const pausedUntil = now + Math.max(60 * 1000, Number(durationMs) || MANUAL_PAUSE_MS);
  pauses.customers[jid] = {
    remoteJid: jid,
    reason,
    pausedAt: new Date(now).toISOString(),
    pausedUntil,
    pausedUntilIso: new Date(pausedUntil).toISOString(),
  };
  saveManualPauses(instanceName, pauses);
  return pauses.customers[jid];
}

function isAutomationPausedForCustomer(instanceName, remoteJid) {
  const jid = normalizeCustomerJid(remoteJid);
  if (!jid) return false;
  const now = Date.now();
  const pauses = cleanupManualPauses(instanceName, loadManualPauses(instanceName), now);
  return Number(pauses.customers?.[jid]?.pausedUntil || 0) > now;
}

function markAutomationOutgoing(instanceName, remoteJid) {
  const jid = normalizeCustomerJid(remoteJid);
  if (!jid) return;
  const key = `${instanceName}:${jid}`;
  automatedOutgoing.set(key, Date.now() + AUTOMATION_OUTGOING_GRACE_MS);
}

function isMarkedAutomationOutgoing(instanceName, remoteJid) {
  const jid = normalizeCustomerJid(remoteJid);
  if (!jid) return false;
  const key = `${instanceName}:${jid}`;
  const until = Number(automatedOutgoing.get(key) || 0);
  if (until > Date.now()) return true;
  automatedOutgoing.delete(key);
  return false;
}

async function sendAutomationMessage(instanceName, inst, remoteJid, content, options) {
  markAutomationOutgoing(instanceName, remoteJid);
  const sent = await inst.whatsappClient.sendMessage(remoteJid, content, options);
  markAutomationOutgoing(instanceName, remoteJid);
  return sent;
}

async function replyWithAutomation(instanceName, msg, content, options) {
  markAutomationOutgoing(instanceName, msg.from);
  const sent = await msg.reply(content, undefined, options);
  markAutomationOutgoing(instanceName, msg.from);
  return sent;
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

async function getWhatsAppStoreContactSnapshot(inst, remoteJid) {
  const jid = normalizeCustomerJid(remoteJid);
  const page = inst?.whatsappClient?.pupPage;
  if (!jid || !page) return null;

  try {
    return await page.evaluate((targetJid) => {
      const contacts = window.Store?.Contact?.getModelsArray?.() || [];
      const serialize = (c) => c ? {
        id: c.id?._serialized || "",
        user: c.id?.user || "",
        server: c.id?.server || "",
        name: c.name || "",
        pushname: c.pushname || "",
        shortName: c.shortName || "",
        verifiedName: c.verifiedName || "",
        number: c.number || "",
        contactHash: c.contactHash || "",
        pnContactHash: c.pnContactHash || "",
        isAddressBookContact: !!c.isAddressBookContact,
      } : null;
      const contact = contacts.find((c) => c.id?._serialized === targetJid) || null;
      let phoneContact = null;

      if (contact?.id?.server === "c.us") {
        phoneContact = contact;
      } else if (contact?.pnContactHash) {
        phoneContact = contacts.find((c) => c.id?.server === "c.us" && c.contactHash === contact.pnContactHash) || null;
      }

      if (!phoneContact && contact) {
        const targetName = String(contact.name || contact.shortName || "").trim().toLowerCase();
        if (targetName) {
          const sameName = contacts.filter((c) => c.id?.server === "c.us" && String(c.name || c.shortName || "").trim().toLowerCase() === targetName);
          if (sameName.length === 1) phoneContact = sameName[0];
        }
      }

      return { contact: serialize(contact), phoneContact: serialize(phoneContact) };
    }, jid);
  } catch (e) {
    console.warn(`Não consegui consultar Store.Contact para ${jid}:`, e.message);
    return null;
  }
}

function applyStoreContactSnapshot(snapshot, storeSnapshot) {
  const contact = storeSnapshot?.contact || null;
  const phoneContact = storeSnapshot?.phoneContact || null;
  if (!contact && !phoneContact) return snapshot;

  const source = contact || phoneContact;
  const phoneJid = phoneContact?.id || "";
  const phone = phoneJid.endsWith("@c.us") ? phoneJid.split("@")[0] : phoneContact?.number || "";

  if (!snapshot.contactId && source?.id) snapshot.contactId = source.id;
  if (!snapshot.contactNumber) snapshot.contactNumber = cleanPhoneNumber(phone);
  if (!snapshot.contactName) snapshot.contactName = String(source?.name || "").trim();
  if (!snapshot.profileName) snapshot.profileName = String(source?.pushname || source?.shortName || "").trim();
  if (!snapshot.verifiedName) snapshot.verifiedName = String(source?.verifiedName || phoneContact?.verifiedName || "").trim();
  if (!snapshot.pushName) snapshot.pushName = snapshot.contactName || snapshot.profileName || snapshot.verifiedName;
  return snapshot;
}

async function getCustomerContactSnapshot(msg, inst = null) {
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

  const storeSnapshot = await getWhatsAppStoreContactSnapshot(inst, msg.from);
  return applyStoreContactSnapshot(snapshot, storeSnapshot);
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

async function enrichCrmFromWhatsAppStore(instanceName, inst, crm) {
  if (!inst?.whatsappClient?.pupPage || !crm?.contacts?.length) return crm;
  let changed = false;
  for (const contact of crm.contacts) {
    const storeSnapshot = await getWhatsAppStoreContactSnapshot(inst, contact.remoteJid);
    const before = JSON.stringify({
      phone: contact.phone || "",
      name: contact.name || "",
      contactName: contact.contactName || "",
      profileName: contact.profileName || "",
      verifiedName: contact.verifiedName || "",
    });
    const snapshot = applyStoreContactSnapshot({
      pushName: contact.name || "",
      contactName: contact.contactName || "",
      profileName: contact.profileName || "",
      verifiedName: contact.verifiedName || "",
      contactNumber: scrubStoredPhoneForJid(contact.phone, contact.remoteJid),
      contactId: contact.contactId || contact.remoteJid || "",
    }, storeSnapshot);

    contact.phone = snapshot.contactNumber || scrubStoredPhoneForJid(contact.phone, contact.remoteJid) || "";
    contact.name = contact.name || snapshot.contactName || snapshot.profileName || snapshot.verifiedName || snapshot.pushName || "";
    contact.contactName = contact.contactName || snapshot.contactName || "";
    contact.profileName = contact.profileName || snapshot.profileName || "";
    contact.verifiedName = contact.verifiedName || snapshot.verifiedName || "";
    contact.contactId = contact.contactId || snapshot.contactId || "";

    const after = JSON.stringify({
      phone: contact.phone || "",
      name: contact.name || "",
      contactName: contact.contactName || "",
      profileName: contact.profileName || "",
      verifiedName: contact.verifiedName || "",
    });
    if (before !== after) {
      contact.updatedAt = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) saveCrm(instanceName, crm);
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

// Regras de negócio específicas (correção de trabalhos, contexto comercial,
// respostas prontas por segmento) NÃO vivem mais no código: cada instância
// trata isso com promptSistema + knowledgeBase + flows + histórico (IA).

function detectarPedidoLinkProduto(texto = "") {
  const txt = normalizarTexto(texto);
  return /(\blink\b|comprar|compra|carrinho|pagina do produto|\bproduto\b|\bloja\b|onde (acho|encontro|compro))/.test(txt);
}

function decodeHtmlEntity(value = "") {
  return String(value || "")
    .replace(/&#8211;|&ndash;/g, "–")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extrairProdutosCatalogo(html = "", linkPrefix = "") {
  const products = [];
  if (!linkPrefix) return products;
  const escapedPrefix = linkPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\[\\*\\*([^\\]]+)\\*\\*\\]\\((${escapedPrefix}[^)]+)\\)`, "g");
  let match;
  while ((match = re.exec(html))) {
    products.push({ title: decodeHtmlEntity(match[1]), url: match[2] });
  }
  if (products.length) return products;

  const htmlRe = new RegExp(`<a[^>]+href=["'](${escapedPrefix}[^"']+)["'][^>]*>(.*?)</a>`, "gis");
  while ((match = htmlRe.exec(html))) {
    const title = decodeHtmlEntity(match[2]);
    if (title && !products.some((p) => p.url === match[1])) products.push({ title, url: match[1] });
  }
  return products;
}

function termosBuscaProduto(texto = "") {
  const stop = new Set(["envia", "enviar", "link", "comprar", "compra", "pra", "para", "por", "favor", "trabalho", "atividade", "curso", "faculdade", "preciso", "quero", "gostaria", "correcao", "corrigir", "receber"]);
  return normalizarTexto(texto).split(" ").filter((w) => w.length >= 3 && !stop.has(w));
}

function pontuarProduto(product, queryText = "") {
  const title = normalizarTexto(product.title || "");
  const url = normalizarTexto(product.url || "").replace(/-/g, " ");
  const hay = `${title} ${url}`;
  let score = 0;
  for (const term of termosBuscaProduto(queryText)) {
    if (hay.includes(term)) score += term.length >= 7 ? 3 : 1;
  }
  return score;
}

// Catálogo genérico por instância: config.catalogoUrl aponta para a página de
// listagem (padrão WooCommerce, paginação /page/N/). Links de produto são
// reconhecidos pelo prefixo config.catalogoLinkPrefix (default: <origem>/produto/).
function catalogoConfig(inst) {
  const baseUrl = String(inst?.config?.catalogoUrl || "").trim().replace(/\/+$/, "");
  if (!baseUrl) return null;
  let linkPrefix = String(inst?.config?.catalogoLinkPrefix || "").trim();
  if (!linkPrefix) {
    try { linkPrefix = `${new URL(baseUrl).origin}/produto/`; } catch (_) { return null; }
  }
  return { baseUrl, linkPrefix };
}

async function carregarCatalogo(inst, instanceName, maxPages = 12) {
  const cfg = catalogoConfig(inst);
  if (!cfg) return [];
  const now = Date.now();
  const cached = productCatalogCache.get(instanceName);
  if (cached?.products?.length && cached.baseUrl === cfg.baseUrl && now - cached.loadedAt < 6 * 60 * 60 * 1000) {
    return cached.products;
  }

  const products = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = page === 1 ? `${cfg.baseUrl}/` : `${cfg.baseUrl}/page/${page}/`;
    try {
      const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 WhatsAIBot/1.0" } });
      if (!response.ok) continue;
      const html = await response.text();
      for (const product of extrairProdutosCatalogo(html, cfg.linkPrefix)) {
        if (!products.some((p) => p.url === product.url)) products.push(product);
      }
    } catch (e) {
      console.warn(`[${instanceName}] Falha ao carregar catálogo ${url}:`, e.message);
    }
  }
  if (products.length) {
    productCatalogCache.set(instanceName, { loadedAt: now, products, baseUrl: cfg.baseUrl });
    return products;
  }
  return cached?.products || [];
}

async function buscarProdutoNoCatalogo(inst, instanceName, texto, history = []) {
  const queryText = [
    ...(history || []).filter((m) => m.role === "user").map((m) => m.text),
    texto,
  ].join("\n");
  const products = await carregarCatalogo(inst, instanceName);
  const ranked = products
    .map((product) => ({ ...product, score: pontuarProduto(product, queryText) }))
    .filter((product) => product.score >= 8)
    .sort((a, b) => b.score - a.score);
  return ranked[0] || null;
}

// Só responde de forma determinística quando encontra um produto REAL no
// catálogo (link verdadeiro). Nos demais casos devolve null e a IA conduz
// (com a política de links descrita na knowledgeBase da instância).
async function respostaParaPedidoLinkProduto(inst, instanceName, texto, history = []) {
  if (!catalogoConfig(inst)) return null;
  if (!detectarPedidoLinkProduto(texto)) return null;
  const produto = await buscarProdutoNoCatalogo(inst, instanceName, texto, history);
  if (produto?.url) {
    return `Encontrei este produto na loja:\n${produto.title}\n${produto.url}\n\nConfira se é exatamente o que você precisa antes de comprar. Se não for, me diga mais detalhes que eu verifico a opção mais adequada.`;
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
    // Regras de negócio ficam SEMPRE na configuração da instância (nunca no código):
    knowledgeBase: "",       // base de conhecimento usada pela IA
    catalogoUrl: "",         // opcional: página de listagem de produtos (WooCommerce) p/ busca de link real
    catalogoLinkPrefix: "",  // opcional: prefixo dos links de produto (default: <origem>/produto/)
    respostaPadrao: "",      // fallback quando IA/fluxos não respondem
    respostaMidia: "",       // confirmação de recebimento de arquivo/imagem; quando preenchida, tem prioridade sobre a IA
    pausaAposMidia: false,   // ao receber arquivo p/ análise: confirma 1x, pausa a automação e deixa o humano assumir
    pausaAposMidiaMs: 0,     // duração da pausa acima (0 = mesma janela do atendimento manual)
    attendantWhatsApp: "",   // WhatsApp do atendente humano (avisos internos); sem ele não há notificações
    // Recuperação de conversas paradas (follow-up automático):
    recuperacaoAtiva: false,     // liga o follow-up de conversas em silêncio sem intervenção humana
    recuperacaoAposMs: 0,        // silêncio até o follow-up (0 = 24h)
    recuperacaoJanelaMaxMs: 0,   // idade máxima da conversa para ainda receber follow-up (0 = 72h)
    recuperacaoMensagem: "",     // texto do follow-up (vazio = padrão neutro)
    recuperacaoEncerramento: "", // resposta quando o cliente responde ao follow-up (vazio = padrão neutro)
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
  const tipo = req.body?.tipo === "midia_cliente" ? "midia_cliente" : "atendente";
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

  const texto = req.body?.texto || "Teste de resposta em áudio do agente. A transcrição e a voz estão sendo processadas localmente, sem API externa de transcrição.";
  try {
    const audio = await sintetizarAudioResposta(instance, texto);
    const sent = await sendAutomationMessage(instance, inst, destinoInfo.destino, audio, { sendAudioAsVoice: true });
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
app.get("/api/:instance/crm", validateInstance, async (req, res) => {
  try {
    const { instance } = req.params;
    const rebuild = req.query.rebuild === "1";
    const hasCrm = fs.existsSync(crmPath(instance));
    const hasMessages = fs.existsSync(path.join(instanceDir(instance), "messages.jsonl"));
    let crm = rebuild || (!hasCrm && hasMessages) ? rebuildCrmFromMessages(instance) : loadCrm(instance);
    const inst = instances.get(instance);
    crm = await enrichCrmFromWhatsAppStore(instance, inst, crm);
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
    const sent = await sendAutomationMessage(instance, inst, chatId, message);
    // Registra no histórico da instância (dashboard/CRM enxergam o que as
    // integrações externas — ex.: n8n — respondem pelos clientes).
    saveMessageEvent(instance, {
      key: { remoteJid: chatId, fromMe: true, id: sent?.id?._serialized || sent?.id?.id || "" },
      message: { conversation: String(message).slice(0, 5000) },
      messageType: "conversation",
      messageTimestamp: Math.floor(Date.now() / 1000),
      pushName: "Automação externa",
    });
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

  inst.whatsappClient.on("message_create", (msg) => handleManualOutboundMessage(instanceName, msg));
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

// Termo só casa a partir de fronteira de palavra (evita falso positivo por
// substring — ex.: "aco" dentro de "faco"). O fim fica aberto de propósito
// para plurais/variações ("curso" casa "cursos").
function contemTermo(txtNormalizado, termo) {
  const key = normalizarTexto(termo);
  if (!key) return false;
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^| )${esc}`).test(txtNormalizado);
}

function textoContemQualquer(texto, termos) {
  const txt = normalizarTexto(texto);
  return termos.some((termo) => contemTermo(txt, termo));
}

// Única intenção tratada no código: pedido de atendimento humano (genérica
// para qualquer negócio). Demais intenções são responsabilidade da IA, via
// promptSistema/knowledgeBase da instância.
function detectarIntencaoInterna(texto) {
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

  if (textoContemQualquer(texto, humanTerms)) return "atendente";
  return null;
}

async function resolverDestinoAtendente(inst, instanceName) {
  // Sem fallback hardcoded: o WhatsApp do atendente é config da instância (attendantWhatsApp).
  const numero = String(inst.config.attendantWhatsApp || "").replace(/\D/g, "");
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

  // Resolve o número REAL do cliente (jids @lid não são telefone): snapshot do
  // contato (inclui Store/LID) e, em último caso, o CRM da instância.
  const snapshot = await getCustomerContactSnapshot(msg, inst);
  const jid = msg.from || "não informado";
  let telefone = bestCustomerPhone(snapshot, jid);
  if (!telefone) {
    try {
      const crm = loadCrm(instanceName);
      telefone = cleanPhoneNumber(crm.contacts.find((c) => c.remoteJid === jid)?.phone || "");
    } catch (_) {}
  }

  const nome = msg.notifyName || bestCustomerName(snapshot) || "não informado";
  const origem = telefone ? `+${telefone}` : jid;
  const contatoLinhas = telefone
    ? [`WhatsApp: +${telefone}`, `Conversar: https://wa.me/${telefone}`]
    : [`Contato/JID: ${jid}`];
  const titulo = tipo === "midia_cliente"
    ? "📎 Cliente enviou mídia/arquivo para análise"
    : tipo === "recuperacao_cliente_respondeu"
      ? "🔄 Cliente respondeu à mensagem de recuperação"
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
    ...contatoLinhas,
    `Data: ${new Date().toLocaleString("pt-BR", { timeZone: "America/Bahia" })}`,
    "",
    "Mensagem do cliente:",
    texto,
    ...detalhesMidia,
  ].join("\n");

  try {
    const sent = await sendAutomationMessage(instanceName, inst, destino, textoInterno);
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
        const sentMedia = await sendAutomationMessage(instanceName, inst, destino, options.media, { caption: mediaCaption });
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
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "whatsai-audio-"));
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
    return new MessageMedia("audio/ogg; codecs=opus", opusBuffer.toString("base64"), "resposta.ogg");
  } finally {
    clearTimeout(timeout);
  }
}

async function responderComAudio(instanceName, msg, resposta) {
  const audio = await sintetizarAudioResposta(instanceName, resposta);
  await replyWithAutomation(instanceName, msg, audio, { sendAudioAsVoice: true });
}

// WhatsApp não renderiza Markdown: [rótulo](url) vira "rótulo: url" em texto puro.
function desfazerLinksMarkdown(texto = "") {
  return String(texto).replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1: $2");
}

// Link nunca é falado em áudio: separa as URLs (vão como mensagem de texto,
// clicáveis) do que sobra para ser falado.
function separarLinksDoTexto(texto = "") {
  const links = [];
  const guardar = (url) => links.push(url.replace(/[).,;!?]+$/, ""));
  let falado = desfazerLinksMarkdown(texto)
    // "…loja: https://x" / "site —https://x": o separador vira ponto final na fala
    .replace(/\s*[:\-–—]\s*(https?:\/\/[^\s]+)/g, (m, url) => { guardar(url); return "."; })
    .replace(/https?:\/\/[^\s]+/g, (url) => { guardar(url); return ""; });
  falado = falado
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/\.{2,}/g, ".")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[ \t]*[-•:.][ \t]*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .replace(/[:\-–—]\s*$/, ".");
  return { falado, links: [...new Set(links)] };
}

async function handleCustomerAudio(instanceName, inst, msg, chat, media, mediaInfo) {
  const textoLegenda = (msg.body || msg.caption || "").trim();
  // O conteúdo do áudio (base64) vai no webhook para integrações externas
  // (ex.: n8n) poderem transcrever/responder. O saveMessageEvent grava só os
  // campos textuais — o base64 NÃO vai para o messages.jsonl.
  const incomingPayload = {
    key: { remoteJid: msg.from, fromMe: false, id: msg.id?._serialized },
    message: { conversation: textoLegenda || "[áudio recebido]" },
    messageType: "audio",
    messageTimestamp: msg.timestamp,
    audioBase64: media?.data || null,
    audioMimetype: media?.mimetype || "audio/ogg; codecs=opus",
    audioFilename: media?.filename || "audio.ogg",
    ...(await getCustomerContactSnapshot(msg, inst)),
  };
  await dispatchWebhook(instanceName, "messages.upsert", incomingPayload);
  saveMessageEvent(instanceName, incomingPayload);

  if (isAutomationPausedForCustomer(instanceName, msg.from)) {
    console.log(`[${instanceName}] Automação pausada para ${msg.from}; áudio recebido apenas registrado.`);
    return;
  }
  if (inst.config.humanoAtendeu) return;

  await chat.sendStateRecording();
  let transcricao;
  try {
    transcricao = await transcreverAudioLocal(instanceName, media);
  } catch (e) {
    console.error(`[${instanceName}] Falha na transcrição local do áudio:`, e.message);
    const fallback = "Não consegui entender esse áudio com segurança. Pode reenviar falando mais perto do microfone ou mandar por texto?";
    await replyWithAutomation(instanceName, msg, fallback);
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
  if (await tratarRespostaDeRecuperacao(instanceName, inst, msg, textoParaAgente)) return;
  const resposta = await gerarRespostaParaTexto(instanceName, inst, msg, textoParaAgente);

  // Links nunca são falados: vão ANTES, como texto (clicáveis); o áudio segue
  // depois só com a fala — se sobrar fala que valha a pena.
  const { falado, links } = separarLinksDoTexto(resposta);
  if (links.length) {
    const textoLinks = links.join("\n");
    await replyWithAutomation(instanceName, msg, textoLinks);
    const linksPayload = {
      key: { remoteJid: msg.from, fromMe: true },
      message: { conversation: textoLinks },
      messageType: "conversation",
      messageTimestamp: Math.floor(Date.now() / 1000),
    };
    await dispatchWebhook(instanceName, "messages.upsert", linksPayload);
    saveMessageEvent(instanceName, linksPayload);
  }

  const fala = falado || (links.length ? "" : String(resposta || "").trim());
  if (!fala) return;

  await delay(700);
  await chat.sendStateRecording();
  try {
    await responderComAudio(instanceName, msg, fala);
  } catch (e) {
    console.error(`[${instanceName}] Falha ao enviar resposta em áudio; enviando texto:`, e.message);
    await replyWithAutomation(instanceName, msg, fala);
  }

  const outgoingPayload = {
    key: { remoteJid: msg.from, fromMe: true },
    message: { conversation: `[resposta em áudio] ${fala}` },
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
    ...(await getCustomerContactSnapshot(msg, inst)),
  };
  await dispatchWebhook(instanceName, "messages.upsert", incomingPayload);
  saveMessageEvent(instanceName, incomingPayload);

  if (isAutomationPausedForCustomer(instanceName, msg.from)) {
    console.log(`[${instanceName}] Automação pausada para ${msg.from}; mídia recebida apenas registrada.`);
    return;
  }

  const pergunta = texto || "Cliente enviou mídia/arquivo sem texto.";
  await notificarAtendente(inst, instanceName, "midia_cliente", msg, pergunta, { media, mediaInfo });
  fecharRecuperacaoSePendente(instanceName, msg.from);

  if (inst.config.humanoAtendeu) return;

  // A confirmação de recebimento é agrupada por rajada: vários arquivos
  // seguidos geram UMA resposta só (nunca uma resposta por arquivo).
  scheduleMediaAck(instanceName, msg, chat, mediaInfo, texto);
}

function getMediaAckDelayMs(inst) {
  return Math.max(5000, Number(inst.config.mediaAckDelayMs || inst.config.responseDelayMs || 9000));
}

function scheduleMediaAck(instanceName, msg, chat, mediaInfo, texto) {
  const inst = getOrCreateInstance(instanceName);
  const key = `${instanceName}:${msg.from}`;
  const existing = pendingMediaAcks.get(key);
  if (existing?.timer) clearTimeout(existing.timer);

  const item = existing || { files: [], texts: [], firstAt: Date.now() };
  item.files.push(mediaInfo);
  if (texto && !item.files.some((f) => f.filename === texto)) item.texts.push(texto);
  item.msg = msg;
  item.chat = chat;
  item.instanceName = instanceName;
  item.updatedAt = Date.now();

  item.timer = setTimeout(() => {
    pendingMediaAcks.delete(key);
    processMediaAckBurst(item).catch((e) => {
      console.error(`[${instanceName}] Erro ao confirmar recebimento de mídia:`, e);
    });
  }, getMediaAckDelayMs(inst));
  pendingMediaAcks.set(key, item);
}

// Uma rajada de arquivos => UMA confirmação de recebimento. Prioridade:
// 1. config.respostaMidia (determinística, controlada pelo negócio);
// 2. IA (promptSistema + knowledgeBase) com instrução genérica;
// 3. fallback neutro.
// Com config.pausaAposMidia ligado, após confirmar a automação PAUSA para o
// cliente e o atendimento passa para a equipe humana (que já recebeu os arquivos).
async function processMediaAckBurst(item) {
  const { instanceName, msg, chat } = item;
  const inst = getOrCreateInstance(instanceName);

  // O estado pode ter mudado durante a janela da rajada.
  if (isAutomationPausedForCustomer(instanceName, msg.from)) return;
  if (inst.config.humanoAtendeu) return;

  const pausarDepois = !!inst.config.pausaAposMidia;
  const nomes = item.files.map((f) => f.filename).filter(Boolean);
  const legenda = item.texts.join("\n").trim();

  let resposta = String(inst.config.respostaMidia || "").trim() || null;

  if (!resposta && inst.config.useAI) {
    const history = getRecentConversation(instanceName, msg.from, 8, 7 * 24 * 60 * 60 * 1000);
    const qtd = item.files.length;
    const descricao = qtd === 1
      ? `1 arquivo/anexo${nomes[0] ? ` (${nomes[0]})` : ""}`
      : `${qtd} arquivos/anexos${nomes.length ? ` (${nomes.join(", ")})` : ""}`;
    const perguntaSintetica = [
      `[O cliente enviou ${descricao}${legenda ? ` com a mensagem: "${legenda}"` : ", sem mensagem de texto"}.`,
      "Tudo já foi encaminhado para a equipe humana analisar.",
      pausarDepois
        ? "Responda curto, em UMA mensagem só: confirme o recebimento e diga que a equipe vai analisar e retorna em breve por aqui. Não faça perguntas nem peça mais nada agora.]"
        : "Responda curto, em UMA mensagem só: confirme o recebimento de acordo com o contexto do negócio e peça as informações que ainda faltarem.]",
    ].join(" ");
    // O atendente já é sempre avisado no fluxo de mídia; aqui só limpamos a marca.
    resposta = separarMarcaAtendente(await respostaPorIA(inst, perguntaSintetica, history)).texto;
  }

  if (!resposta) {
    resposta = pausarDepois
      ? "Recebi seu material e encaminhei para a equipe analisar. Em breve entraremos em contato por aqui. 😊"
      : "Recebi seu arquivo e encaminhei para a equipe analisar. Se puder, envie também uma mensagem explicando o que você precisa. 😊";
  }

  await delay(800);
  await chat.sendStateTyping();
  await delay(1200);
  await replyWithAutomation(instanceName, msg, resposta);

  const outgoingPayload = {
    key: { remoteJid: msg.from, fromMe: true },
    message: { conversation: resposta },
    messageType: "conversation",
    messageTimestamp: Math.floor(Date.now() / 1000),
  };
  await dispatchWebhook(instanceName, "messages.upsert", outgoingPayload);
  saveMessageEvent(instanceName, outgoingPayload);

  if (pausarDepois) {
    const pause = pauseAutomationForCustomer(
      instanceName,
      msg.from,
      "midia_encaminhada_para_analise",
      Number(inst.config.pausaAposMidiaMs) || MANUAL_PAUSE_MS
    );
    // Texto pendente no buffer também passa a ser assunto do humano.
    const pendingKey = `${instanceName}:${msg.from}`;
    const pendingText = pendingResponses.get(pendingKey);
    if (pendingText?.timer) clearTimeout(pendingText.timer);
    pendingResponses.delete(pendingKey);
    console.log(`[${instanceName}] Mídia encaminhada para análise; automação pausada para ${msg.from} até ${pause?.pausedUntilIso || "janela padrão"}.`);
  }
}

async function respostaPorFluxo(flows, texto, state = {}) {
  const txt = normalizarTexto(texto);
  const sent = new Set(state.sentFlowIds || []);

  for (const flow of flows || []) {
    if (flow.oncePerChat && sent.has(flow.id)) continue;

    for (const p of flow.exactPhrases || []) {
      if (txt === normalizarTexto(p)) return { resposta: flow.resposta, flow, matchType: "exact" };
    }

    for (const p of flow.palavras || []) {
      if (contemTermo(txt, p)) return { resposta: flow.resposta, flow, matchType: "keyword" };
    }
  }
  return null;
}

// A última fala do bot nesta conversa foi uma pergunta ainda sem resposta dele?
// (o histórico já contém a mensagem atual do cliente — por isso procuramos a
// última mensagem do assistente, não a última do array)
function hasPendingAssistantQuestion(history = []) {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "assistant") return String(history[i].text || "").trim().endsWith("?");
  }
  return false;
}

function registrarFluxoUsado(stateKey, state, fluxoMatch) {
  if (!fluxoMatch?.flow?.id) return;
  state.sentFlowIds = Array.from(new Set([...(state.sentFlowIds || []), fluxoMatch.flow.id]));
  state.lastFlowId = fluxoMatch.flow.id;
  state.updatedAt = Date.now();
  conversationState.set(stateKey, state);
}

async function respostaPorIA(inst, texto, history = []) {
  const aiClient = inst.aiClient || inst.groqClient;
  const ai = normalizeAiConfig(inst.config || {});
  if (!aiClient || !ai.apiKey) return null;
  try {
    const sysContent = [
      inst.config.promptSistema || "Você é um assistente prestativo.",
      "\n\nConsidere sempre o contexto recente da conversa antes de responder: continue o assunto em andamento, não reinicie perguntas já respondidas e não trate mensagens curtas como conversas novas. O cliente às vezes responde citando/repetindo a sua mensagem anterior e preenchendo as respostas no meio do texto (por exemplo em negrito, logo após cada pergunta): leia com atenção e aproveite os dados que ele já informou; nunca peça de novo o que já foi respondido.",
      "\nEsta conversa é no WhatsApp, que não renderiza Markdown: nunca use links em formato [texto](url) — escreva sempre a URL pura.",
      "\nLimites do canal: você atende apenas por mensagens de texto neste WhatsApp. Você NÃO envia e-mails, não faz ligações, não acessa outros sistemas e não envia por conta própria chaves PIX, dados bancários, boletos, comprovantes ou links de pagamento — isso é feito por um atendente humano. Nunca prometa fazer nada disso, nunca peça o e-mail do cliente para enviar pagamento e nunca diga que enviou algo por e-mail.",
      "\nAcionar atendente humano: quando (e só quando) for preciso um atendente — o cliente confirmou que quer pagar/fechar o pedido, pediu falar com uma pessoa, ou surgiu algo fora do seu alcance — responda de forma curta que um atendente vai concluir por aqui mesmo no WhatsApp (por exemplo, enviar a chave PIX) e peça que aguarde um instante; e acrescente a marca [ATENDENTE] ao final da resposta. Essa marca é removida antes do envio e serve apenas para avisar a equipe — nunca a explique ao cliente.",
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
    const conteudo = completion.choices?.[0]?.message?.content?.trim() || null;
    return conteudo ? desfazerLinksMarkdown(conteudo) : null;
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
      try { replyWithAutomation(instanceName, item.msg, "Ocorreu um erro. Tente novamente em instantes."); } catch (_) {}
    });
  }, delayMs);
  pendingResponses.set(key, item);
}

// A IA pode acrescentar a marca [ATENDENTE] à resposta para acionar um humano
// (ver instrução no prompt). Aqui a marca é SEMPRE removida antes de enviar ao
// cliente; `acionar` diz se a equipe deve ser avisada. Genérico (multi-tenant).
function separarMarcaAtendente(resposta) {
  if (!resposta) return { texto: resposta, acionar: false };
  const acionar = /\[\s*ATENDENTE\s*\]/i.test(resposta);
  const texto = resposta
    .replace(/\[\s*ATENDENTE\s*\]/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { texto, acionar };
}

// Pipeline de resposta 100% genérico (multi-tenant). A ordem é:
// 1. intenção de atendimento humano (avisa o atendente, genérica);
// 2. fluxos (config da instância, aba Fluxos) — frase exata sempre vale;
//    fluxo por PALAVRA-CHAVE só vale para mensagem "fria": se a última fala do
//    bot foi uma pergunta, a mensagem do cliente é a resposta dela e quem trata
//    é a IA (que tem o histórico); o fluxo vira rede de segurança se a IA falhar;
// 3. catálogo de produtos (opcional, config.catalogoUrl — só link REAL);
// 4. IA com histórico + promptSistema + knowledgeBase (o coração);
// 5. fallback neutro (config.respostaPadrao).
// Regras específicas de cada negócio NÃO entram aqui — vivem na config.
async function gerarRespostaParaTexto(instanceName, inst, msg, texto) {
  const stateKey = `${instanceName}:${msg.from}`;
  const state = conversationState.get(stateKey) || {};
  const history = getRecentConversation(instanceName, msg.from);

  if (detectarIntencaoInterna(texto) === "atendente") {
    await notificarAtendente(inst, instanceName, "atendente", msg, texto);
    state.pendingHumanRequest = true;
    state.updatedAt = Date.now();
    conversationState.set(stateKey, state);
  }

  const fluxoMatch = await respostaPorFluxo(inst.config.flows, texto, state);
  const ai = normalizeAiConfig(inst.config || {});
  const aiDisponivel = !!(inst.config.useAI && (inst.aiClient || inst.groqClient) && ai.apiKey);
  const deferirFluxoParaIA = fluxoMatch?.matchType === "keyword"
    && aiDisponivel
    && hasPendingAssistantQuestion(history);

  let resposta = null;
  if (fluxoMatch && !deferirFluxoParaIA) {
    resposta = fluxoMatch.resposta;
    registrarFluxoUsado(stateKey, state, fluxoMatch);
  }

  if (!resposta) resposta = await respostaParaPedidoLinkProduto(inst, instanceName, texto, history);
  if (!resposta && inst.config.useAI) resposta = await respostaPorIA(inst, texto, history);
  if (!resposta && deferirFluxoParaIA) {
    // IA indisponível/falhou: a resposta do fluxo ainda é melhor que o fallback neutro.
    resposta = fluxoMatch.resposta;
    registrarFluxoUsado(stateKey, state, fluxoMatch);
  }
  if (!resposta) {
    resposta = inst.config.respostaPadrao
      || "Recebi sua mensagem! Pode me dar mais detalhes do que você precisa? Se preferir falar com um atendente, é só pedir. 😊";
  }

  // A IA pode ter pedido handoff via marca [ATENDENTE]: remove a marca e avisa o
  // atendente uma vez por conversa (dedup por state.pendingHumanRequest).
  const { texto: respostaLimpa, acionar } = separarMarcaAtendente(resposta);
  resposta = respostaLimpa || resposta;
  if (acionar && !state.pendingHumanRequest) {
    await notificarAtendente(inst, instanceName, "atendente", msg, texto);
    state.pendingHumanRequest = true;
    state.updatedAt = Date.now();
    conversationState.set(stateKey, state);
  }
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
  if (isAutomationPausedForCustomer(instanceName, msg.from)) {
    console.log(`[${instanceName}] Automação pausada para ${msg.from}; buffer textual descartado sem resposta automática.`);
    return;
  }
  if (await tratarRespostaDeRecuperacao(instanceName, inst, msg, texto)) return;
  const resposta = await gerarRespostaParaTexto(instanceName, inst, msg, texto);

  await typing();
  await replyWithAutomation(instanceName, msg, resposta);

  const outgoingPayload = {
    key: { remoteJid: msg.from, fromMe: true },
    message: { conversation: resposta },
    messageType: "conversation",
    messageTimestamp: Math.floor(Date.now() / 1000),
  };
  await dispatchWebhook(instanceName, "messages.upsert", outgoingPayload);
  saveMessageEvent(instanceName, outgoingPayload);
}

// =====================================
// RECUPERAÇÃO DE CONVERSAS PARADAS (por instância, genérico)
// Se NENHUM humano interveio e o cliente ficou em silêncio, o bot envia UM
// follow-up perguntando se ficou dúvida. Se o cliente responder: agradece,
// avisa o atendente e ENCERRA (pausa a automação — o humano assume).
// Textos vêm da config da instância; os defaults são neutros, sem regra de negócio.
// =====================================

function loadRecoveryState(instanceName) {
  const data = readJsonFileSafe(recoveryStatePath(instanceName), { customers: {} });
  return data && typeof data === "object" && data.customers && typeof data.customers === "object"
    ? data
    : { customers: {} };
}

function saveRecoveryState(instanceName, state) {
  const dir = instanceDir(instanceName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  writeJsonFileAtomic(recoveryStatePath(instanceName), {
    version: 1,
    updatedAt: new Date().toISOString(),
    customers: state.customers || {},
  });
}

function recoveryConfig(inst) {
  const cfg = inst.config || {};
  return {
    ativa: !!cfg.recuperacaoAtiva,
    aposMs: Number(cfg.recuperacaoAposMs) || RECOVERY_DEFAULT_AFTER_MS,
    janelaMaxMs: Number(cfg.recuperacaoJanelaMaxMs) || RECOVERY_DEFAULT_MAX_AGE_MS,
    mensagem: String(cfg.recuperacaoMensagem || "").trim()
      || "Oi! 👋 Passando para saber se ficou alguma dúvida ou se há algo mais em que possamos ajudar. Estamos por aqui! 😊",
    encerramento: String(cfg.recuperacaoEncerramento || "").trim()
      || "Obrigado pelo retorno! 🙏 Vou levar sua mensagem para um atendente, que continua o atendimento por aqui. Até já!",
  };
}

// Follow-up só em horário razoável para o cliente (America/Bahia, 8h às 20h59).
function dentroDoHorarioDeRecuperacao(now = new Date()) {
  const hora = Number(now.toLocaleString("pt-BR", { timeZone: "America/Bahia", hour: "2-digit", hour12: false }));
  return hora >= 8 && hora < 21;
}

function coletarAtividadePorCliente(instanceName, janelaTotalMs) {
  const map = new Map();
  try {
    const filePath = path.join(instanceDir(instanceName), "messages.jsonl");
    if (!fs.existsSync(filePath)) return map;
    const cutoff = Date.now() - janelaTotalMs;
    for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
      if (!line) continue;
      let r;
      try { r = JSON.parse(line); } catch (_) { continue; }
      const jid = normalizeCustomerJid(r.remoteJid || "");
      if (!jid || jid.endsWith("@broadcast")) continue;
      const ts = Number(r.timestamp || 0);
      if (!ts || ts < cutoff) continue;
      const cur = map.get(jid) || { lastAt: 0, lastHumanAt: 0, temMensagemDoCliente: false };
      if (ts > cur.lastAt) cur.lastAt = ts;
      if (r.fromMe && r.pushName === "Atendimento humano" && ts > cur.lastHumanAt) cur.lastHumanAt = ts;
      if (!r.fromMe) cur.temMensagemDoCliente = true;
      map.set(jid, cur);
    }
  } catch (e) {
    console.error(`[${instanceName}] Erro ao coletar atividade para recuperação:`, e.message);
  }
  return map;
}

async function scanRecoveryFollowups() {
  if (!dentroDoHorarioDeRecuperacao()) return;
  for (const instanceName of listInstanceNames()) {
    try {
      const inst = getOrCreateInstance(instanceName);
      const rec = recoveryConfig(inst);
      if (!rec.ativa || inst.config.humanoAtendeu) continue;
      if (!inst.connected || !inst.whatsappClient) continue;

      // O chat do atendente nunca recebe follow-up.
      const destinoInfo = await resolverDestinoAtendente(inst, instanceName);
      const jidsAtendente = new Set();
      if (destinoInfo.ok) jidsAtendente.add(destinoInfo.destino);
      const numeroAtendente = String(inst.config.attendantWhatsApp || "").replace(/\D/g, "");
      if (numeroAtendente) jidsAtendente.add(`${numeroAtendente}@c.us`);

      const atividade = coletarAtividadePorCliente(instanceName, rec.aposMs + rec.janelaMaxMs);
      const state = loadRecoveryState(instanceName);
      const now = Date.now();
      let mudou = false;

      for (const [jid, info] of atividade) {
        if (jidsAtendente.has(jid)) continue;
        if (!info.temMensagemDoCliente) continue;
        const silencio = now - info.lastAt;
        if (silencio < rec.aposMs || silencio > rec.janelaMaxMs) continue;
        if (info.lastHumanAt) continue; // humano interveio nessa janela — não é caso do bot
        if (isAutomationPausedForCustomer(instanceName, jid)) continue;
        const entry = state.customers[jid];
        if (entry && Number(entry.sentAt || 0) >= info.lastAt) continue; // esta parada já teve follow-up

        await sendAutomationMessage(instanceName, inst, jid, rec.mensagem);
        const payload = {
          key: { remoteJid: jid, fromMe: true },
          message: { conversation: rec.mensagem },
          messageType: "conversation",
          messageTimestamp: Math.floor(Date.now() / 1000),
        };
        await dispatchWebhook(instanceName, "messages.upsert", payload);
        saveMessageEvent(instanceName, payload);
        state.customers[jid] = { sentAt: Date.now(), sentAtIso: new Date().toISOString(), status: "sent" };
        mudou = true;
        console.log(`[${instanceName}] Recuperação: follow-up enviado para ${jid} após ${Math.round(silencio / 3600000)}h de silêncio.`);
      }
      if (mudou) saveRecoveryState(instanceName, state);
    } catch (e) {
      console.error(`[${instanceName}] Erro no ciclo de recuperação:`, e.message);
    }
  }
}

// Cliente respondeu ao follow-up: agradece, avisa o atendente e encerra
// (pausa a automação para o humano assumir a conversa).
async function tratarRespostaDeRecuperacao(instanceName, inst, msg, texto) {
  const state = loadRecoveryState(instanceName);
  const entry = state.customers?.[msg.from];
  if (!entry || entry.status !== "sent") return false;

  const rec = recoveryConfig(inst);
  await replyWithAutomation(instanceName, msg, rec.encerramento);
  const payload = {
    key: { remoteJid: msg.from, fromMe: true },
    message: { conversation: rec.encerramento },
    messageType: "conversation",
    messageTimestamp: Math.floor(Date.now() / 1000),
  };
  await dispatchWebhook(instanceName, "messages.upsert", payload);
  saveMessageEvent(instanceName, payload);

  await notificarAtendente(inst, instanceName, "recuperacao_cliente_respondeu", msg, texto);
  pauseAutomationForCustomer(instanceName, msg.from, "recuperacao_encerrada");
  state.customers[msg.from] = { ...entry, status: "closed", closedAt: Date.now(), closedAtIso: new Date().toISOString() };
  saveRecoveryState(instanceName, state);
  console.log(`[${instanceName}] Recuperação: ${msg.from} respondeu ao follow-up; atendente avisado e automação pausada.`);
  return true;
}

// Mídia após follow-up: o fluxo de mídia já avisa o atendente; aqui só fechamos
// o ciclo de recuperação para o scanner não reenviar follow-up.
function fecharRecuperacaoSePendente(instanceName, remoteJid) {
  const state = loadRecoveryState(instanceName);
  const entry = state.customers?.[remoteJid];
  if (!entry || entry.status !== "sent") return false;
  state.customers[remoteJid] = { ...entry, status: "closed", closedAt: Date.now(), closedAtIso: new Date().toISOString() };
  saveRecoveryState(instanceName, state);
  return true;
}

async function handleManualOutboundMessage(instanceName, msg) {
  try {
    const fromMe = !!(msg?.fromMe || msg?.id?.fromMe);
    if (!fromMe) return;

    const remoteJid = normalizeCustomerJid(msg.to || msg.id?.remote || msg.from || "");
    if (!remoteJid) return;

    if (isMarkedAutomationOutgoing(instanceName, remoteJid)) return;

    const existing = pendingResponses.get(`${instanceName}:${remoteJid}`);
    if (existing?.timer) clearTimeout(existing.timer);
    pendingResponses.delete(`${instanceName}:${remoteJid}`);

    const existingMedia = pendingMediaAcks.get(`${instanceName}:${remoteJid}`);
    if (existingMedia?.timer) clearTimeout(existingMedia.timer);
    pendingMediaAcks.delete(`${instanceName}:${remoteJid}`);

    const pause = pauseAutomationForCustomer(instanceName, remoteJid);
    const texto = (msg.body || msg.caption || "[mensagem manual enviada pelo WhatsApp]").trim();
    saveMessageEvent(instanceName, {
      key: { remoteJid, fromMe: true, id: msg.id?._serialized || msg.id?.id || "" },
      message: { conversation: texto },
      messageType: msg.type || "conversation",
      messageTimestamp: msg.timestamp || Math.floor(Date.now() / 1000),
      pushName: "Atendimento humano",
    });
    console.log(`[${instanceName}] Atendimento manual detectado para ${remoteJid}; automação pausada até ${pause?.pausedUntilIso || "24h"}.`);
  } catch (e) {
    console.error(`[${instanceName}] Erro ao detectar atendimento manual:`, e.message);
  }
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
      ...(await getCustomerContactSnapshot(msg, inst)),
    };
    await dispatchWebhook(instanceName, "messages.upsert", incomingPayload);
    saveMessageEvent(instanceName, incomingPayload);

    if (inst.config.humanoAtendeu || isAutomationPausedForCustomer(instanceName, msg.from)) return;
    scheduleBufferedResponse(instanceName, msg, chat, texto);
  } catch (e) {
    console.error(`[${instanceName}] Erro ao processar mensagem:`, e);
    try { await replyWithAutomation(instanceName, msg, "Ocorreu um erro. Tente novamente em instantes."); } catch (_) {}
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

  // Recuperação de conversas paradas: varredura periódica (por instância, opt-in via config).
  setInterval(() => {
    scanRecoveryFollowups().catch((e) => console.error("Erro na varredura de recuperação:", e.message));
  }, RECOVERY_SCAN_INTERVAL_MS);

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
