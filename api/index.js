const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

// === ENV ===
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const ADMIN_ID = process.env.ADMIN_ID;
const INTERCOM_VERSION = '2.14';

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

const log = (tag, msg) => console.log(`[${tag}] ${msg}`);

// === RETRY ===
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

// === EMAIL CACHE (1 ЧАС) ===
let emailCache = {
    set: new Set(),
    ts: 0
};

async function getEmailSet() {
    const now = Date.now();

    if (emailCache.set.size && (now - emailCache.ts < 60 * 60 * 1000)) {
        return emailCache.set;
    }

    try {
        const res = await axios.get(LIST_URL, { timeout: 8000 });

        let list = [];

        if (Array.isArray(res.data)) {
            list = res.data;
        } else if (typeof res.data === 'string') {
            list = res.data.split('\n');
        }

        const set = new Set(
            list.map(e => String(e).trim().toLowerCase()).filter(Boolean)
        );

        emailCache = { set, ts: now };

        log('CACHE', `Emails loaded: ${set.size}`);

        return set;

    } catch (e) {
        log('CACHE_ERR', e.message);
        return emailCache.set;
    }
}

// === АНТИ-ДУБЛИКАТЫ ===
const processedContacts = new Set();
const processedNotes = new Set();

// === ОСНОВНАЯ ЛОГИКА ===
async function handleUnpaid(item) {
    const conversationId = item.id;

    const contactId =
        item.contacts?.contacts?.[0]?.id ||
        item.source?.author?.id;

    if (!contactId || contactId === 'bot') return;

    if (processedContacts.has(contactId)) return;
    processedContacts.add(contactId);
    setTimeout(() => processedContacts.delete(contactId), 10 * 60 * 1000);

    try {
        // 👉 1. Получаем email list (дёшево)
        const emailSet = await getEmailSet();

        // 👉 2. ДОСТАЁМ email из webhook (если есть)
        let email =
            item.contacts?.contacts?.[0]?.email ||
            item.source?.author?.email;

        email = email?.toLowerCase();

        // 👉 3. Если email уже есть в webhook → проверяем сразу
        let isMatch = email && emailSet.has(email);

        let contact = null;

        // 👉 4. Если НЕ нашли → только тогда идём в Intercom
        if (!isMatch) {
            const contactRes = await safeRequest(() =>
                intercom.get(`/contacts/${contactId}`)
            );

            contact = contactRes.data;

            const purchaseEmail =
                contact.custom_attributes?.['Purchase email']?.toLowerCase();

            const mainEmail = contact.email?.toLowerCase();

            isMatch =
                emailSet.has(mainEmail) ||
                emailSet.has(purchaseEmail);
        }

        if (!isMatch) return;

        // 👉 5. Проверка атрибута (если уже получили contact)
        if (contact?.custom_attributes?.['Unpaid Custom'] === true) return;

        // 👉 6. Ставим атрибут
        safeRequest(() =>
            intercom.put(`/contacts/${contactId}`, {
                custom_attributes: { 'Unpaid Custom': true }
            })
        ).then(() => log('UNPAID_SET', contactId))
         .catch(e => log('UNPAID_ERR', e.message));

        // 👉 7. NOTE только при живом агенте
        if (item.admin_assignee_id && !processedNotes.has(conversationId)) {
            processedNotes.add(conversationId);

            safeRequest(() =>
                intercom.post(`/conversations/${conversationId}/reply`, {
                    message_type: 'note',
                    admin_id: ADMIN_ID,
                    body: 'Attention!!! Клієнт не заплатив за кастом - саппорт не надаємо'
                })
            ).then(() => log('NOTE', conversationId))
             .catch(e => log('NOTE_ERR', e.message));

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
        handleUnpaid(item);
    }

    if (topic === 'conversation.admin.assigned') {
        handleSubscription(item);
    }
});

app.get('/', (req, res) => res.send('OK'));
app.head('*', (req, res) => res.status(200).send('OK'));

module.exports = app;
