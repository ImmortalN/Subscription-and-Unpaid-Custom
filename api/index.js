const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

// === ENV ===
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const ADMIN_ID = process.env.ADMIN_ID;
const INTERCOM_VERSION = '2.14';

// === AXIOS INSTANCE ===
const intercom = axios.create({
    baseURL: 'https://api.intercom.io',
    headers: {
        'Authorization': `Bearer ${INTERCOM_TOKEN}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Intercom-Version': INTERCOM_VERSION
    },
    timeout: 12000
});

// === LOG ===
const log = (tag, msg) => console.log(`[${tag}] ${msg}`);

// === QUEUE (анти DDOS) ===
let activeRequests = 0;
const MAX_REQUESTS = 5;

async function queue(fn) {
    while (activeRequests >= MAX_REQUESTS) {
        await new Promise(r => setTimeout(r, 200));
    }
    activeRequests++;
    try {
        return await fn();
    } finally {
        activeRequests--;
    }
}

// === RETRY ===
async function safeRequest(fn, retries = 2) {
    try {
        return await fn();
    } catch (e) {
        if (retries > 0) {
            await new Promise(r => setTimeout(r, 1000));
            return safeRequest(fn, retries - 1);
        }
        throw e;
    }
}

// === CACHE EMAIL LIST ===
let emailListCache = {
    data: new Set(),
    timestamp: 0
};

async function getBadEmails() {
    const now = Date.now();

    if (emailListCache.data.size > 0 && (now - emailListCache.timestamp < 300000)) {
        return emailListCache.data;
    }

    try {
        const res = await safeRequest(() =>
            axios.get(LIST_URL, { timeout: 8000 })
        );

        let list = [];

        if (Array.isArray(res.data)) {
            list = res.data;
        } else if (typeof res.data === 'string') {
            list = res.data.split('\n');
        }

        const set = new Set(
            list.map(e => String(e).trim().toLowerCase()).filter(Boolean)
        );

        emailListCache = { data: set, timestamp: now };

        log('CACHE', `Loaded ${set.size} emails`);

        return set;

    } catch (e) {
        log('CACHE_ERR', e.message);
        return emailListCache.data;
    }
}

// === ANTI DUPLICATES ===
const processedContacts = new Set();
const processedNotes = new Set();

// === UNPAID LOGIC ===
async function handleUnpaid(contactId) {
    if (!contactId) return;

    if (processedContacts.has(contactId)) return;
    processedContacts.add(contactId);

    setTimeout(() => processedContacts.delete(contactId), 10 * 60 * 1000);

    try {
        const contactRes = await queue(() =>
            safeRequest(() => intercom.get(`/contacts/${contactId}`))
        );

        const contact = contactRes.data;

        // Уже есть атрибут → не трогаем
        if (contact.custom_attributes?.['Unpaid Custom'] === true) return;

        const emails = [
            contact.email,
            contact.custom_attributes?.['Purchase email']
        ]
            .filter(Boolean)
            .map(e => String(e).toLowerCase());

        if (emails.length === 0) return;

        const badEmails = await getBadEmails();

        const match = emails.some(email => badEmails.has(email));

        if (!match) return;

        // Fire but controlled
        queue(() =>
            safeRequest(() =>
                intercom.put(`/contacts/${contactId}`, {
                    custom_attributes: { 'Unpaid Custom': true }
                })
            )
        ).then(() => {
            log('UNPAID_SET', `Contact ${contactId}`);
        }).catch(e => {
            log('UNPAID_ERR', e.message);
        });

    } catch (e) {
        log('UNPAID_FETCH_ERR', e.message);
    }
}

// === SUBSCRIPTION LOGIC ===
async function handleSubscription(item) {
    const conversationId = item.id;

    if (!conversationId) return;
    if (processedNotes.has(conversationId)) return;

    try {
        const hasAdmin = !!item.admin_assignee_id;
        const subscription = item.custom_attributes?.subscription;

        if (hasAdmin && !subscription) {
            processedNotes.add(conversationId);

            queue(() =>
                safeRequest(() =>
                    intercom.post(`/conversations/${conversationId}/reply`, {
                        message_type: 'note',
                        admin_id: ADMIN_ID,
                        body: 'Заповніть будь ласка subscription 😇🙏'
                    })
                )
            ).then(() => {
                log('SUB_NOTE', `Conversation ${conversationId}`);
            }).catch(e => {
                log('SUB_ERR', e.message);
            });

            setTimeout(() => processedNotes.delete(conversationId), 10 * 60 * 1000);
        }

    } catch (e) {
        log('SUB_LOGIC_ERR', e.message);
    }
}

// === WEBHOOK ===
app.post('*', (req, res) => {
    // ВАЖНО: отвечаем сразу
    res.status(200).send('OK');

    const body = req.body;
    const topic = body?.topic;
    const item = body?.data?.item;

    if (!topic || !item) return;

    // === UNPAID ===
    if (
        topic === 'conversation.user.created' ||
        topic === 'conversation.user.replied'
    ) {
        const contactId =
            item.contacts?.contacts?.[0]?.id ||
            item.source?.author?.id;

        if (contactId && contactId !== 'bot') {
            handleUnpaid(contactId);
        }
    }

    // === SUBSCRIPTION ===
    if (topic === 'conversation.admin.assigned') {
        handleSubscription(item);
    }
});

// health check
app.get('/', (req, res) => res.send('OK'));
app.head('*', (req, res) => res.status(200).send('OK'));

module.exports = app;
