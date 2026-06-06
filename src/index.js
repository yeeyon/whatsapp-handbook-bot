const express = require('express');
const http = require('http');
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
} = require('./services/whatsapp');
const { answerKnowledgeQuestion, listKnowledgeSources } = require('./services/knowledgeBase');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const PORT = process.env.PORT || 3001;

app.use(express.json());
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
    const { question } = req.body;
    if (!question) return res.status(400).json({ error: 'Question is required' });
    const result = await answerKnowledgeQuestion(question);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
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
