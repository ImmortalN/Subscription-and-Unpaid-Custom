const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const ADMIN_ID = process.env.ADMIN_ID; // От кого будет ноут
const INTERCOM_VERSION = '2.14';

const intercom = axios.create({
    baseURL: 'https://api.intercom.io',
    headers: {
        'Authorization': `Bearer ${INTERCOM_TOKEN}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Intercom-Version': INTERCOM_VERSION
    },
    timeout: 10000 
});

const log = (tag, msg) => console.log(`[${tag}] [${new Date().toISOString()}] ${msg}`);

// ЛОГИКА 1: UNPAID (с ожиданием результата)
async function handleUnpaid(contactId) {
    try {
        const { data: contact } = await intercom.get(`/contacts/${contactId}`);
        const emails = [contact.email, ...(contact.additional_emails || [])].filter(Boolean).map(e => e.toLowerCase());
        if (emails.length === 0) return;

        const { data: rawList } = await axios.get(LIST_URL);
        const badEmails = (typeof rawList === 'string' ? rawList : JSON.stringify(rawList)).toLowerCase();

        if (emails.some(email => badEmails.includes(email))) {
            // ЖДЕМ завершения установки атрибута
            await intercom.put(`/contacts/${contactId}`, {
                custom_attributes: { 'Unpaid Custom': true }
            });
            log('UNPAID', `Attribute SET for ${contactId}`);
        }
    } catch (e) {
        log('UNPAID_ERROR', e.message);
    }
}

// ЛОГИКА 2: SUBSCRIPTION (проверка при назначении)
async function handleSubscription(item) {
    try {
        const conversationId = item.id;
        // Берем атрибут прямо из объекта item, который прислал вебхук
        const subscription = item.custom_attributes?.subscription;
        const assignee = item.assignee;

        if (assignee?.type === 'admin' && !subscription) {
            await intercom.post(`/conversations/${conversationId}/reply`, {
                message_type: 'note',
                admin_id: ADMIN_ID,
                body: 'Заповніть будь ласка subscription 😇🙏'
            });
            log('SUBSCRIPTION', `Note sent to ${conversationId}`);
        }
    } catch (e) {
        log('SUBSCRIPTION_ERROR', e.message);
    }
}

app.post('*', async (req, res) => {
    const body = req.body;
    const topic = body?.topic;
    const item = body?.data?.item;

    if (!item) return res.status(200).send('OK');

    try {
        // Сначала выполняем логику, потом отвечаем (для стабильности Vercel)
        
        // 1. Unpaid logic
        if (topic === 'conversation.user.created' || topic === 'conversation.user.replied') {
            const contactId = item.contacts?.contacts?.[0]?.id || item.source?.author?.id;
            if (contactId && contactId !== 'bot') {
                await handleUnpaid(contactId);
            }
        }

        // 2. Subscription logic
        if (topic === 'conversation.admin.assigned') {
            await handleSubscription(item);
        }

        res.status(200).send('OK');
    } catch (err) {
        log('GLOBAL_ERR', err.message);
        res.status(200).send('OK');
    }
});

module.exports = app;
