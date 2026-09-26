require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const { DateTime } = require('luxon');
const Anthropic = require('@anthropic-ai/sdk');
const rateLimit = require('express-rate-limit');

const app = express();

// Only allow the exact origins that legitimately serve this frontend. Wide-open
// CORS on a server that holds a paid API key (Anthropic) would let ANY website
// silently trigger billed requests through a visitor's browser. "null" covers
// index.html opened directly via file:// during local development.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000,null')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
app.use(cors({
  origin(origin, callback) {
    // No Origin header = same-origin request (the normal production case, since
    // this server also serves index.html) or a non-browser client — always allow.
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
}));
app.use(express.json({ limit: '100kb' }));

// Serve the single-file frontend from the same origin as the API — one URL,
// no CORS needed in production. Only this one file is exposed (not the whole
// project root, which holds secrets like .env and the service account key).
// Supports both layouts: index.html next to server.js (flat deploy repo) or
// one level up (local dev, where server.js lives in a server/ subfolder).
const fs = require('fs');
const INDEX_HTML_PATH = fs.existsSync(path.join(__dirname, 'index.html'))
  ? path.join(__dirname, 'index.html')
  : path.join(__dirname, '..', 'index.html');
app.get('/', (req, res) => {
  res.sendFile(INDEX_HTML_PATH);
});

const PORT = process.env.PORT || 3000;
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
const TIMEZONE = 'Asia/Jerusalem';
const KEY_PATH = path.join(__dirname, '..', 'chatbot-ia-506121-d2f7891c06d9.json');
const SEARCH_DAYS = 21;
const SLOT_STEP_MINUTES = 30;

// ---- AI chat (Claude) ----
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CHAT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;
const SALON_ADDRESS = 'רחוב הרצל 45, נתניה';
const DAY_LABELS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

// ---- Contact form -> Google Sheets ----
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SHEET_ID = process.env.SHEET_ID || '14TrzpF7RSCjYGTX3QepIB5CcVRtPveW6_p7mRiukxPk';
const SHEET_RANGE = process.env.SHEET_RANGE || 'A:E';
// Defaults to the same service account key already used for Calendar (KEY_PATH,
// at the project root). Override with GOOGLE_SERVICE_ACCOUNT_KEY_PATH to point
// server/config/ (gitignored) or elsewhere, e.g. for a dedicated Sheets-only key.
const SHEETS_KEY_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH
  ? path.resolve(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH)
  : KEY_PATH;

// Matches the services offered in the chatbot (id -> label + duration in minutes)
const SERVICES = {
  'women-cut': { label: 'תספורת נשים + פן', duration: 60 },
  'men-cut': { label: 'תספורת גברים', duration: 30 },
  color: { label: 'צבע מלא / גוונים', duration: 150 },
  keratin: { label: 'החלקת קרטין', duration: 180 },
  treatment: { label: 'טיפול שיקום עמוק', duration: 45 },
  bridal: { label: 'תסרוקת כלה / ערב', duration: 120 },
};

// Business hours per weekday, JS/Luxon convention: 0=Sunday ... 6=Saturday. Absent = closed.
const HOURS = {
  0: [9, 20],
  1: [9, 20],
  2: [9, 20],
  3: [9, 20],
  4: [9, 20],
  5: [9, 14],
};

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

let calendarPromise = null;
function getCalendar() {
  if (!calendarPromise) {
    // On a host without local file access (e.g. Render), set GOOGLE_SERVICE_ACCOUNT_JSON
    // to the full contents of the service account key. Locally, it falls back to the file.
    const authOptions = { scopes: ['https://www.googleapis.com/auth/calendar'] };
    if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      authOptions.credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    } else {
      authOptions.keyFile = KEY_PATH;
    }
    const auth = new google.auth.GoogleAuth(authOptions);
    calendarPromise = auth
      .getClient()
      .then((authClient) => google.calendar({ version: 'v3', auth: authClient }));
  }
  return calendarPromise;
}

let sheetsPromise = null;
function getSheets() {
  if (!sheetsPromise) {
    // Same pattern as getCalendar(): on a host with no local file access (e.g. Render),
    // set GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON to the full contents of the key instead.
    const authOptions = { scopes: ['https://www.googleapis.com/auth/spreadsheets'] };
    if (process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON) {
      authOptions.credentials = JSON.parse(process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON);
    } else if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      // Same account/key as Calendar (see getCalendar) — reuse it unless a
      // Sheets-specific key was provided above.
      authOptions.credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    } else {
      authOptions.keyFile = SHEETS_KEY_PATH;
    }
    const auth = new google.auth.GoogleAuth(authOptions);
    sheetsPromise = auth
      .getClient()
      .then((authClient) => google.sheets({ version: 'v4', auth: authClient }));
  }
  return sheetsPromise;
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

async function getBusyIntervals(timeMin, timeMax) {
  const calendar = await getCalendar();
  const res = await calendar.freebusy.query({
    requestBody: {
      timeMin: timeMin.toUTC().toISO(),
      timeMax: timeMax.toUTC().toISO(),
      items: [{ id: CALENDAR_ID }],
    },
  });
  const calendarData = res.data.calendars && res.data.calendars[CALENDAR_ID];
  if (!calendarData) {
    throw httpError(
      502,
      'לא ניתן לגשת ליומן. ודאו שהיומן שותף עם חשבון השירות עם הרשאת "לבצע שינויים באירועים".'
    );
  }
  return (calendarData.busy || []).map((b) => ({
    start: DateTime.fromISO(b.start),
    end: DateTime.fromISO(b.end),
  }));
}

// options.count caps the number of slots returned (stops searching early, used by the
// AI chat tool for a short conversational reply). options.days caps how many days ahead
// to search instead (used by the week picker, which wants every free slot in that range,
// not just the first few). Defaults preserve the original "first few slots" behavior.
async function findAvailableSlots(serviceId, options) {
  const service = SERVICES[serviceId];
  if (!service) throw httpError(400, 'שירות לא ידוע');

  const opts = options || {};
  const count = opts.count;
  const days = Math.min(opts.days || SEARCH_DAYS, SEARCH_DAYS);

  const now = DateTime.now().setZone(TIMEZONE);
  const searchStart = now.plus({ days: 1 }).startOf('day');
  const searchEnd = searchStart.plus({ days });

  const busy = await getBusyIntervals(searchStart, searchEnd);
  const slots = [];
  const hasCount = Number.isFinite(count);

  for (let d = 0; d < days && !(hasCount && slots.length >= count); d++) {
    const day = searchStart.plus({ days: d });
    const jsWeekday = day.weekday % 7; // luxon 1..7 (Mon..Sun) -> JS 0..6 (Sun..Sat)
    const hours = HOURS[jsWeekday];
    if (!hours) continue; // closed that day

    const [openHour, closeHour] = hours;
    let candidate = day.set({ hour: openHour, minute: 0, second: 0, millisecond: 0 });
    const dayClose = day.set({ hour: closeHour, minute: 0, second: 0, millisecond: 0 });

    while (candidate.plus({ minutes: service.duration }) <= dayClose && !(hasCount && slots.length >= count)) {
      const slotEnd = candidate.plus({ minutes: service.duration });
      const isBusy = busy.some((b) => overlaps(candidate, slotEnd, b.start, b.end));
      if (!isBusy) {
        slots.push({ date: candidate.toFormat('yyyy-LL-dd'), time: candidate.toFormat('HH:mm') });
      }
      candidate = candidate.plus({ minutes: SLOT_STEP_MINUTES });
    }
  }

  return slots;
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, calendarConfigured: Boolean(CALENDAR_ID) });
});

app.get('/api/availability', async (req, res, next) => {
  try {
    const serviceId = req.query.serviceId;
    const count = Math.min(parseInt(req.query.count, 10) || 3, 6);
    if (!CALENDAR_ID) throw httpError(500, 'GOOGLE_CALENDAR_ID לא מוגדר בשרת');
    const slots = await findAvailableSlots(serviceId, { count });
    res.json({ slots });
  } catch (err) {
    next(err);
  }
});

// Every free slot over the next N days (default a week), grouped by the frontend into a
// day-by-day picker so the client can see the whole week at once instead of only the
// first few slots.
app.get('/api/availability/week', async (req, res, next) => {
  try {
    const serviceId = req.query.serviceId;
    const days = Math.min(parseInt(req.query.days, 10) || 7, SEARCH_DAYS);
    if (!CALENDAR_ID) throw httpError(500, 'GOOGLE_CALENDAR_ID לא מוגדר בשרת');
    const slots = await findAvailableSlots(serviceId, { days });
    res.json({ slots });
  } catch (err) {
    next(err);
  }
});

async function bookAppointment({ serviceId, date, time, name, phone }) {
  if (!CALENDAR_ID) throw httpError(500, 'GOOGLE_CALENDAR_ID לא מוגדר בשרת');
  const service = SERVICES[serviceId];
  if (!service) throw httpError(400, 'שירות לא ידוע');
  if (!date || !time) throw httpError(400, 'חסר תאריך או שעה');
  if (!name || !String(name).trim()) throw httpError(400, 'חסר שם מלא');
  if (!phone || !String(phone).trim()) throw httpError(400, 'חסר מספר טלפון');

  const start = DateTime.fromISO(`${date}T${time}`, { zone: TIMEZONE });
  if (!start.isValid) throw httpError(400, 'תאריך או שעה לא תקינים');
  if (start < DateTime.now().setZone(TIMEZONE)) throw httpError(400, 'לא ניתן לקבוע תור בעבר');
  const end = start.plus({ minutes: service.duration });

  // Re-check the slot is still free right before booking (avoid double-booking races).
  const busy = await getBusyIntervals(start, end);
  const stillFree = !busy.some((b) => overlaps(start, end, b.start, b.end));
  if (!stillFree) {
    const err = httpError(409, 'המועד הזה כבר תפוס, נסו מועד אחר.');
    err.conflict = true;
    throw err;
  }

  const calendar = await getCalendar();
  const event = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    requestBody: {
      summary: `Vibhair — ${service.label} — ${name}`,
      description: `שירות: ${service.label}\nטלפון: ${phone}\nמקור: צ'אטבוט האתר (Vibhair)`,
      start: { dateTime: start.toISO(), timeZone: TIMEZONE },
      end: { dateTime: end.toISO(), timeZone: TIMEZONE },
    },
  });

  const refId = `VB-${event.data.id.slice(0, 6).toUpperCase()}`;
  return {
    success: true,
    refId,
    eventId: event.data.id,
    htmlLink: event.data.htmlLink,
    serviceId,
    date,
    time,
    serviceLabel: service.label,
  };
}

app.post('/api/book', async (req, res, next) => {
  try {
    const data = await bookAppointment(req.body || {});
    res.json(data);
  } catch (err) {
    if (err.conflict) {
      return res.status(409).json({ error: 'slot_taken', message: err.message });
    }
    next(err);
  }
});

app.post('/submit-form', async (req, res, next) => {
  try {
    const { name, phone, email, message } = req.body || {};
    if (!name || !String(name).trim()) throw httpError(400, 'חסר שם מלא');
    if (!phone || !String(phone).trim()) throw httpError(400, 'חסר מספר טלפון');
    if (!email || !EMAIL_PATTERN.test(String(email).trim())) throw httpError(400, 'כתובת אימייל לא תקינה');

    const timestamp = DateTime.now().setZone(TIMEZONE).toFormat('dd/LL/yyyy HH:mm:ss');
    const row = [
      timestamp,
      String(name).trim(),
      String(phone).trim(),
      String(email).trim(),
      message ? String(message).trim() : '',
    ];

    const sheets = await getSheets();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: SHEET_RANGE,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });

    res.json({ success: true, message: 'ההודעה נשלחה בהצלחה!' });
  } catch (err) {
    if (err.code || err.response) {
      // googleapis errors don't carry a friendly .status/.message for the client
      console.error('Google Sheets append failed:', err.message);
      return res.status(502).json({
        error: 'sheets_error',
        message: 'לא ניתן היה לשמור את ההודעה כרגע. אפשר לנסות שוב או ליצור קשר טלפוני.',
      });
    }
    next(err);
  }
});

// ---- AI chat (Claude) ----

function formatHoursText() {
  return DAY_LABELS.map((label, jsWeekday) => {
    const hours = HOURS[jsWeekday];
    return hours ? `${label}: ${hours[0]}:00–${hours[1]}:00` : `${label}: סגור`;
  }).join(', ');
}

function formatServicesText() {
  return Object.entries(SERVICES)
    .map(([id, s]) => `- ${id}: ${s.label} (משך הטיפול: ${s.duration} דקות)`)
    .join('\n');
}

function buildSystemPrompt() {
  const now = DateTime.now().setZone(TIMEZONE);
  return `את/ה נועה, העוזרת הדיגיטלית החכמה של מספרה/סלון היופי "Vibhair" בנתניה, ישראל. את/ה משוחח/ת עם לקוחות אמיתיים בצ'אט באתר.

מידע עדכני:
- התאריך והשעה כרגע: ${now.toFormat('cccc, dd/LL/yyyy HH:mm')} (אזור זמן ${TIMEZONE}).
- כתובת הסלון: ${SALON_ADDRESS}.
- שעות פעילות הסלון (יום בשבוע: שעות): ${formatHoursText()}.
- רשימת השירותים (מזהה: תיאור ומשך):
${formatServicesText()}

יש לך גישה לשני כלים (tools) שמתחברים בזמן אמת ליומן Google Calendar האמיתי של הסלון:
1. check_availability — בודק מועדים פנויים אמיתיים עבור שירות מסוים, תוך התחשבות גם בשעות הפעילות של הסלון וגם באירועים קיימים ביומן.
2. create_booking — קובע תור אמיתי ביומן, רק אחרי שיש שירות, תאריך ושעה מדויקים (שהתקבלו בפועל מ-check_availability), וגם שם מלא ומספר טלפון של הלקוח.

חוקים חשובים שאסור לסטות מהם:
- לעולם אל תמציא/י או תנחש/י מועדים פנויים, שעות פתיחה או פרטים אחרים. כל מידע על זמינות חייב להגיע מקריאה בפועל ל-check_availability.
- אם לקוח מבקש שעה או יום מסוים, יש להשתמש ב-check_availability כדי לראות מה באמת פנוי סביב הבקשה שלו, ולהציע ללקוח רק מועדים שחזרו בפועל מהכלי.
- לפני קריאה ל-create_booking יש לוודא שהלקוח אישר במפורש שירות + תאריך + שעה ספציפיים מתוך תוצאה אמיתית של check_availability, ומסר שם מלא ומספר טלפון תקין. אם חסר מידע, יש לשאול אותו בעדינות.
- אם create_booking מחזיר שגיאה (למשל המועד נתפס בינתיים), יש להסביר זאת ללקוח ולהציע לבדוק זמינות מחדש.
- אם הסלון סגור באותו יום/שעה שהלקוח מבקש, יש להסביר זאת בעדינות ולהציע להשתמש ב-check_availability למועדים הקרובים הפנויים בפועל.
- לדבר תמיד בעברית, בטון חם, אישי, מקצועי וממוקד, במשפטים קצרים יחסית לצ'אט.
- אם נשאלת שאלה שלא קשורה לסלון, אפשר לענות בקצרה ולכוון בעדינות בחזרה לנושאי הסלון (שירותים, מחירים, שעות, קביעת תור).`;
}

const CHAT_TOOLS = [
  {
    name: 'check_availability',
    description:
      'בדיקת מועדים פנויים אמיתיים ביומן Google Calendar של הסלון עבור שירות מסוים, בהתחשב בשעות הפעילות של הסלון ובאירועים הקיימים ביומן. יש להשתמש בכלי הזה בכל פעם שלקוח שואל על מועדים פנויים או רוצה לקבוע תור — לעולם לא לנחש שעות.',
    input_schema: {
      type: 'object',
      properties: {
        serviceId: {
          type: 'string',
          enum: Object.keys(SERVICES),
          description: 'מזהה השירות המבוקש',
        },
        count: {
          type: 'integer',
          description: 'כמה מועדים פנויים להחזיר (ברירת מחדל 3, מקסימום 6)',
        },
      },
      required: ['serviceId'],
    },
  },
  {
    name: 'create_booking',
    description:
      'קביעת תור אמיתי ביומן Google Calendar של הסלון. יש להשתמש בכלי הזה רק אחרי שהלקוח אישר במפורש שירות, תאריך ושעה ספציפיים שהתקבלו בפועל מ-check_availability, ומסר שם מלא ומספר טלפון.',
    input_schema: {
      type: 'object',
      properties: {
        serviceId: { type: 'string', enum: Object.keys(SERVICES) },
        date: { type: 'string', description: 'תאריך בפורמט YYYY-MM-DD' },
        time: { type: 'string', description: 'שעה בפורמט HH:mm' },
        name: { type: 'string', description: 'שם מלא של הלקוח' },
        phone: { type: 'string', description: 'מספר טלפון של הלקוח' },
      },
      required: ['serviceId', 'date', 'time', 'name', 'phone'],
    },
  },
];

async function runChatTool(name, input) {
  if (name === 'check_availability') {
    const count = Math.min(parseInt(input.count, 10) || 3, 6);
    const slots = await findAvailableSlots(input.serviceId, { count });
    return { event: { type: 'availability', serviceId: input.serviceId, slots }, payload: { slots } };
  }
  if (name === 'create_booking') {
    const booking = await bookAppointment(input);
    return { event: { type: 'booking', booking }, payload: booking };
  }
  return { event: null, payload: { error: `כלי לא מוכר: ${name}` } };
}

// The Anthropic key is billed per request/token, so this endpoint needs its own
// abuse guard on top of the global CORS lock — a per-IP cap keeps one visitor
// (or a script hammering the endpoint directly) from running up the API bill.
const chatRateLimit = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'יותר מדי הודעות בזמן קצר, נסו שוב בעוד כמה דקות.' },
});

const MAX_MESSAGE_LENGTH = 2000;

app.post('/api/chat', chatRateLimit, async (req, res, next) => {
  try {
    if (!anthropic) throw httpError(500, 'ANTHROPIC_API_KEY לא מוגדר בשרת');
    const incoming = Array.isArray(req.body && req.body.messages) ? req.body.messages : [];
    const messages = incoming
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .slice(-30)
      .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_LENGTH) }));
    if (!messages.length) throw httpError(400, 'חסרות הודעות');

    let finalText = '';
    const events = [];

    for (let turn = 0; turn < 5; turn++) {
      const response = await anthropic.messages.create({
        model: CHAT_MODEL,
        max_tokens: 1024,
        system: buildSystemPrompt(),
        tools: CHAT_TOOLS,
        messages,
      });

      messages.push({ role: 'assistant', content: response.content });

      const textBlocks = response.content.filter((b) => b.type === 'text').map((b) => b.text);
      if (textBlocks.length) finalText = textBlocks.join('\n');

      const toolUses = response.content.filter((b) => b.type === 'tool_use');
      if (response.stop_reason !== 'tool_use' || !toolUses.length) break;

      const toolResults = [];
      for (const tu of toolUses) {
        let payload;
        try {
          const result = await runChatTool(tu.name, tu.input || {});
          payload = result.payload;
          if (result.event) events.push(result.event);
        } catch (toolErr) {
          payload = { error: toolErr.message || 'שגיאה בביצוע הפעולה', conflict: Boolean(toolErr.conflict) };
        }
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(payload) });
      }
      messages.push({ role: 'user', content: toolResults });
    }

    res.json({ reply: finalText || 'מצטערת, לא הצלחתי לגבש תשובה כרגע. אפשר לנסות שוב?', events });
  } catch (err) {
    next(err);
  }
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(err.status || 500).json({ error: 'server_error', message: err.message || 'שגיאת שרת' });
});

app.listen(PORT, () => {
  console.log(`Vibhair booking server listening on http://localhost:${PORT}`);
  if (!CALENDAR_ID) {
    console.warn('⚠️  GOOGLE_CALENDAR_ID is not set — create server/.env from .env.example');
  }
  if (!ANTHROPIC_API_KEY) {
    console.warn('⚠️  ANTHROPIC_API_KEY is not set — the AI chat (/api/chat) will not work until it is configured in server/.env');
  }
  const hasSheetsKey = Boolean(process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON)
    || Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    || fs.existsSync(SHEETS_KEY_PATH);
  if (!hasSheetsKey) {
    console.warn(
      `⚠️  No Google Sheets service account key found. Place it at ${SHEETS_KEY_PATH} ` +
        'or set GOOGLE_SERVICE_ACCOUNT_KEY_PATH / GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON.'
    );
  }
});
