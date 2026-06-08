# 📘 Instalar Chatbot na VPS Hostinger (24/7)

**Sistema proprietário. Proibida a venda, revenda ou distribuição sem autorização do autor. © TSG Soluções Digitais**

**Terminal** = um clique no painel da Hostinger. **FileZilla** = enviar os arquivos para a VPS (a VPS não tem gerenciador de arquivos no painel).

---

## ✅ O que você precisa

- VPS Hostinger (plano mais barato já funciona)
- FileZilla (gratuito) — [filezilla-project.org](https://filezilla-project.org/)
- Cerca de 15 a 20 minutos

---

## PASSO 1: Acessar o painel da VPS

1. Entre no [hPanel da Hostinger](https://hpanel.hostinger.com)
2. Vá em **VPS** → clique na seta **❯** ao lado da sua VPS
3. Anote o **IP** e a **senha root** — criada na contratação ou em Acesso root → Alterar. Guarde para o FileZilla e o terminal

---

## PASSO 2: Enviar os arquivos com FileZilla

1. Baixe e instale o **FileZilla** em [filezilla-project.org](https://filezilla-project.org/)
2. Abra o FileZilla
3. No topo, preencha:
   - **Host:** `sftp://NUMERO_DO_IP` (ex: sftp://82.25.74.215)
   - **Usuário:** root
   - **Senha:** senha root
   - **Porta:** 22
4. Clique em **Conexão rápida**
5. No lado **esquerdo**, vá até a pasta **AgenteIAChatbot_FREE_VPS** (a que você descompactou)
6. No lado **direito**, entre em **/root**
7. **Arraste a pasta inteira** AgenteIAChatbot_FREE_VPS da esquerda para a direita
8. Aguarde o upload terminar

---

## PASSO 3: Abrir o Terminal (um clique)

1. Volte ao painel da VPS
2. Clique no botão **Browser terminal** (Terminal do navegador) no canto superior direito
3. Uma nova aba abre — faça login com **root** e a **senha** da VPS
4. Se aparecer "starting serial terminal...", pressione **Enter** algumas vezes até ver o prompt

✅ Você está no terminal, sem instalar nada no seu PC.

---

## PASSO 4: Rodar o script de instalação

**Copie e cole este comando**:

```bash
cd /root/AgenteIAChatbot_FREE_VPS && bash instalar.sh
```

Pressione **Enter** e aguarde (5 a 10 minutos na primeira vez). O script configura tudo automaticamente, inclusive o início ao reiniciar a VPS.

---

## PASSO 5: Acessar o painel do chatbot

1. Abra o navegador
2. Digite: **http://SEU_IP:3000** (ex: http://123.45.67.89:3000)
3. Use **http** (não https)
4. Aguarde o QR Code e escaneie com o WhatsApp

---

## ⏰ Roda 24 horas por dia?

**Sim.** O PM2 mantém o bot ligado 24/7. Seu computador pode ficar desligado.

---

## 🚀 Quer enviar PDF, imagens, áudio e vídeo? (Versão PRO)

A versão PRO permite enviar arquivos pelo próprio painel — sem acessar o servidor. O bot e a IA podem enviar catálogos, fotos, áudios e vídeos no WhatsApp.

**Para fazer o upgrade** (pelo FileZilla):

1. Baixe a pasta **AgenteIAChatbot_PRO_VPS**
2. No FileZilla, conecte na VPS e vá até **AgenteIAChatbot_FREE_VPS**
3. **Substitua** estes arquivos pelos da versão PRO:
   - `server.js`
   - `package.json`
   - Pasta `public` inteira (substitua o index.html)
4. Crie a pasta **arquivos** (se não existir) — pode ficar vazia
5. Abra o **Browser terminal** e rode:
   ```bash
   cd /root/AgenteIAChatbot_FREE_VPS && npm install && pm2 restart agente-chatbot
   ```
6. Pronto! Acesse de novo **http://SEU_IP:3000** — a aba **Meus Arquivos** vai aparecer.

Sua chave Groq, fluxos e conexão do WhatsApp continuam iguais. Só ganha a parte de enviar arquivos.

---

## Comandos úteis (no Browser terminal)

| Comando | O que faz |
|---------|-----------|
| `pm2 status` | Ver se o bot está rodando |
| `pm2 logs agente-chatbot` | Ver logs em tempo real |
| `pm2 restart agente-chatbot` | Reiniciar o bot |

Para sair dos logs: **Ctrl + C**

---

## Problemas comuns

| Problema | Solução |
|----------|---------|
| Página não abre | Verifique o IP e use `http://` (não https). Confira: `pm2 status` |
| QR Code não aparece | Aguarde 2–3 min. Veja os logs: `pm2 logs agente-chatbot` |
| Bot parou | `pm2 restart agente-chatbot` |
| "Cannot find module" | Entre na pasta: `cd /root/AgenteIAChatbot_FREE_VPS` e rode `npm install` |

---

## Resumo rápido

1. **FileZilla** → arrastar pasta para /root
2. **Browser terminal** → `cd /root/AgenteIAChatbot_FREE_VPS && bash instalar.sh`
3. Acessar **http://SEU_IP:3000**
5. *(Opcional)* Quer enviar arquivos? Veja a seção "Versão PRO" acima

---

**Pronto!** Seu chatbot fica rodando 24 horas por dia na nuvem.

**Sistema proprietário. Proibida a venda, revenda ou distribuição sem autorização do autor. © TSG Soluções Digitais**
