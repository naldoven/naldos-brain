const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const path = require('path');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Initialize Anthropic client
const anthropic = new Anthropic();

// Validate Twilio credentials exist
if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
  console.error('❌ Missing Twilio credentials!');
  console.error('   TWILIO_ACCOUNT_SID:', process.env.TWILIO_ACCOUNT_SID ? '✓' : '✗');
  console.error('   TWILIO_AUTH_TOKEN:', process.env.TWILIO_AUTH_TOKEN ? '✓' : '✗');
  process.exit(1);
}

// Twilio credentials
const twilio_account_sid = process.env.TWILIO_ACCOUNT_SID;
const twilio_auth_token = process.env.TWILIO_AUTH_TOKEN;

// Normalize the WhatsApp "from" number once: strip spaces, guarantee leading +.
// Twilio rejects `whatsapp:+1 631 634 6178` (spaces) — it must be `whatsapp:+16316346178`.
function normalizeWhatsappNumber(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  return `whatsapp:+${digits}`;
}
const TWILIO_WHATSAPP_FROM = normalizeWhatsappNumber(process.env.TWILIO_WHATSAPP_NUMBER);

if (!TWILIO_WHATSAPP_FROM) {
  console.error('❌ Missing or invalid TWILIO_WHATSAPP_NUMBER');
  process.exit(1);
}

const client = twilio(twilio_account_sid, twilio_auth_token);

// Data storage (in production, use a real database)
const DATA_FILE = './naldos_brain_data.json';

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error loading data:', e);
  }
  return {
    captures: [],
    calendar: [],
    feedback: []
  };
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Email transporter (using Gmail or your preferred service)
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
  }
});

// Categorize and process message with Claude
async function processMessage(messageText, fromNumber) {
  const data = loadData();
  
  const systemPrompt = `You are Naldo's AI assistant for his Second Brain system. You receive text captures and need to:
1. Categorize the message into one of: Ideas, Tasks, Calendar, Problems, Notes
2. Extract key information and structure it
3. Provide pushback/feedback if needed based on Naldo's stated goals:
   - Hit $500K revenue this year
   - Pay off $55K business debt
   - Complete 5-6 permanent lighting jobs
   - Land 10+ event/wedding lighting jobs
   - Add 50+ holiday lighting homes
   - Go full time on Yule Love Lights next year
   - Improve quote/sales process
   - Build SOPs and systems

When pushing back, be direct and honest. Call out excuses. Reference his goals if relevant.

Respond in JSON format ONLY:
{
  "category": "Ideas|Tasks|Calendar|Problems|Notes",
  "subcategory": "YuleLoveLights|ChickFilA|Personal",
  "title": "Brief title",
  "description": "Full details",
  "priority": "high|medium|low",
  "dueDate": "YYYY-MM-DD or null",
  "pushback": "Your honest feedback or null if no pushback needed",
  "clarifyingQuestions": ["Question 1", "Question 2"] or []
}`;

  try {
    console.log('🤖 Processing message with Claude...');
    
    if (!anthropic) {
      console.error('❌ Anthropic client not initialized');
      throw new Error('Anthropic client not initialized');
    }

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: messageText
        }
      ]
    });

    console.log('✅ Claude responded');

    const responseText = message.content[0].type === 'text' ? message.content[0].text : '';
    console.log('📝 Parsing response:', responseText.substring(0, 200));

    // Strip markdown code fences if Claude wrapped the JSON in ```json ... ```
    const jsonText = responseText
      .replace(/^\s*```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();

    const parsed = JSON.parse(jsonText);
    
    // Add timestamp and ID
    const capture = {
      id: Date.now().toString(),
      timestamp: new Date().toISOString(),
      fromNumber: fromNumber,
      original: messageText,
      ...parsed
    };

    data.captures.push(capture);
    saveData(data);

    // Send WhatsApp response with pushback or confirmation
    let replyMessage = `✅ Captured: ${parsed.title}\nCategory: ${parsed.category}`;
    
    if (parsed.pushback) {
      replyMessage += `\n\n🤔 Real talk: ${parsed.pushback}`;
    }
    
    if (parsed.clarifyingQuestions && parsed.clarifyingQuestions.length > 0) {
      replyMessage += `\n\nNeed clarity:\n` + parsed.clarifyingQuestions.map((q, i) => `${i+1}. ${q}`).join('\n');
    }

    console.log(`📤 Sending response to ${fromNumber}`);

    await client.messages.create({
      from: TWILIO_WHATSAPP_FROM,
      to: `whatsapp:${fromNumber}`,
      body: replyMessage
    });

    return capture;
  } catch (error) {
    console.error('Error processing message:', error);
    try {
      await client.messages.create({
        from: TWILIO_WHATSAPP_FROM,
        to: `whatsapp:${fromNumber}`,
        body: `❌ Error processing your message: ${error.message || 'unknown error'}`
      });
    } catch (sendErr) {
      console.error('Error sending error reply:', sendErr);
    }
    throw error;
  }
}

// Generate morning digest
async function generateMorningDigest() {
  const data = loadData();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  
  const yesterdayCaptures = data.captures.filter(c => {
    const captureDate = new Date(c.timestamp);
    return captureDate.toDateString() === yesterday.toDateString();
  });

  const highPriority = data.captures.filter(c => c.priority === 'high').slice(-5);
  
  let digest = `🌅 NALDO'S BRAIN - MORNING DIGEST\n${new Date().toLocaleDateString()}\n\n`;
  digest += `📊 YESTERDAY'S CAPTURES (${yesterdayCaptures.length})\n`;
  
  yesterdayCaptures.forEach(c => {
    digest += `\n• [${c.category}] ${c.title}\n`;
  });

  digest += `\n\n🔥 HIGH PRIORITY (Last 5)\n`;
  highPriority.forEach(c => {
    digest += `\n• [${c.category}] ${c.title}\n`;
  });

  digest += `\n\n👀 FOCUS TODAY\nCheck the dashboard for full detail. What's the one thing that moves the needle?\n`;

  return digest;
}

// Generate night digest with agenda and feedback
async function generateNightDigest() {
  const data = loadData();
  const today = new Date();
  
  const todayCaptures = data.captures.filter(c => {
    const captureDate = new Date(c.timestamp);
    return captureDate.toDateString() === today.toDateString();
  });

  const openTasks = data.captures.filter(c => c.category === 'Tasks' && !c.completed);
  const upcoming = data.captures.filter(c => c.category === 'Calendar');

  let digest = `🌙 NALDO'S BRAIN - NIGHT DIGEST\n${new Date().toLocaleDateString()}\n\n`;
  
  digest += `📋 TODAY'S CAPTURES (${todayCaptures.length})\n`;
  todayCaptures.forEach(c => {
    digest += `\n• [${c.category}] ${c.title}\n`;
  });

  digest += `\n\n✅ OPEN TASKS (${openTasks.length})\n`;
  openTasks.slice(0, 10).forEach(c => {
    digest += `\n• ${c.title}\n  Priority: ${c.priority}\n`;
  });

  digest += `\n\n📅 UPCOMING\n`;
  upcoming.slice(0, 5).forEach(c => {
    digest += `\n• ${c.dueDate}: ${c.title}\n`;
  });

  digest += `\n\n💭 MY FEEDBACK\n`;
  digest += `You've been building momentum. Keep the big picture in mind while you execute. `;
  digest += `Remember: $500K revenue, $55K debt payoff, full-time YLL next year.\n`;
  digest += `Which 2-3 things actually move you toward those goals tomorrow?\n`;

  return digest;
}

// Send email digest
async function sendDigest(email, subject, body) {
  try {
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: subject,
      text: body,
      html: `<pre>${body}</pre>`
    });
    console.log(`Digest sent to ${email}`);
  } catch (error) {
    console.error('Error sending email:', error);
  }
}

// Schedule morning digest (8 AM ET)
cron.schedule('0 8 * * *', async () => {
  console.log('Generating morning digest...');
  const digest = await generateMorningDigest();
  await sendDigest(process.env.NALDO_EMAIL, '🌅 Naldo\'s Brain - Morning Digest', digest);
}, { timezone: 'America/New_York' });

// Schedule night digest (10 PM ET)
cron.schedule('0 22 * * *', async () => {
  console.log('Generating night digest...');
  const digest = await generateNightDigest();
  await sendDigest(process.env.NALDO_EMAIL, '🌙 Naldo\'s Brain - Night Digest', digest);
}, { timezone: 'America/New_York' });

// WhatsApp webhook. Twilio expects a reply within ~15s and retries on non-2xx,
// so ack immediately and do the Claude call asynchronously. The WhatsApp reply
// is sent via the REST API inside processMessage.
app.post('/whatsapp', (req, res) => {
  const incomingMessage = req.body.Body;
  const fromRaw = req.body.From || '';
  const fromNumber = fromRaw.replace('whatsapp:', '');

  console.log(`Message from ${fromNumber}: ${incomingMessage}`);

  res.set('Content-Type', 'text/xml').send('<Response></Response>');

  processMessage(incomingMessage, fromNumber).catch((err) => {
    console.error('Background processMessage failed:', err);
  });
});

// Dashboard data API
app.get('/api/captures', (req, res) => {
  const data = loadData();
  res.json(data.captures);
});

app.get('/api/captures/:category', (req, res) => {
  const data = loadData();
  const filtered = data.captures.filter(c => c.category === req.params.category);
  res.json(filtered);
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Log environment variables on startup (for debugging)
console.log('🔍 Environment Check:');
console.log('   TWILIO_ACCOUNT_SID:', process.env.TWILIO_ACCOUNT_SID ? '✓ SET' : '✗ MISSING');
console.log('   TWILIO_AUTH_TOKEN:', process.env.TWILIO_AUTH_TOKEN ? '✓ SET' : '✗ MISSING');
console.log('   ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ? '✓ SET' : '✗ MISSING');
console.log('   EMAIL_USER:', process.env.EMAIL_USER ? '✓ SET' : '✗ MISSING');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Naldo's Brain backend running on port ${PORT}`);
  console.log(`📱 WhatsApp webhook ready at: /whatsapp`);
  console.log(`🧠 Dashboard API ready at: /api/captures`);
});
