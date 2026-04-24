const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ===================== ENV =====================
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const ADMIN_ID = process.env.ADMIN_ID;

const INTERCOM_VERSION = '2.14';

// ===================== INTERCOM =====================
const intercom = axios.create({
    baseURL: 'https://api.intercom.io',
    timeout: 10000, // 🔥 уменьшили чтобы не фризило serverless
    headers: {
        Authorization: `Bearer ${INTERCOM_TOKEN}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Intercom-Version': INTERCOM_VERSION
    }
});

// ===================== LOG =====================
const log = (tag, msg) => {
    console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);
};

// ===================== SAFE REQUEST =====================
const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function safeRequest(fn, retries = 2) {
    let err;

    for (let i = 0; i <= retries; i++) {
        try {
            return await fn();
        } catch (e) {
            err = e;
            await delay(500 * Math.pow(2, i)); // exponential backoff
        }
    }

    throw err;
}

// ===================== EMAIL CACHE =====================
// 🔥 FIX: убрали "isFetching race condition"
let emailCache = {
    set: new Set(),
    ts: 0,
    promise: null
};

async function getEmailSet() {
    const now = Date.now();

    // valid cache
    if (emailCache.set.size && now - emailCache.ts < 60 * 60 * 1000) {
        return emailCache.set;
    }

    // prevent parallel requests
    if (emailCache.promise) return emailCache.promise;

    emailCache.promise = (async () => {
        try {
            log('CACHE', 'Fetching email list...');

            const res = await axios.get(LIST_URL, {
                timeout: 8000 // 🔥 safety timeout
            });

            const list = Array.isArray(res.data)
                ? res.data
                : String(res.data).split('\n');

            const set = new Set(
                list.map(e => String(e).trim().toLowerCase()).filter(Boolean)
            );

            emailCache = {
                set,
                ts: Date.now(),
                promise: null
            };

            log('CACHE', `Loaded emails: ${set.size}`);

            return set;

        } catch (e) {
            emailCache.promise = null;

            log('CACHE_ERR', e.message);

            // fallback safe cache
            return emailCache.set;
        }
    })();

    return emailCache.promise;
}

// ===================== ANTI DUPLICATES (SAFE TTL) =====================
const processedContacts = new Map();
const processedUnpaidNotes = new Map();
const processedSubNotes = new Map();

function isProcessed(map, key, ttlMs) {
    const now = Date.now();
    const exp = map.get(key);

    if (exp && exp > now) return true;

    map.set(key, now + ttlMs);
    return false;
}

// ===================== UNPAID LOGIC =====================
async function handleUnpaid(item) {
    const conversationId = item?.id;
    const contactId =
        item?.contacts?.contacts?.[0]?.id ||
        item?.source?.author?.id;

    if (!conversationId || !contactId) return;

    if (isProcessed(processedContacts, contactId, 5 * 60 * 1000)) return;

    try {
        const emailSet = await getEmailSet();

        const email =
            item?.contacts?.contacts?.[0]?.email ??
            item?.source?.author?.email ??
            null;

        const normalized = email?.toLowerCase();

        let isMatch = normalized && emailSet.has(normalized);
        let contact = null;

        // fallback API only if needed
        if (!isMatch) {
            const contactRes = await safeRequest(() =>
                intercom.get(`/contacts/${contactId}`)
            );

            contact = contactRes.data;

            const mainEmail = contact?.email?.toLowerCase();
            const purchaseEmail =
                contact?.custom_attributes?.['Purchase email']?.toLowerCase();

            isMatch =
                emailSet.has(mainEmail) ||
                emailSet.has(purchaseEmail);
        }

        if (!isMatch) return;

        // update attribute (fire-and-forget safe)
        if (contact?.custom_attributes?.['Unpaid Custom'] !== true) {
            safeRequest(() =>
                intercom.put(`/contacts/${contactId}`, {
                    custom_attributes: {
                        'Unpaid Custom': true
                    }
                })
            ).catch(e => log('ATTR_ERR', e.message));
        }

        // send note once per conversation
        if (
            item?.admin_assignee_id &&
            !isProcessed(processedUnpaidNotes, conversationId, 10 * 60 * 1000)
        ) {
            safeRequest(() =>
                intercom.post(`/conversations/${conversationId}/reply`, {
                    message_type: 'note',
                    admin_id: ADMIN_ID,
                    body: '🛑 Attention!!! Клієнт не заплатив за кастом - саппорт не надаємо!'
                })
            )
                .then(() => log('UNPAID_NOTE', conversationId))
                .catch(e => log('NOTE_ERR', e.message));

            processedUnpaidNotes.set(conversationId, Date.now());
        }

    } catch (e) {
        log('UNPAID_ERR', e.message);
    }
}

// ===================== SUBSCRIPTION LOGIC =====================
async function handleSubscription(item) {
    const conversationId = item?.id;
    if (!conversationId) return;

    if (isProcessed(processedSubNotes, conversationId, 10 * 60 * 1000)) return;

    try {
        const adminId = item?.admin_assignee_id;
        const subscription = item?.custom_attributes?.subscription;

        if (adminId && !subscription) {
            safeRequest(() =>
                intercom.post(`/conversations/${conversationId}/reply`, {
                    message_type: 'note',
                    admin_id: ADMIN_ID,
                    body: 'Заповніть будь ласка subscription 😇🙏'
                })
            )
                .then(() => log('SUB_NOTE', conversationId))
                .catch(e => log('SUB_ERR', e.message));

            processedSubNotes.set(conversationId, Date.now());
        }

    } catch (e) {
        log('SUB_LOGIC_ERR', e.message);
    }
}

// ===================== WEBHOOK =====================
app.post('*', (req, res) => {
    // 🔥 ALWAYS respond immediately (important for Intercom retries)
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

    } catch (e) {
        log('WEBHOOK_ERR', e.message);
    }
});

// ===================== HEALTHCHECK =====================
app.get('/', (req, res) => {
    res.send('System Online');
});

module.exports = app;
