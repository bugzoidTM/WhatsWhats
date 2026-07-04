import fs from 'node:fs';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

// Contexto da conversa manda: se a última fala do bot foi uma pergunta, a mensagem
// do cliente é a resposta dela — fluxo por palavra-chave NÃO pode atropelar a IA.
// (caso real: cliente respondeu "Trabalho personalizado" a uma pergunta do bot e o
// fluxo "como funciona" re-perguntou a mesma coisa)

assert.match(source, /matchType:\s*"exact"/, 'flow matches must distinguish exact-phrase triggers');
assert.match(source, /matchType:\s*"keyword"/, 'flow matches must distinguish keyword matches');

assert.match(source, /function\s+hasPendingAssistantQuestion\b/, 'must detect a pending question from the bot in recent history');
const helper = source.slice(source.indexOf('function hasPendingAssistantQuestion'));
assert.match(helper.slice(0, helper.indexOf('\n}')), /for\s*\(let\s+i\s*=\s*history\.length\s*-\s*1/,
  'pending-question helper must scan BACKWARDS for the last assistant message (history already contains the current client message)');

const pipeline = source.slice(source.indexOf('async function gerarRespostaParaTexto'));
const fn = pipeline.slice(0, pipeline.indexOf('\n}'));

assert.match(fn, /deferirFluxoParaIA\s*=\s*fluxoMatch\?\.matchType\s*===\s*"keyword"/,
  'only KEYWORD flow matches defer to the AI; exact-phrase triggers always fire');
assert.match(fn, /hasPendingAssistantQuestion\(history\)/,
  'keyword flows must defer to the AI when the bot has a pending question');

// Fluxo continua como rede de segurança: se a IA falhar, a resposta do fluxo é usada.
const idxIA = fn.indexOf('respostaPorIA');
const idxFallbackFluxo = fn.indexOf('fluxoMatch.resposta', idxIA);
assert.ok(idxIA > -1 && idxFallbackFluxo > idxIA,
  'deferred flow response must remain as safety net after the AI attempt');

// oncePerChat só marca o fluxo como usado quando a resposta do fluxo é realmente enviada.
assert.match(source, /function\s+registrarFluxoUsado\b/, 'flow usage state must be registered via a helper');
assert.doesNotMatch(fn, /if\s*\(fluxoMatch\?\.flow\?\.id\)\s*\{/,
  'flow state must not be registered unconditionally on match (only when the flow response is used)');

console.log('flow context contract OK');
