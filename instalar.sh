#!/bin/bash
# Instalador automático - Agente IA Chatbot FREE na VPS
# Sistema proprietário. © TSG Soluções Digitais
#
# Bibliotecas do Chromium são instaladas CEDO (passo 3) para o QR Code aparecer
# na primeira abertura — Ubuntu minimal da Hostinger não traz essas libs.

echo ""
echo "=============================================="
echo "  INSTALADOR - AGENTE IA CHATBOT FREE (VPS)"
echo "  © TSG Soluções Digitais"
echo "=============================================="
echo ""

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"
set -e
echo "[1/9] Pasta do projeto: $SCRIPT_DIR"
echo ""

echo "[2/9] Atualizando o sistema..."
# Evita prompt do openssh-server (sshd_config) e outros conflitos em upgrade automático
export DEBIAN_FRONTEND=noninteractive
# Se o apt foi interrompido antes (Ctrl+C, SSH caiu, menu do sshd), o dpkg fica “travado”
echo "      Verificando dpkg (reparo se necessário)..."
dpkg --configure -a
apt-get update -qq
apt-get -y -qq -o Dpkg::Options::="--force-confold" -o Dpkg::Options::="--force-confdef" upgrade
echo "      OK"
echo ""

echo "[3/9] Bibliotecas do Chromium (obrigatório para gerar QR Code na VPS)..."
# whatsapp-web.js + Puppeteer: sem isso o navegador headless não sobe e o QR não aparece.
apt-get install -y -qq \
  ca-certificates fonts-liberation wget xdg-utils \
  libgbm1 libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 \
  libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libx11-6 libx11-xcb1 libxcb1 libxext6 libxrender1 libxi6 libxtst6 libxss1 \
  libgtk-3-0 libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libcups2 \
  libglib2.0-0 libfontconfig1 libexpat1 libdbus-1-3 \
  libasound2t64 2>/dev/null || \
apt-get install -y -qq \
  ca-certificates fonts-liberation wget xdg-utils \
  libgbm1 libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 \
  libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libx11-6 libx11-xcb1 libxcb1 libxext6 libxrender1 libxi6 libxtst6 libxss1 \
  libgtk-3-0 libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libcups2 \
  libglib2.0-0 libfontconfig1 libexpat1 libdbus-1-3 \
  libasound2
echo "      OK"
echo ""

if ! command -v node &> /dev/null; then
  echo "[4/9] Instalando Node.js (NodeSource LTS)..."
  curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
  apt-get install -y -qq nodejs
  echo "      OK - Node $(node -v)"
else
  echo "[4/9] Node.js já instalado: $(node -v)"
fi
command -v npm >/dev/null 2>&1 || { echo "ERRO: npm não encontrado. Instale o pacote nodejs completo (NodeSource)."; exit 1; }
echo ""

echo "[5/9] Instalando PM2 (global)..."
npm install -g pm2
hash -r 2>/dev/null || true
command -v pm2 >/dev/null 2>&1 || { echo "ERRO: pm2 não ficou no PATH. Rode: npm install -g pm2 e confira: which pm2"; exit 1; }
echo "      OK — $(command -v pm2)"
echo ""

echo "[6/9] Instalando dependências do chatbot..."
npm install
echo "      OK"
echo ""

pm2 delete agente-chatbot 2>/dev/null || true

echo "[7/9] Iniciando o chatbot..."
pm2 start server.js --name agente-chatbot
echo "      OK"
echo ""

echo "[8/9] Configurando firewall (ufw, se existir)..."
if command -v ufw >/dev/null 2>&1; then
  ufw allow 22 >/dev/null 2>&1 || true
  ufw allow 3000 >/dev/null 2>&1 || true
  echo "y" | ufw enable >/dev/null 2>&1 || true
  echo "      OK"
else
  echo "      (sem ufw — use o firewall do painel da VPS)"
fi
echo ""

echo "[9/9] Início automático ao reiniciar a VPS..."
pm2 save
if sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u root --hp /root > /dev/null 2>&1; then
  pm2 save
  echo "      OK - Bot inicia automaticamente"
else
  echo "      Rode manualmente: pm2 startup (copie a linha) e pm2 save"
fi
echo ""

echo "=============================================="
echo "  PRONTO!"
echo "=============================================="
echo ""
echo ">>> Se o navegador der TIMEOUT em http://IP:3000:"
echo ">>> No PAINEL da Hostinger (ou do provedor): VPS → Firewall / Security"
echo ">>> Libere porta TCP 3000 em ENTRADA (Inbound). O ufw da VPS já permite;"
echo ">>> muitas vezes existe OUTRO firewall só no site — sem isso a página não abre."
echo ""
echo "ACESSE: http://$(curl -s ifconfig.me 2>/dev/null || echo 'SEU_IP'):3000"
echo "Na VPS: pm2 status   |   pm2 logs agente-chatbot"
echo ""
