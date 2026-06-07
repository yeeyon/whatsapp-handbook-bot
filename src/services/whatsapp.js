const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const pino = require('pino');
const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  isJidGroup,
} = require('@whiskeysockets/baileys');
const { answerKnowledgeQuestion } = require('./knowledgeBase');
const {
  parseFeedbackMessage,
  getOrCreateConversation,
  markTurnDelivered,
  recordFeedback,
} = require('./conversationMemory');

const logger = pino({ level: 'warn' });
const AUTH_DIR = process.env.AUTH_STATE_DIR || path.join(__dirname, '..', '..', 'auth_info_baileys');

let globalSock = null;
let reconnectTimeout = null;
let qrCodeData = null;
let connectionStatus = 'disconnected';
let io = null;

const setIO = (socketIo) => {
  io = socketIo;
};

const getConnectionStatus = () => connectionStatus;
const getQRCodeData = () => qrCodeData;

const emitStatus = () => {
  if (!io) return;
  io.emit('connection-status', connectionStatus);
  io.emit('qr-code', qrCodeData);
};

const getMessageText = (message) => {
  if (!message?.message) return '';
  return message.message.conversation
    || message.message.extendedTextMessage?.text
    || message.message.imageMessage?.caption
    || '';
};

const isGreeting = (text) => /^(hi|hello|hey|good morning|good afternoon|good evening)\b/i.test(String(text || '').trim());

const buildHelpText = () => (
  'Handbook assistant is ready.\n\n'
  + 'Ask any question about the D\'Starlington Property Handbook.\n\n'
  + 'Examples:\n'
  + '- What are the opening hours for the game room?\n'
  + '- What is the renovation deposit amount?\n'
  + '- What are the rules for the mini theater room?\n'
  + '- What is the replacement fee for access cards?\n'
  + '- Give me emergency contact numbers\n\n'
  + 'Type "help" anytime to see this message.'
);

const showTyping = async (sock, remoteJid, active) => {
  try {
    await sock.sendPresenceUpdate(active ? 'composing' : 'paused', remoteJid);
  } catch (error) {
    console.error('Presence update failed:', error.message);
  }
};

const handleQuestion = async (sock, remoteJid, question) => {
  if (isGreeting(question)) {
    await sock.sendMessage(remoteJid, { text: `👋 Hi there! Welcome to the D'Starlington Property Handbook assistant.\n\n${buildHelpText()}` });
    return;
  }

  if (/^help$/i.test(String(question || '').trim())) {
    await sock.sendMessage(remoteJid, { text: buildHelpText() });
    return;
  }

  await showTyping(sock, remoteJid, true);

  try {
    const conversation = await getOrCreateConversation({ channel: 'whatsapp', externalId: remoteJid });
    const feedback = parseFeedbackMessage(question);
    if (feedback) {
      const recorded = await recordFeedback({ conversationId: conversation.id, feedback });
      const confirmation = !recorded
        ? 'I do not have a previous answer to attach that feedback to.'
        : feedback.type === 'correction'
          ? 'Thanks. I saved that correction for future questions.'
          : feedback.type === 'positive'
            ? 'Thanks. I marked the previous answer as helpful.'
            : 'Thanks. I will stop using that previous answer as learned knowledge.';
      await sock.sendMessage(remoteJid, { text: confirmation });
      return;
    }

    const result = await answerKnowledgeQuestion(question, { conversationId: conversation.id });
    const answer = result.answer || result;
    const improved = result.refined?.improvedQuestion;

    const reply = answer;

    await sock.sendMessage(remoteJid, { text: reply });
    if (result.turnId) await markTurnDelivered(result.turnId);

    const images = Array.isArray(result.images) ? result.images : [];
    // Use total page count from imageDecision (set for direct-page requests)
    const totalPageCount = result.imageDecision?.pageCount || null;
    for (const image of images) {
      const caption = totalPageCount
        ? `Handbook page ${image.pageNumber} of ${totalPageCount}`
        : `Handbook page ${image.pageNumber}`;
      await sock.sendMessage(remoteJid, {
        image: image.buffer,
        caption,
      });
    }

    io?.emit('ai-response', {
      to: remoteJid,
      original: question,
      improved,
      response: answer,
      images: images.map((image) => image.pageNumber),
      timestamp: new Date().toISOString(),
      turnId: result.turnId,
    });
  } finally {
    await showTyping(sock, remoteJid, false);
  }
};

const startWhatsAppBot = async () => {
  connectionStatus = 'connecting';
  emitStatus();

  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }

  const auth = await useMultiFileAuthState(AUTH_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`Baileys WA v${version.join('.')} (latest: ${isLatest})`);

  const sock = makeWASocket({
    version,
    auth: auth.state,
    logger,
    printQRInTerminal: false,
    browser: Browsers.macOS('Desktop'),
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
  });

  globalSock = sock;

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrCodeData = await QRCode.toDataURL(qr);
      connectionStatus = 'waiting-for-scan';
      emitStatus();
      console.log('Scan the QR code in terminal or web UI');
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      connectionStatus = 'disconnected';
      qrCodeData = null;
      emitStatus();
      console.log('WhatsApp disconnected:', lastDisconnect?.error?.message || 'unknown');

      if (shouldReconnect) {
        if (reconnectTimeout) clearTimeout(reconnectTimeout);
        reconnectTimeout = setTimeout(() => {
          console.log('Reconnecting WhatsApp...');
          startWhatsAppBot().catch(console.error);
        }, 5000);
      }
    } else if (connection === 'open') {
      connectionStatus = 'connected';
      qrCodeData = null;
      emitStatus();
      console.log('WhatsApp connected via Baileys');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const message of messages) {
      if (!message.message || message.key.fromMe) continue;

      const remoteJid = message.key.remoteJid;
      if (isJidGroup(remoteJid)) continue;

      const text = getMessageText(message).trim();
      if (!text) continue;

      console.log(`Message from ${remoteJid}: ${text}`);
      io?.emit('new-message', { from: remoteJid, message: text, timestamp: new Date().toISOString() });

      try {
        await handleQuestion(sock, remoteJid, text);
      } catch (error) {
        console.error('Failed to answer handbook question:', error);
        await sock.sendMessage(remoteJid, { text: 'Sorry, I could not answer that right now. Please try again.' });
      }
    }
  });

  sock.ev.on('creds.update', auth.saveCreds);
};

const sendWhatsAppMessage = async (remoteJid, text) => {
  if (!globalSock) {
    throw new Error('WhatsApp bot is not connected');
  }
  await globalSock.sendMessage(remoteJid, { text });
};

const sendWhatsAppImage = async (remoteJid, imageBuffer, caption = '') => {
  if (!globalSock) {
    throw new Error('WhatsApp bot is not connected');
  }
  await globalSock.sendMessage(remoteJid, { image: imageBuffer, caption });
};

const disconnectWhatsAppBot = async () => {
  if (globalSock) {
    await globalSock.logout();
    globalSock = null;
  }
  if (fs.existsSync(AUTH_DIR)) {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  }
  connectionStatus = 'disconnected';
  qrCodeData = null;
  emitStatus();
};

module.exports = {
  startWhatsAppBot,
  disconnectWhatsAppBot,
  setIO,
  getConnectionStatus,
  getQRCodeData,
  sendWhatsAppMessage,
  sendWhatsAppImage,
};
