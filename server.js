// ============================================
// VOXLY CHAT BACKEND — server.js
// Handles WhatsApp (WATI) + Web Chat
// Deploy on Railway.app free tier
// ============================================
const express = require('express');
const cors = require('cors');
const path = require('path');
const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ── CONFIG ────────────────────────────────────
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY || '';
const WATI_ENDPOINT  = process.env.WATI_ENDPOINT     || '';
const WATI_TOKEN     = process.env.WATI_TOKEN        || '';
const OWNER_WA       = process.env.OWNER_WHATSAPP    || '';
const BUSINESS_NAME  = process.env.BUSINESS_NAME     || 'Voxly Demo Business';
const BUSINESS_HOURS = process.env.BUSINESS_HOURS    || 'Mon-Fri 9AM-6PM';
const BUSINESS_TYPE  = process.env.BUSINESS_TYPE     || 'restaurant';

// ── IN-MEMORY STORE ───────────────────────────
const conversations = {}; // { phoneNumber: [{role, content}] }
const chatLogs = [];

// ── SYSTEM PROMPTS PER INDUSTRY ──────────────
const getSystemPrompt = (type, name, hours) => {
  const prompts = {
    restaurant: `You are a friendly AI receptionist for ${name}.
Hours: ${hours}
You can: take table reservations (ask party size, date, time, name, phone), answer menu questions, handle takeout inquiries.
Always confirm booking details. Keep responses SHORT — max 2 sentences for WhatsApp. Be warm and professional.
For reservations collect: party size, date, time, name, phone number.`,

    medical: `You are an AI receptionist for ${name} medical clinic.
Hours: ${hours}
You can: book appointments (ask name, DOB, reason, preferred time), handle rescheduling, answer insurance questions.
NEVER give medical advice. For emergencies say: Please call 911 immediately.
Keep responses SHORT and professional.`,

    law: `You are an intake AI receptionist for ${name} law firm.
Hours: ${hours}
You can: collect new client info, book free consultations, explain practice areas.
NEVER give legal advice. Collect: name, phone, brief description of matter.
Keep responses SHORT and professional.`,

    hvac: `You are an AI dispatcher for ${name}.
Hours: ${hours} — 24/7 for emergencies.
For emergencies (no heat, flooding): say technician calls back in 15 minutes.
For scheduled work: offer next available slot. Collect: name, address, phone, issue description.
Keep responses SHORT.`,

    realestate: `You are an AI receptionist for ${name} real estate.
Hours: ${hours}
You can: answer property inquiries, schedule viewings, qualify leads (budget, timeline, area).
Collect: name, phone, what they are looking for.
Keep responses SHORT and professional.`,

    default: `You are a helpful AI receptionist for ${name}.
Hours: ${hours}
You can: answer questions, take messages, book appointments.
Always collect caller name and phone number. Keep responses SHORT — max 2 sentences.`
  };
  return prompts[type] || prompts.default;
};

// ── CLAUDE AI RESPONSE ────────────────────────
async function getAIResponse(phone, userMessage, businessInfo) {
  if (!ANTHROPIC_KEY) {
    return `Hi! I'm the AI assistant for ${BUSINESS_NAME}. I received your message: "${userMessage}". Our team will get back to you shortly during ${BUSINESS_HOURS}.`;
  }

  // Keep conversation history per phone
  if (!conversations[phone]) conversations[phone] = [];
  conversations[phone].push({ role: 'user', content: userMessage });

  // Keep last 10 messages only
  if (conversations[phone].length > 10) {
    conversations[phone] = conversations[phone].slice(-10);
  }

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        system: getSystemPrompt(BUSINESS_TYPE, BUSINESS_NAME, BUSINESS_HOURS),
        messages: conversations[phone]
      })
    });

    const data = await res.json();
    const reply = data.content?.[0]?.text || 'Thank you for your message. We will get back to you shortly.';

    conversations[phone].push({ role: 'assistant', content: reply });

    // Log the interaction
    chatLogs.push({
      id: Date.now().toString(),
      timestamp: new Date().toISOString(),
      channel: 'whatsapp',
      phone,
      userMessage,
      aiReply: reply,
      business: BUSINESS_NAME
    });

    return reply;
  } catch (e) {
    console.error('Claude API error:', e.message);
    return `Thank you for contacting ${BUSINESS_NAME}! We received your message and will respond shortly during ${BUSINESS_HOURS}.`;
  }
}

// ── SEND WHATSAPP REPLY (WATI) ────────────────
async function sendWhatsAppReply(phone, message) {
  if (!WATI_ENDPOINT || !WATI_TOKEN) {
    console.log('WATI not configured — reply would be:', message);
    return;
  }
  try {
    const res = await fetch(
      `${WATI_ENDPOINT}/api/v1/sendSessionMessage/${phone}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${WATI_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ messageText: message })
      }
    );
    console.log('WhatsApp reply sent:', res.status, 'to:', phone);
  } catch (e) {
    console.error('WATI send error:', e.message);
  }
}

// ── NOTIFY OWNER ──────────────────────────────
async function notifyOwner(phone, userMsg, aiReply) {
  if (!OWNER_WA) return;
  const alert =
    `💬 New WhatsApp Message\n\n` +
    `👤 From: ${phone}\n` +
    `📩 Message: ${userMsg}\n` +
    `🤖 AI replied: ${aiReply.substring(0,100)}...`;
  await sendWhatsAppReply(OWNER_WA, alert).catch(()=>{});
}

// ── ROUTES ────────────────────────────────────

// Health check
// Display the Voxly WebChat interface
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Backend health check
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({
    status: 'Voxly Chat Backend running',
    version: '1.0.0',
    business: BUSINESS_NAME,
    channels: ['whatsapp', 'webchat'],
    logs: chatLogs.length,
    time: new Date().toISOString()
  });
});
// WATI WhatsApp webhook
app.post('/whatsapp-webhook', async (req, res) => {
  try {
    console.log('WhatsApp webhook:', JSON.stringify(req.body));
    const body = req.body;

    // WATI sends messages in this format
    const phone   = body?.waId || body?.from || body?.phone || 'unknown';
    const message = body?.text?.body || body?.message || body?.text || '';
    const type    = body?.type || 'text';

    if (!message || type !== 'text') {
      return res.json({ received: true });
    }

    console.log(`WhatsApp from ${phone}: ${message}`);

    // Get AI response
    const reply = await getAIResponse(phone, message, {});

    // Send reply back on WhatsApp
    await sendWhatsAppReply(phone, reply);

    // Notify owner
    await notifyOwner(phone, message, reply);

    res.json({ received: true, replied: true });
  } catch (e) {
    console.error('WhatsApp webhook error:', e.message);
    res.json({ received: true, error: e.message });
  }
});

// Web chat endpoint
app.post('/chat', async (req, res) => {
  try {
    const { message, sessionId } = req.body;
    if (!message) return res.json({ reply: 'Please send a message.' });

    const phone = sessionId || 'webchat-' + Date.now();
    console.log(`Web chat [${phone}]: ${message}`);

    const reply = await getAIResponse(phone, message, {});

    // Log web chat
    chatLogs.push({
      id: Date.now().toString(),
      timestamp: new Date().toISOString(),
      channel: 'webchat',
      sessionId: phone,
      userMessage: message,
      aiReply: reply,
      business: BUSINESS_NAME
    });

    res.json({ reply, sessionId: phone });
  } catch (e) {
    console.error('Chat error:', e.message);
    res.json({ reply: 'Sorry, something went wrong. Please try again.' });
  }
});

// Get all chat logs
app.get('/api/logs', (req, res) => {
  res.json({
    logs: chatLogs.slice(-50).reverse(),
    total: chatLogs.length,
    whatsapp: chatLogs.filter(l=>l.channel==='whatsapp').length,
    webchat:  chatLogs.filter(l=>l.channel==='webchat').length
  });
});

// Test endpoint
app.get('/test', (req, res) => {
  chatLogs.push({
    id: 'test-'+Date.now(),
    timestamp: new Date().toISOString(),
    channel: 'webchat',
    sessionId: 'test-session',
    userMessage: 'Hello I want to book a table',
    aiReply: `Hi! I'd be happy to help you book a table at ${BUSINESS_NAME}. How many people will be dining, and what date and time works for you?`,
    business: BUSINESS_NAME
  });
  res.json({ success: true, message: 'Test log added', total: chatLogs.length });
});

// Clear conversation history for a session
app.delete('/conversation/:phone', (req, res) => {
  delete conversations[req.params.phone];
  res.json({ cleared: true });
});

// ── START ─────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Voxly Chat Backend running on port ${PORT}`);
  console.log(`Business: ${BUSINESS_NAME}`);
  console.log(`Type: ${BUSINESS_TYPE}`);
});
