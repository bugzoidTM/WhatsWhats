# =============================================
# Agente IA WhatsApp — Nutef Soluções Digitais
# Dockerfile para produção (Node 20 + Chromium Alpine)
# =============================================

FROM node:20-alpine

# Dependências do Chromium para Puppeteer headless no Alpine Linux
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    font-noto-emoji \
    && rm -rf /var/cache/apk/*

# Diz ao Puppeteer para usar o Chromium do sistema (não baixar o bundled)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV NODE_ENV=production

# Diretório de trabalho
WORKDIR /app

# Instalar dependências primeiro (cache de camadas)
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copiar código fonte
COPY . .

# Porta exposta (configurável via ENV)
EXPOSE 3000

# Criar diretórios necessários e definir permissões para o usuário sem privilégios (segurança)
RUN mkdir -p /app/instances /app/auth_data && \
    addgroup -g 1001 -S nodejs && \
    adduser -S nodeuser -u 1001 -G nodejs && \
    chown -R nodeuser:nodejs /app

USER nodeuser

# Health check (usando /ping com 127.0.0.1 para evitar problemas de DNS interno e redirects)
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/ping || exit 1

CMD ["node", "server.js"]
