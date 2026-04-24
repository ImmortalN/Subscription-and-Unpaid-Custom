import axios from 'axios';
import Redis from 'ioredis';
import crypto from 'crypto';

// ===================== ENV =====================
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const ADMIN_ID = process.env.ADMIN_ID;
const REDIS_URL = process.env.REDIS_URL;

if (!INTERCOM_TOKEN || !LIST_URL || !ADMIN_ID || !REDIS_URL) {
    throw new Error('Missing ENV variables');
}

// ===================== REDIS =====================
const redis = new Redis(REDIS_URL);

redis.on('error', (err) => {
    console.error('[REDIS ERROR]', err.message);
});

// ===================== INTERCOM =====================
const intercom = axios.create({
    baseURL: 'https://api.intercom.io',
    timeout: 10000,
    headers: {
        Authorization: `Bearer ${INTERCOM_TOKEN}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Intercom-Version': '2.14'
    }
});

// ===================== LOG =====================
const log = (t, m) => console.log(`[${t}] ${m}`);

// ===================== UTILS =====================
const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function safeRequest(fn, retries = 2) {
    let err;

    for (let i = 0; i <= retries; i++) {
        try {
            return await fn();
        } catch (e) {
            err = e;
            await delay(400 * Math.pow(2, i));
        }
    }

    throw err;
}

// ===================== IDEMPOTENCY =====================
function idKey(prefix, conversationId, type) {
    return crypto
        .createHash('sha1')
        .update(`${prefix}:${conversationId}:${type}`)
        .digest('hex');
}

// ===================== DEDUPE (REDIS TTL) =====================
async function isDuplicate(key, ttl = 300) {
    const res = await redis.set(key, '1', 'EX', ttl, 'NX');
    return res === null;
}

// ===================== EMAIL CACHE (CRITICAL FIX) =====================
// 🔥 LIST_URL больше НЕ используется в webhook path
// только background refresh (fallback-safe)

async function getEmailSet() {
    try {
        const cached = await redis.get('email_set');

        if (cached) {
            return new Set(JSON.parse(cached));
        }

        // fallback fetch (only if cache empty)
        const res = await axios.get(LIST_URL, { timeout: 5000 });

        const list = Array.isArray(res.data)
            ? res.data
            : String(res.data).split('\n');

        const emails = list
            .map(e => String(e).trim().toLowerCase())
            .filter(Boolean);

        await redis.set('email_set', JSON.stringify(emails), 'EX', 3600);

        return new Set(emails);

    } catch (err) {
        log('EMAIL_CACHE_FAIL', err.message);

        const fallback = await redis.get('email_set');
        if (fallback) return new Set(JSON.parse(fallback));

        return new Set(); // safe fallback
    }
}

// ===================== UNPAID LOGIC =====================
async function handleUnpaid(item) {
    const conversationId = item?.id;
    const contactId =
        item?.contacts?.contacts?.[0]?.id ||
        item?.source?.author?.id;

    if (!conversationId || !contactId) return;

    if (await isDuplicate(`unpaid:${contactId}`, 300)) return;

    const emailSet = await getEmailSet();

    const email =
        item?.contacts?.contacts?.[0]?.email ??
        item?.source?.author?.email ??
        null;

    const normalized = email?.toLowerCase();

    let isMatch = normalized && emailSet.has(normalized);

    if (!isMatch) {
        try {
            const contactRes = await safeRequest(() =>
                intercom.get(`/contacts/${contactId}`)
            );

            const contact = contactRes.data;

            const main = contact?.email?.toLowerCase();
            const purchase = contact?.custom_attributes?.['Purchase email']?.toLowerCase();

            isMatch =
                emailSet.has(main) ||
                emailSet.has(purchase);

        } catch (e) {
            log('CONTACT_FETCH_FAIL', e.message);
            return;
        }
    }

    if (!isMatch) return;

    const key = idKey('unpaid', conversationId, 'note');

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
                    'Idempotency-Key': key
                }
            }
        )
    );

    log('UNPAID_SENT', conversationId);
}

// ===================== SUBSCRIPTION =====================
async function handleSubscription(item) {
    const conversationId = item?.id;
    if (!conversationId) return;

    if (await isDuplicate(`sub:${conversationId}`, 600)) return;

    const subscription = item?.custom_attributes?.subscription;
    const adminId = item?.admin_assignee_id;

    if (!adminId || subscription) return;

    const key = idKey('sub', conversationId, 'note');

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
                    'Idempotency-Key': key
                }
            }
        )
    );

    log('SUB_SENT', conversationId);
}

// ===================== VERCEL HANDLER =====================
export default async function handler(req, res) {
    // MUST respond immediately
    res.status(200).send('OK');

    try {
        const topic = req.body?.topic;
        const item = req.body?.data?.item;

        if (!topic || !item) return;

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
}
