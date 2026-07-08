import fs from 'node:fs';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

// Integrações externas (ex.: registro de pagamentos): o webhook precisa ver
// tudo que a conversa produz — inclusive a mensagem manual do atendente e o
// conteúdo (base64) de imagem/documento — SEM comprometer o histórico local:
// persistir vem antes de rede, base64 nunca vai ao jsonl e tem teto no webhook.

// 1) Mensagem manual: histórico PRIMEIRO, webhook depois (sem await) e só
// para conversa de cliente (nada de status@broadcast/canal).
const manual = source.slice(source.indexOf('async function handleManualOutboundMessage'));
const manualFn = manual.slice(0, manual.indexOf('\n}'));
const idxSaveManual = manualFn.indexOf('saveMessageEvent(instanceName, manualPayload)');
const idxDispatchManual = manualFn.indexOf('dispatchWebhook(instanceName, "messages.upsert", manualPayload)');
assert.ok(idxSaveManual > -1, 'manual outbound must persist to history');
assert.ok(idxDispatchManual > idxSaveManual, 'history must be saved BEFORE the webhook dispatch');
assert.match(manualFn, /dispatchWebhook\(instanceName, "messages.upsert", manualPayload\)\.catch/,
  'manual webhook must be fire-and-forget (network must never delay/lose history)');
assert.match(manualFn, /c\\\.us\|lid\|s\\\.whatsapp\\\.net/,
  'manual webhook must only fire for customer-like jids');
assert.match(manualFn, /pushName: "Atendimento humano"/, 'manual outbound keeps the human marker');

// 2) Imagem/documento levam base64 no webhook, com teto configurável e flag
// de omissão; histórico salvo antes do dispatch.
const media = source.slice(source.indexOf('async function handleCustomerMedia'));
const mediaFn = media.slice(0, media.indexOf('\n}'));
assert.match(mediaFn, /webhookMediaMaxBase64/, 'media base64 must have a configurable cap');
assert.match(mediaFn, /mediaOmitida/, 'oversized media must be flagged, not silently dropped');
assert.match(mediaFn, /mediaBase64: base64Cabe \? media\.data : null/, 'media webhook payload must carry base64 within the cap');
assert.match(mediaFn, /mediaMimetype/, 'media webhook payload must carry mimetype');
assert.match(mediaFn, /mediaFilename/, 'media webhook payload must carry filename');
const idxSaveMedia = mediaFn.indexOf('saveMessageEvent(instanceName, incomingPayload)');
const idxDispatchMedia = mediaFn.indexOf('await dispatchWebhook(instanceName, "messages.upsert", incomingPayload)');
assert.ok(idxSaveMedia > -1 && idxDispatchMedia > idxSaveMedia,
  'media history must be saved BEFORE the webhook dispatch');
assert.match(mediaFn, /classificarMidiaCliente\(msg, null\)/,
  'download failure must not change the messageType vocabulary');

// 3) O jsonl continua textual: saveMessageEvent monta o registro por whitelist
// e não pode copiar campos de base64.
const save = source.slice(source.indexOf('function saveMessageEvent'));
const saveFn = save.slice(0, save.indexOf('\n}'));
assert.ok(!saveFn.includes('mediaBase64') && !saveFn.includes('audioBase64'),
  'saveMessageEvent must not persist base64 fields');

// 4) Histórico consultável por conversa com varredura limitada:
// GET /api/:instance/messages?jid=&limit=.
const msgs = source.slice(source.indexOf('app.get("/api/:instance/messages"'));
const msgsFn = msgs.slice(0, msgs.indexOf('\napp.'));
assert.match(msgsFn, /req\.query\.jid/, 'messages endpoint must filter by jid');
assert.match(msgsFn, /req\.query\.limit/, 'messages endpoint must accept a limit');
assert.match(msgsFn, /20000/, 'jid scan must be bounded (event loop protection)');

// 5) dispatchWebhook não pode engolir resposta de erro do consumidor.
const disp = source.slice(source.indexOf('async function dispatchWebhook'));
const dispFn = disp.slice(0, disp.indexOf('\n}'));
assert.match(dispFn, /resposta\.ok/, 'non-2xx webhook responses must be logged');

// 6) POST /send resolve número cru/@c.us via getNumberId (contas LID).
const send = source.slice(source.indexOf('app.post("/api/:instance/send"'));
const sendFn = send.slice(0, send.indexOf('\napp.'));
assert.match(sendFn, /getNumberId/, 'send endpoint must resolve raw numbers to real jids');

console.log('payments webhook contract OK');
