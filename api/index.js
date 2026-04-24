const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const ADMIN_ID = process.env.ADMIN_ID;
const INTERCOM_VERSION = '2.14';

const processedNotes = new Set();
let emailListCache = { data: null, timestamp: 0 };

const intercom = axios.create({
    baseURL: 'https://api.intercom.io',
    headers: {
        'Authorization': `Bearer ${INTERCOM_TOKEN}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Intercom-Version': INTERCOM_VERSION
    },
    timeout: 7000 // Уменьшаем, чтобы не висеть долго
});

const log = (tag, msg) => console.log(`[${tag}] ${msg}`);

// Вспомогательная функция для получения списка с кэшем (на 5 минут)
async function getBadEmails() {
    const now = Date.now();
    if (emailListCache.data && (now - emailListCache.timestamp < 300000)) {
        return emailListCache.data;
    }
    try {
        const res = await axios.get(LIST_URL, { timeout: 5000 });
        const data = (typeof res.data === 'string' ? res.data : JSON.stringify(res.data)).toLowerCase();
        emailListCache = { data, timestamp: now };
        return data;
    } catch (e) {
        log('CACHE_ERR', 'Не удалось обновить список имейлов, используем старый если есть');
        return emailListCache.data || "";
    }
}

async function handleUnpaid(contactId) {
    try {
        const contactRes = await intercom.get(`/contacts/${contactId}`);
        const contact = contactRes.data;
        const emails = [
            contact.email,
            contact.custom_attributes?.['Purchase email']
        ].filter(Boolean).map(e => String(e).toLowerCase());

        if (emails.length === 0) return;

        const badEmails = await getBadEmails();

        if (emails.some(email => badEmails.includes(email))) {
            // Не используем await здесь, чтобы не ждать ответа API
            intercom.put(`/contacts/${contactId}`, {
                custom_attributes: { 'Unpaid Custom': true }
            }).catch(e => log('UNPAID_PUT_ERR', e.message));
            log('UNPAID', `Request sent for ${contactId}`);
        }
    } catch (e) {
        log('UNPAID_FETCH_ERR', e.message);
    }
}

async function handleSubscription(item) {
    const conversationId = item.id;
    if (processedNotes.has(conversationId)) return;

    try {
        const adminAssigneeId = item.admin_assignee_id;
        const subscription = item.custom_attributes?.subscription;

        if (adminAssigneeId && !subscription) {
            processedNotes.add(conversationId);
            
            // Fire and forget
            intercom.post(`/conversations/${conversationId}/reply`, {
                message_type: 'note',
                admin_id: ADMIN_ID,
                body: 'Заповніть будь ласка subscription 😇🙏'
            }).then(() => log('SUBSCRIPTION', `Note DONE for ${conversationId}`))
              .catch(e => log('SUBSCRIPTION_POST_ERR', e.message));

            setTimeout(() => processedNotes.delete(conversationId), 600000);
        }
    } catch (e) {
        log('SUBSCRIPTION_LOGIC_ERR', e.message);
    }
}

app.post('*', (req, res) => {
    // Отвечаем мгновенно
    res.status(200).send('OK');

    const body = req.body;
    const topic = body?.topic;
    const item = body?.data?.item;

    if (!topic || !item) return;

    // Запускаем процессы без await, чтобы функция Vercel могла завершиться
    if (topic === 'conversation.user.created' || topic === 'conversation.user.replied') {
        const contactId = item.contacts?.contacts?.[0]?.id || item.source?.author?.id;
        if (contactId && contactId !== 'bot') {
            handleUnpaid(contactId); 
        }
    }

    if (topic === 'conversation.admin.assigned') {
        handleSubscription(item);
    }
});

module.exports = app;
