import axios from 'axios';
import Redis from 'ioredis';
import crypto from 'crypto';

// ===================== ENV =====================
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const ADMIN_ID = process.env.ADMIN_ID;
const REDIS_URL = process.env.REDIS_URL;

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
function log(tag, msg) {
    console.log(`[${tag}] ${msg}`);
}

// ===================== HELPERS =====================
const delay = ms => new Promise(r => setTimeout(r, ms));

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

// ===================== IDEMPOTENCY KEY =====================
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

// ===================== EMAIL CACHE =====================
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

// ===================== MAIN LOGIC =====================
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

    log('UNPAID', conversationId);
}

async function handleSubscription(item) {
    const conversationId = item?.id;
    if (!conversationId) return;

    if (await isDuplicate(`sub:${conversationId}`, 600)) return;

    const subscription = item?.custom_attributes?.subscription;
    const adminId = item?.admin_assignee_id;

    if (adminId && !subscription) {
        const idempotencyKey = buildIdempotencyKey(
            'sub',
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

        log('SUB', conversationId);
    }
}

// ===================== VERCEL HANDLER =====================
export default async function handler(req, res) {
    // MUST respond fast
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
