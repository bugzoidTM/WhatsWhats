import fs from 'node:fs';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

// Áudio nunca "fala" URL: links saem ANTES, como texto (clicáveis), e o áudio
// segue só com a fala. WhatsApp não renderiza Markdown, então [rótulo](url)
// também não pode chegar ao cliente.

assert.match(source, /function\s+separarLinksDoTexto\b/, 'must split links out of text meant to be spoken');
assert.match(source, /function\s+desfazerLinksMarkdown\b/, 'must unwrap markdown links (WhatsApp does not render them)');

const audio = source.slice(source.indexOf('async function handleCustomerAudio'));
const fn = audio.slice(0, audio.indexOf('\n}'));
const idxSeparar = fn.indexOf('separarLinksDoTexto(resposta)');
const idxLinksText = fn.indexOf('replyWithAutomation(instanceName, msg, textoLinks)');
const idxAudio = fn.indexOf('responderComAudio(instanceName, msg, fala)');
assert.ok(idxSeparar > -1, 'audio reply must split links from the spoken text');
assert.ok(idxLinksText > idxSeparar, 'links must be sent as a TEXT message');
assert.ok(idxAudio > idxLinksText, 'audio must come AFTER the links text message');
assert.match(fn, /\[resposta em áudio\] \$\{fala\}/, 'history must log the spoken text, not the raw response with URLs');
assert.match(fn, /if \(!fala\) return;/, 'when nothing meaningful remains to speak, skip the audio');

// Saída da IA em texto: markdown de link vira "rótulo: url".
const ia = source.slice(source.indexOf('async function respostaPorIA'));
assert.match(ia.slice(0, ia.indexOf('\n}')), /desfazerLinksMarkdown\(/,
  'AI text output must be sanitized from markdown links');

console.log('audio links contract OK');
