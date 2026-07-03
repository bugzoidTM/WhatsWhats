import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const serverPath = path.join(root, 'server.js');
const source = fs.readFileSync(serverPath, 'utf8');

assert.match(source, /manual-pauses\.json/, 'manual pause state must be persisted per instance in manual-pauses.json');
assert.match(source, /const\s+MANUAL_PAUSE_MS\b/, 'manual pause window constant must exist');
assert.match(source, /function\s+pauseAutomationForCustomer\b/, 'must expose a helper to pause one customer after manual intervention');
assert.match(source, /function\s+isAutomationPausedForCustomer\b/, 'must expose a helper to check whether one customer is still paused');
assert.match(source, /function\s+markAutomationOutgoing\b/, 'must mark bot/internal outbound sends so they do not trigger manual pauses');
assert.match(source, /message_create/, 'must listen to whatsapp-web.js message_create events to detect WhatsApp/Web manual outbound messages');
assert.match(source, /handleManualOutboundMessage/, 'message_create listener must delegate to manual outbound pause logic');
assert.match(source, /pendingResponses\.delete\(`\$\{instanceName\}:\$\{remoteJid\}`\)/, 'manual intervention must cancel any pending buffered bot response for that customer');
assert.match(source, /isAutomationPausedForCustomer\(instanceName, msg\.from\)/, 'customer inbound handling must skip automation while that customer is paused');
assert.match(source, /isAutomationPausedForCustomer\(instanceName, msg\.from\)[\s\S]{0,300}return;/, 'paused customer media/text handlers must return before automatic replies or attendant notifications');

console.log('manual pause contract OK');
