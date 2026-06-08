# 🚀 Deploy na VPS via GitHub + Portainer

**Nutef - Soluções Digitais** | Agente IA WhatsApp

---

## PRÉ-REQUISITOS

Antes de começar, você precisa ter:
- ✅ VPS com Docker Swarm inicializado (`docker swarm init`)
- ✅ Traefik rodando na rede `Nutef` (já configurado)
- ✅ Portainer instalado e acessível
- ✅ Um domínio apontando para o IP da VPS (ex: `whatsapp.nutef.com.br`)

---

## PASSO 1 — Subir o código para o GitHub

No **seu computador local**, dentro da pasta `d:/sistemas/MyEvolutionAPI`:

```bash
# 1. Inicializar repositório Git (se ainda não foi feito)
git init

# 2. Adicionar todos os arquivos (o .gitignore já protege dados sensíveis)
git add .
git commit -m "feat: Agente IA WhatsApp - Nutef"

# 3. Criar/Verificar repositório no GitHub (já foi feito e empurrado)
#    Repositório: https://github.com/bugzoidTM/WhatsWhats

# 4. Conectar e fazer push (já realizado no repositório principal)
git remote add origin https://github.com/bugzoidTM/WhatsWhats.git
git branch -M main
git push -u origin main
```

---

## PASSO 2 — Clonar na VPS

Conecte na VPS via SSH e execute:

```bash
# Acessar via SSH
ssh root@IP_DA_VPS

# Ir para o diretório de aplicações
cd /opt

# Clonar o repositório
git clone https://github.com/bugzoidTM/WhatsWhats.git agente-ia-whatsapp

# Entrar na pasta
cd /opt/agente-ia-whatsapp
```

---

## PASSO 3 — Construir a imagem Docker

```bash
# Na VPS, dentro de /opt/agente-ia-whatsapp:

# Construir a imagem (isso pode levar 2-5 minutos na primeira vez)
docker build -t nutef/agente-ia-whatsapp:latest .

# Verificar se a imagem foi criada
docker images | grep agente-ia
```

> **💡 Dica:** Em vez de construir na VPS, você pode usar o GitHub Actions para construir e publicar no Docker Hub automaticamente (solicite ao suporte Nutef para configurar o CI/CD).

---

## PASSO 4 — Deploy pelo Portainer

### Opção A: Importar o docker-compose.yml pelo Portainer (Recomendado)

1. Acesse o Portainer (ex: `https://portainer.nutef.com.br`)
2. Vá em **Stacks** → **Add stack**
3. Dê um nome: `agente-ia-whatsapp`
4. Selecione **"Upload"** e suba o arquivo `docker-compose.yml` do projeto
5. Em **"Environment variables"**, adicione:

| Variável | Valor |
|----------|-------|
| `DOMAIN` | `whatsapp.nutef.com.br` (seu domínio real) |
| `SESSION_SECRET` | Cole o resultado de: `openssl rand -hex 32` |

6. Clique em **Deploy the stack**

### Opção B: Colar o conteúdo direto no Portainer

1. Abra o Portainer → **Stacks** → **Add stack**
2. Dê o nome `agente-ia-whatsapp`
3. Selecione **"Web editor"**
4. Cole o conteúdo do arquivo `docker-compose.yml`
5. Configure as variáveis de ambiente e clique em **Deploy**

---

## PASSO 5 — Primeiro acesso

1. Aguarde 1-2 minutos para o container inicializar
2. Acesse: `https://whatsapp.nutef.com.br`
3. Você será redirecionado para a **tela de setup** (primeiro acesso)
4. Defina a senha do painel administrativo
5. Faça login e crie sua primeira instância WhatsApp
6. Escaneie o QR Code com o WhatsApp → **Aparelhos conectados**

---

## ATUALIZAR O SISTEMA (após mudanças no código)

```bash
# Na VPS
cd /opt/agente-ia-whatsapp

# Puxar novas alterações do GitHub
git pull origin main

# Reconstruir a imagem
docker build -t nutef/agente-ia-whatsapp:latest .

# Forçar atualização do serviço no Swarm (zero-downtime)
docker service update --force agente-ia-whatsapp_agente-ia-whatsapp
```

---

## BACKUP DAS SESSÕES WHATSAPP

Os dados das instâncias ficam no volume Docker `agente_ia_instances`. Para fazer backup:

```bash
# Criar backup
docker run --rm \
  -v agente_ia_instances:/data \
  -v /opt/backups:/backup \
  alpine tar czf /backup/instances-$(date +%Y%m%d).tar.gz /data

# Listar backups
ls -lh /opt/backups/
```

---

## TROUBLESHOOTING

### Container não inicia
```bash
# Ver logs do serviço
docker service logs agente-ia-whatsapp_agente-ia-whatsapp --follow
```

### QR Code não aparece
```bash
# Verificar se o Chromium está instalado no container
docker exec -it $(docker ps -q -f name=agente-ia) chromium-browser --version
```

### Resetar senha do painel
```bash
# Remover o volume de autenticação (vai pedir nova senha no próximo acesso)
docker volume rm agente_ia_auth
# Depois force a recriação do serviço
docker service update --force agente-ia-whatsapp_agente-ia-whatsapp
```

---

## SUPORTE

📱 WhatsApp: [(11) 91821-6190](https://wa.me/5511918216190)  
🌐 Site: [nutef.com.br](https://nutef.com.br)
