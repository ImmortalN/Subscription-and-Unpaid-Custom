const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

// === ENV ===
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;
const INTERCOM_VERSION = '2.14';

// 👉 можно вообще захардкодить, если хочешь
const STATIC_BAD_EMAILS = [
    'test1@email.com',
    'test2@email.com',
    'test3@email.com'
];

// === AXIOS ===
const intercom = axios.create({
    baseURL: 'https://api.intercom.io',
    headers: {
        'Authorization': `Bearer ${INTERCOM_TOKEN}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Intercom-Version': INTERCOM_VERSION
    },
    timeout: 15000
});

// === HELPERS ===
const log = (tag, msg) => console.log(`[${tag}] ${msg}`);

async function safeRequest(fn, retries = 2) {
    try {
        return await fn();
    } catch (e) {
        if (retries > 0) {
            await new Promise(r => setTimeout(r, 1200));
            return safeRequest(fn, retries - 1);
        }
        throw e;
    }
}

// === АНТИ-ДУБЛИКАТЫ ===
const processedContacts = new Set();
const processedNotes = new Set();

// === CHECK EMAIL ===
function isBadEmail(email) {
    if (!email) return false;
    return STATIC_BAD_EMAILS.includes(String(email).toLowerCase());
}

// === UNPAID + NOTE ===
async function handleUnpaidAndNote(item) {
    const conversationId = item.id;

    const contactId =
        item.contacts?.contacts?.[0]?.id ||
        item.source?.author?.id;

    if (!contactId || contactId === 'bot') return;

    if (processedContacts.has(contactId)) return;
    processedContacts.add(contactId);

    setTimeout(() => processedContacts.delete(contactId), 10 * 60 * 1000);

    try {
        // 👉 1. получаем контакт (с retry)
        const contactRes = await safeRequest(() =>
            intercom.get(`/contacts/${contactId}`)
        );

        const contact = contactRes.data;

        // 👉 если уже unpaid — выходим
        if (contact.custom_attributes?.['Unpaid Custom'] === true) return;

        const email = contact.email;
        const purchaseEmail = contact.custom_attributes?.['Purchase email'];

        const match =
            isBadEmail(email) ||
            isBadEmail(purchaseEmail);

        if (!match) return;

        // 👉 2. ставим атрибут
        safeRequest(() =>
            intercom.put(`/contacts/${contactId}`, {
                custom_attributes: { 'Unpaid Custom': true }
            })
        ).then(() => {
            log('UNPAID_SET', contactId);
        }).catch(e => log('UNPAID_ERR', e.message));

        // 👉 3. NOTE только если есть агент
        if (item.admin_assignee_id && !processedNotes.has(conversationId)) {
            processedNotes.add(conversationId);

            safeRequest(() =>
                intercom.post(`/conversations/${conversationId}/reply`, {
                    message_type: 'note',
                    admin_id: ADMIN_ID,
                    body: 'Attention!!! Клієнт не заплатив за кастом - саппорт не надаємо'
                })
            ).then(() => {
                log('NOTE_ADDED', conversationId);
            }).catch(e => log('NOTE_ERR', e.message));

            setTimeout(() => processedNotes.delete(conversationId), 10 * 60 * 1000);
        }

    } catch (e) {
        log('UNPAID_FETCH_ERR', e.message);
    }
}

// === SUBSCRIPTION ===
async function handleSubscription(item) {
    const conversationId = item.id;

    if (!conversationId || processedNotes.has(conversationId)) return;

    try {
        const hasAdmin = !!item.admin_assignee_id;
        const subscription = item.custom_attributes?.subscription;

        if (hasAdmin && !subscription) {
            processedNotes.add(conversationId);

            safeRequest(() =>
                intercom.post(`/conversations/${conversationId}/reply`, {
                    message_type: 'note',
                    admin_id: ADMIN_ID,
                    body: 'Заповніть будь ласка subscription 😇🙏'
                })
            ).catch(() => {});

            setTimeout(() => processedNotes.delete(conversationId), 10 * 60 * 1000);
        }

    } catch (e) {
        log('SUB_ERR', e.message);
    }
}

// === WEBHOOK ===
app.post('*', (req, res) => {
    res.status(200).send('OK');

    const topic = req.body?.topic;
    const item = req.body?.data?.item;

    if (!topic || !item) return;

    if (
        topic === 'conversation.user.created' ||
        topic === 'conversation.user.replied'
    ) {
        handleUnpaidAndNote(item);
    }

    if (topic === 'conversation.admin.assigned') {
        handleSubscription(item);
    }
});

app.get('/', (req, res) => res.send('OK'));
app.head('*', (req, res) => res.status(200).send('OK'));

module.exports = app;
