import fs from 'node:fs';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

function mustMatch(re, message) {
  assert.match(source, re, message);
}

// ── Regra central multi-tenant: nenhuma regra/resposta de negócio no código ──
// Respostas específicas vivem na config da instância (flows, knowledgeBase,
// respostaPadrao, respostaMidia); o código só tem comportamento genérico.
for (const term of [/apostileiros/i, /nutef\.com/i, /R\$\s*\d/, /projeto de extens/i, /trabalho pronto/i]) {
  assert.doesNotMatch(source, term, `business-specific content must not be hardcoded in server.js (found ${term})`);
}

// ── Pipeline de resposta genérico, na ordem documentada ──
mustMatch(/async function\s+gerarRespostaParaTexto\b/, 'must have a single generic text response pipeline');
const pipeline = source.slice(source.indexOf('async function gerarRespostaParaTexto'));
const order = ['respostaPorFluxo', 'respostaParaPedidoLinkProduto', 'respostaPorIA', 'inst.config.respostaPadrao']
  .map((name) => pipeline.indexOf(name));
assert.ok(order.every((i) => i > -1) && order.every((i, n) => n === 0 || i > order[n - 1]),
  'pipeline order must be: flows -> catalog link -> AI -> respostaPadrao fallback');

// ── Catálogo de produtos: opcional e por config, nunca inventa link ──
mustMatch(/config\.catalogoUrl/, 'product catalog must come from per-instance config.catalogoUrl');
mustMatch(/function\s+detectarPedidoLinkProduto\b/, 'must detect product-link requests generically');
mustMatch(/async function\s+buscarProdutoNoCatalogo\b/, 'must look up product links only in the real catalog');

// ── IA por instância: promptSistema + knowledgeBase da config ──
mustMatch(/inst\.config\.promptSistema/, 'AI system prompt must come from instance config');
mustMatch(/inst\.config\.knowledgeBase/, 'AI business knowledge must come from instance config');

console.log('multitenant contract OK');
