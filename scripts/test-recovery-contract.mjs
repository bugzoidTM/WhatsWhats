import fs from 'node:fs';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

// ── Atendente é config da instância, nunca hardcoded ──
assert.doesNotMatch(source, /5573999921633/, 'attendant WhatsApp number must never be hardcoded in server.js');
const destino = source.slice(source.indexOf('async function resolverDestinoAtendente'));
assert.match(destino.slice(0, destino.indexOf('\n}')), /inst\.config\.attendantWhatsApp/,
  'attendant destination must come from instance config');

// ── Aviso ao atendente: WhatsApp real do cliente, clicável ──
const notif = source.slice(source.indexOf('async function notificarAtendente'));
const notifFn = notif.slice(0, notif.indexOf('\n}'));
assert.match(notifFn, /getCustomerContactSnapshot\(msg, inst\)/, 'notification must resolve the real customer phone (LID-aware snapshot)');
assert.match(notifFn, /loadCrm\(instanceName\)/, 'notification must fall back to the CRM phone when the snapshot has none');
assert.match(notifFn, /wa\.me\/\$\{telefone\}/, 'notification must include a clickable wa.me link when the phone is known');

// ── Recuperação de conversas paradas ──
assert.match(source, /recovery-state\.json/, 'recovery state must be persisted per instance');
assert.match(source, /async function\s+scanRecoveryFollowups\b/, 'must have a periodic recovery scanner');
assert.match(source, /setInterval\(\(\) => \{\s*scanRecoveryFollowups/, 'recovery scanner must be scheduled at startup');
assert.match(source, /recuperacaoAtiva/, 'recovery must be opt-in per instance config');
assert.match(source, /function\s+dentroDoHorarioDeRecuperacao\b/, 'follow-ups must respect quiet hours');

const scan = source.slice(source.indexOf('async function scanRecoveryFollowups'));
const scanFn = scan.slice(0, scan.indexOf('\n}'));
assert.match(scanFn, /inst\.config\.humanoAtendeu\)\s*continue;/, 'instances in human mode must not send follow-ups');
assert.match(scanFn, /info\.lastHumanAt\)\s*continue;/, 'conversations with human intervention must not get follow-ups');
assert.match(scanFn, /isAutomationPausedForCustomer\(instanceName, jid\)\)\s*continue;/, 'paused customers must not get follow-ups');
assert.match(scanFn, /jidsAtendente\.has\(jid\)\)\s*continue;/, 'attendant chat must never get a follow-up');
assert.match(scanFn, /entry\.sentAt \|\| 0\) >= info\.lastAt\)\s*continue;/, 'one follow-up per conversation stall');

const tratar = source.slice(source.indexOf('async function tratarRespostaDeRecuperacao'));
const tratarFn = tratar.slice(0, tratar.indexOf('\n}'));
assert.match(tratarFn, /notificarAtendente\(inst, instanceName, "recuperacao_cliente_respondeu"/,
  'reply to follow-up must alert the attendant');
assert.match(tratarFn, /pauseAutomationForCustomer\(instanceName, msg\.from, "recuperacao_encerrada"\)/,
  'reply to follow-up must close the automated attendance (pause)');

assert.match(source, /if \(await tratarRespostaDeRecuperacao\(instanceName, inst, msg, texto\)\) return;/,
  'text pipeline must intercept replies to a pending follow-up');
assert.match(source, /if \(await tratarRespostaDeRecuperacao\(instanceName, inst, msg, textoParaAgente\)\) return;/,
  'audio pipeline must intercept replies to a pending follow-up');
assert.match(source, /fecharRecuperacaoSePendente\(instanceName, msg\.from\);/,
  'media after a follow-up must close the recovery cycle');

console.log('recovery contract OK');
