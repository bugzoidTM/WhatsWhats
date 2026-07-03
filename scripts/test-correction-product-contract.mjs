import fs from 'node:fs';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

function mustMatch(re, message) {
  assert.match(source, re, message);
}

mustMatch(/function\s+detectarIntencaoCorrecao\b/, 'must detect correction intent before commercial ready-work intent');
mustMatch(/function\s+respostaParaCorrecao\b/, 'must have a dedicated correction response helper');
mustMatch(/correção é gratuita|correcao e gratuita/i, 'correction helper must say correction is free if the work was made by Apostileiros');
mustMatch(/feito por nós|feito conosco|foi feito pela nossa equipe/i, 'correction helper must first ask/confirm whether the work was made by Apostileiros');
mustMatch(/arquivo.*orientaç|orientaç.*arquivo/is, 'correction helper must ask for file plus correction instructions');
mustMatch(/function\s+detectarPedidoLinkProduto\b/, 'must detect product-link purchase requests');
mustMatch(/async function\s+buscarProdutoApostileiros\b/, 'must verify product links against Apostileiros product pages');
mustMatch(/todos-nossos-produtos/, 'product lookup must use the Apostileiros product catalog');
mustMatch(/function\s+extrairProdutosApostileiros\b/, 'must parse product titles/links from catalog HTML');
mustMatch(/function\s+pontuarProdutoApostileiros\b/, 'must rank catalog products against conversation terms');
mustMatch(/async function\s+respostaParaPedidoLinkProduto\b/, 'must have a dedicated product-link response helper');
mustMatch(/não encontrei|nao encontrei|não achei|nao achei/i, 'product-link helper must avoid inventing links when no adequate product is found');
mustMatch(/respostaParaCorrecao\(texto, state, history\)/, 'gerarRespostaParaTexto must prioritize correction helper');
mustMatch(/await\s+respostaParaPedidoLinkProduto\(texto, history\)/, 'gerarRespostaParaTexto must try product-link lookup before generic commercial repetition');
mustMatch(/contexto\.querCorrecao[\s\S]*return null;/, 'commercial ready-work response must not fire when correction context exists');

console.log('correction/product-link contract OK');
