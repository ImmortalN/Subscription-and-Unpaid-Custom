const express = require('express');
const axios = require('axios');
const Redis = require('ioredis');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// ===================== ENV =====================
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const ADMIN_ID = process.env.ADMIN_ID;
const REDIS_URL = process.env.REDIS_URL;

if (!INTERCOM_TOKEN || !LIST_URL || !ADMIN_ID || !REDIS_URL) {
    throw new Error('Missing required ENV variables');
}

// ===================== REDIS =====================
const redis = new Redis(REDIS_URL);

// ===================== INTERCOM CLIENT =====================
const intercom = axios.create({
    baseURL: 'https://api.intercom.io',
    timeout: 15000,
    headers: {
        Authorization: `Bearer ${INTERCOM_TOKEN}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Intercom-Version': '2.14'
    }
});

// ===================== LOG =====================
function log(tag, msg, data) {
    const time = new Date().toISOString();
    if (data) console.log(`[${time}] [${tag}] ${msg}`, data);
    else console.log(`[${time}] [${tag}] ${msg}`);
}

// ===================== DELAY =====================
const delay = ms => new Promise(r => setTimeout(r, ms));

// ===================== RETRY =====================
async function safeRequest(fn, retries = 3) {
    let err;

    for (let i = 0; i <= retries; i++) {
        try {
            return await fn();
        } catch (e) {
            err = e;
            await delay(500 * Math.pow(2, i));
        }
    }

    throw err;
}

// ===================== ID EMPOTENCY KEY =====================
function buildIdempotencyKey(prefix, conversationId, type) {
    return crypto
        .createHash('sha1')
        .update(`${prefix}:${conversationId}:${type}`)
        .digest('hex');
}

// ===================== REDIS DEDUPE =====================
async function isDuplicate(key, ttl = 300) {
    const res = await redis.set(key, '1', 'EX', ttl, 'NX');
    return res === null;
}

// ===================== EMAIL CACHE (REDIS) =====================
async function getEmailSet() {
    const cached = await redis.get('email_set');

    if (cached) {
        return new Set(JSON.parse(cached));
    }

    const res = await axios.get(LIST_URL, { timeout: 12000 });

    const list = Array.isArray(res.data)
        ? res.data
        : String(res.data).split('\n');

    const emails = list
        .map(e => String(e).trim().toLowerCase())
        .filter(Boolean);

    await redis.set('email_set', JSON.stringify(emails), 'EX', 3600);

    return new Set(emails);
}

// ===================== UNPAID LOGIC =====================
async function handleUnpaid(item) {
    const conversationId = item?.id;
    const contactId =
        item?.contacts?.contacts?.[0]?.id ||
        item?.source?.author?.id;

    if (!conversationId || !contactId) return;

    // dedupe per contact
    if (await isDuplicate(`unpaid:${contactId}`, 300)) return;

    const emailSet = await getEmailSet();

    const email =
        item?.contacts?.contacts?.[0]?.email ??
        item?.source?.author?.email ??
        null;

    const normalizedEmail = email?.toLowerCase();

    let isMatch = normalizedEmail && emailSet.has(normalizedEmail);

    // fallback API check
    if (!isMatch) {
        const contactRes = await safeRequest(() =>
            intercom.get(`/contacts/${contactId}`)
        );

        const contact = contactRes.data;

        const mainEmail = contact?.email?.toLowerCase();
        const purchaseEmail =
            contact?.custom_attributes?.['Purchase email']?.toLowerCase();

        isMatch =
            emailSet.has(mainEmail) ||
            emailSet.has(purchaseEmail);
    }

    if (!isMatch) return;

    const idempotencyKey = buildIdempotencyKey(
        'unpaid',
        conversationId,
        'note'
    );

    await safeRequest(() =>
        intercom.post(
            `/conversations/${conversationId}/reply`,
            {
                message_type: 'note',
                admin_id: ADMIN_ID,
                body: '🛑 Client has not paid for custom — support not provided'
            },
            {
                headers: {
                    'Idempotency-Key': idempotencyKey
                }
            }
        )
    );

    log('UNPAID_NOTE', conversationId);
}

// ===================== SUBSCRIPTION LOGIC =====================
async function handleSubscription(item) {
    const conversationId = item?.id;
    if (!conversationId) return;

    if (await isDuplicate(`sub:${conversationId}`, 600)) return;

    const subscription = item?.custom_attributes?.subscription;
    const adminId = item?.admin_assignee_id;

    if (!adminId || subscription) return;

    const idempotencyKey = buildIdempotencyKey(
        'subscription',
        conversationId,
        'note'
    );

    await safeRequest(() =>
        intercom.post(
            `/conversations/${conversationId}/reply`,
            {
                message_type: 'note',
                admin_id: ADMIN_ID,
                body: 'Please fill subscription 😇🙏'
            },
            {
                headers: {
                    'Idempotency-Key': idempotencyKey
                }
            }
        )
    );

    log('SUB_NOTE', conversationId);
}

// ===================== WEBHOOK =====================
app.post('/webhook/intercom', async (req, res) => {
    res.status(200).send('OK'); // MUST respond fast

    const topic = req.body?.topic;
    const item = req.body?.data?.item;

    if (!topic || !item) return;

    try {
        if (
            topic === 'conversation.user.created' ||
            topic === 'conversation.user.replied'
        ) {
            handleUnpaid(item);
        }

        if (topic === 'conversation.admin.assigned') {
            handleUnpaid(item);
            handleSubscription(item);
        }
    } catch (err) {
        log('WEBHOOK_ERROR', err.message);
    }
});

// ===================== HEALTHCHECK =====================
app.get('/', (req, res) => {
    res.send('System Online');
});

// ===================== START =====================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
