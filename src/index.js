const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const socketIo = require('socket.io');
require('dotenv').config();

const { initDatabase } = require('./config/database');
const {
  startWhatsAppBot,
  disconnectWhatsAppBot,
  setIO,
  getConnectionStatus,
  getQRCodeData,
  sendWhatsAppMessage,
  sendWhatsAppImage,
} = require('./services/whatsapp');
const { answerKnowledgeQuestion, listKnowledgeSources } = require('./services/knowledgeBase');
const {
  getOrCreateConversation,
  markTurnDelivered,
  recordFeedback,
} = require('./services/conversationMemory');
const { getPageImagePath } = require('./services/pageImages');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

setIO(io);

io.on('connection', (socket) => {
  socket.emit('connection-status', getConnectionStatus());
  if (getQRCodeData()) socket.emit('qr-code', getQRCodeData());

  socket.on('reconnect-bot', () => {
    startWhatsAppBot().catch(console.error);
  });
});

app.get('/api/health', async (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/whatsapp/status', (_req, res) => {
  res.json({ status: getConnectionStatus(), hasQR: Boolean(getQRCodeData()) });
});

app.get('/api/handbook/pages/:sourceId/:pageNumber/image', (req, res) => {
  const sourceId = Number(req.params.sourceId);
  const pageNumber = Number(req.params.pageNumber);
  const imagePath = getPageImagePath(sourceId, pageNumber);

  if (!Number.isFinite(sourceId) || !Number.isFinite(pageNumber) || !fs.existsSync(imagePath)) {
    return res.status(404).json({ error: 'Handbook page image not found' });
  }

  return res.sendFile(path.resolve(imagePath));
});

app.get('/api/knowledge/sources', async (_req, res) => {
  try {
    const sources = await listKnowledgeSources();
    res.json(sources);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/knowledge/ask', async (req, res) => {
  try {
    const { question, conversationKey } = req.body;
    if (!question) return res.status(400).json({ error: 'Question is required' });
    const result = await answerKnowledgeQuestion(question, {
      channel: 'api',
      conversationKey: conversationKey || `request-${Date.now()}`,
    });
    if (result.turnId) await markTurnDelivered(result.turnId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/knowledge/feedback', async (req, res) => {
  try {
    const { conversationKey, type, content } = req.body;
    if (!conversationKey) return res.status(400).json({ error: 'conversationKey is required' });
    if (!['positive', 'negative', 'correction'].includes(type)) {
      return res.status(400).json({ error: 'type must be positive, negative, or correction' });
    }
    if (type === 'correction' && !String(content || '').trim()) {
      return res.status(400).json({ error: 'content is required for a correction' });
    }

    const conversation = await getOrCreateConversation({ channel: 'api', externalId: conversationKey });
    const recorded = await recordFeedback({
      conversationId: conversation.id,
      feedback: { type, content: String(content || '').trim() || null },
    });
    if (!recorded) return res.status(404).json({ error: 'No delivered answer found for this conversation' });
    return res.json({ success: true, turnId: recorded.turn.id, feedback: recorded.feedback });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get('/api/whatsapp/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    console.log('Webhook verification received');
    return res.status(200).send(challenge);
  }
  return res.json({ status: 'active', message: 'WhatsApp Webhook Endpoint' });
});

app.post('/api/whatsapp/webhook', async (req, res) => {
  try {
    let text = '';
    let sender = '';

    if (req.body.Body) {
      text = req.body.Body;
    } else if (req.body.message) {
      text = req.body.message;
    } else if (req.body.text) {
      text = req.body.text;
    } else if (req.body.question) {
      text = req.body.question;
    } else if (req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.text?.body) {
      text = req.body.entry[0].changes[0].value.messages[0].text.body;
    }

    if (req.body.From) {
      sender = req.body.From;
    } else if (req.body.sender) {
      sender = req.body.sender;
    } else if (req.body.userId) {
      sender = req.body.userId;
    } else if (req.body.phone) {
      sender = req.body.phone;
    } else if (req.body.remoteJid) {
      sender = req.body.remoteJid;
    } else if (req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from) {
      sender = req.body.entry[0].changes[0].value.messages[0].from;
    }

    text = String(text || '').trim();
    sender = String(sender || '').trim();

    if (!text) {
      return res.status(400).json({ error: 'Message body/text is required' });
    }

    console.log(`Webhook message from ${sender || 'unknown'}: ${text}`);

    // Call the handbook RAG answer knowledge question pipeline
    const result = await answerKnowledgeQuestion(text, {
      channel: 'whatsapp-webhook',
      conversationKey: sender || `webhook-${Date.now()}`,
    });

    const answer = result.answer || result;

    if (result.turnId) {
      await markTurnDelivered(result.turnId);
    }

    // 1. Twilio Routing: reply via TwiML XML
    if (req.body.From) {
      res.type('text/xml');
      return res.send(`
<Response>
  <Message>${answer}</Message>
</Response>
      `.trim());
    }

    // 2. Baileys Routing: send to JID directly if socket is connected
    if (sender) {
      let jid = sender;
      if (jid.startsWith('whatsapp:')) {
        jid = jid.replace('whatsapp:', '');
      }
      if (!jid.includes('@')) {
        const cleanedPhone = jid.replace(/\D/g, '');
        if (cleanedPhone) {
          jid = `${cleanedPhone}@s.whatsapp.net`;
        }
      }
      if (jid.includes('@s.whatsapp.net') || jid.includes('@g.us')) {
        try {
          await sendWhatsAppMessage(jid, answer);
          console.log(`Routed response back to WhatsApp via socket: ${jid}`);

          // Send page images if any
          const images = Array.isArray(result.images) ? result.images : [];
          const totalPageCount = result.imageDecision?.pageCount || null;
          for (const image of images) {
            const caption = totalPageCount
              ? `Handbook page ${image.pageNumber} of ${totalPageCount}`
              : `Handbook page ${image.pageNumber}`;
            try {
              await sendWhatsAppImage(jid, image.buffer, caption);
            } catch (imgErr) {
              console.warn(`Could not send page image via socket: ${imgErr.message}`);
            }
          }
        } catch (err) {
          console.warn(`Could not route via socket: ${err.message}`);
        }
      }
    }

    // 3. Return generic JSON response
    return res.json({
      status: 'success',
      reply: answer,
      sender,
      turnId: result.turnId,
    });
  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/whatsapp/logout', async (_req, res) => {
  try {
    await disconnectWhatsAppBot();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const boot = async () => {
  await initDatabase();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Handbook bot running on port ${PORT}`);
    startWhatsAppBot().catch(console.error);
  });
};

boot().catch((error) => {
  console.error('Failed to start app:', error);
  process.exit(1);
});
