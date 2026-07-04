import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const serverPath = path.join(root, 'server.js');
const source = fs.readFileSync(serverPath, 'utf8');

// Rajada de mídia: vários arquivos seguidos => UMA confirmação, nunca resposta por arquivo.
assert.match(source, /const\s+pendingMediaAcks\s*=\s*new\s+Map\(\)/, 'must keep a per-customer buffer of pending media acks');
assert.match(source, /function\s+scheduleMediaAck\b/, 'media handler must schedule a debounced ack instead of replying per file');
assert.match(source, /async\s+function\s+processMediaAckBurst\b/, 'must process the media burst in one place');
assert.match(source, /scheduleMediaAck\(instanceName,\s*msg,\s*chat/, 'handleCustomerMedia must delegate the ack to the burst scheduler');
assert.doesNotMatch(
  source.slice(source.indexOf('async function handleCustomerMedia'), source.indexOf('function getMediaAckDelayMs')),
  /replyWithAutomation/,
  'handleCustomerMedia must not reply directly (one reply per burst, sent by processMediaAckBurst)'
);

// Prioridade da mensagem de confirmação: config da instância > IA > fallback neutro.
const burst = source.slice(source.indexOf('async function processMediaAckBurst'));
const idxRespostaMidia = burst.indexOf('inst.config.respostaMidia');
const idxIA = burst.indexOf('respostaPorIA');
assert.ok(idxRespostaMidia > -1 && idxIA > -1 && idxRespostaMidia < idxIA,
  'config.respostaMidia (when set) must take priority over the AI-generated ack');

// Pausa após mídia: com config.pausaAposMidia a automação pausa e o humano assume.
assert.match(source, /pausaAposMidia/, 'must support per-instance pause-after-media flag');
assert.match(burst.slice(0, burst.indexOf('\n}')), /pauseAutomationForCustomer\(\s*instanceName,\s*msg\.from,\s*"midia_encaminhada_para_analise"/,
  'when pausaAposMidia is on, the burst ack must pause automation for that customer');
assert.match(burst, /pendingResponses\.delete\(pendingKey\)/,
  'pause after media must also drop any pending buffered text response');

// Atendimento manual durante a rajada cancela a confirmação pendente.
const manual = source.slice(source.indexOf('async function handleManualOutboundMessage'), source.indexOf('async function handleMessage'));
assert.match(manual, /pendingMediaAcks\.delete\(`\$\{instanceName\}:\$\{remoteJid\}`\)/,
  'manual intervention must cancel any pending media ack for that customer');

// Estado pode mudar durante a janela: burst re-verifica pausa e modo humano antes de responder.
assert.match(burst, /isAutomationPausedForCustomer\(instanceName,\s*msg\.from\)\)\s*return;/,
  'burst processor must re-check pause state before replying');
assert.match(burst, /inst\.config\.humanoAtendeu\)\s*return;/,
  'burst processor must re-check humanoAtendeu before replying');

console.log('media ack contract OK');
