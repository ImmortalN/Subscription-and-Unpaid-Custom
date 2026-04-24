const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const ADMIN_ID = process.env.ADMIN_ID; 
const INTERCOM_VERSION = '2.14';

const processedNotes = new Set();

const intercom = axios.create({
    baseURL: 'https://api.intercom.io',
    headers: {
        'Authorization': `Bearer ${INTERCOM_TOKEN}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Intercom-Version': INTERCOM_VERSION
    },
    timeout: 15000 // Увеличиваем внутренний лимит до 15 сек
});

const log = (tag, msg) => console.log(`[${tag}] ${msg}`);

// --- ЛОГИКА UNPAID (Оптимизированная) ---
async function handleUnpaid(contactId) {
    try {
        // Запускаем запросы параллельно, чтобы сэкономить время
        const [contactRes, listRes] = await Promise.all([
            intercom.get(`/contacts/${contactId}`),
            axios.get(LIST_URL, { timeout: 10000 })
        ]);

        const contact = contactRes.data;
        const emails = [
            contact.email,
            contact.custom_attributes?.['Purchase email']
        ].filter(Boolean).map(e => String(e).toLowerCase());

        if (emails.length === 0) return;

        const badEmails = (typeof listRes.data === 'string' ? listRes.data : JSON.stringify(listRes.data)).toLowerCase();

        if (emails.some(email => badEmails.includes(email))) {
            await intercom.put(`/contacts/${contactId}`, {
                custom_attributes: { 'Unpaid Custom': true }
            });
            log('UNPAID', `Success for ${contactId}`);
        }
    } catch (e) {
        log('UNPAID_ERROR', e.message);
    }
}

// --- ЛОГИКА SUBSCRIPTION ---
async function handleSubscription(item) {
    const conversationId = item.id;
    if (processedNotes.has(conversationId)) return;

    try {
        const adminAssigneeId = item.admin_assignee_id;
        const subscription = item.custom_attributes?.subscription;

        if (adminAssigneeId && !subscription) {
            processedNotes.add(conversationId);
            
            await intercom.post(`/conversations/${conversationId}/reply`, {
                message_type: 'note',
                admin_id: ADMIN_ID,
                body: 'Заповніть будь ласка subscription 😇🙏'
            });
            log('SUBSCRIPTION', `Note sent to ${conversationId}`);
            setTimeout(() => processedNotes.delete(conversationId), 600000);
        }
    } catch (e) {
        processedNotes.delete(conversationId);
        log('SUBSCRIPTION_ERROR', e.message);
    }
}

// --- ГЛАВНЫЙ ОБРАБОТЧИК ---
app.post('*', (req, res) => {
    // Мгновенный ответ Intercom, чтобы он не слал дубликаты
    res.status(200).send('OK');

    const body = req.body;
    const topic = body?.topic;
    const item = body?.data?.item;

    if (!topic || !item) return;

    // Выполняем работу в фоне
    (async () => {
        try {
            if (topic === 'conversation.user.created' || topic === 'conversation.user.replied') {
                const contactId = item.contacts?.contacts?.[0]?.id || item.source?.author?.id;
                if (contactId && contactId !== 'bot') {
                    await handleUnpaid(contactId);
                }
            }

            if (topic === 'conversation.admin.assigned') {
                await handleSubscription(item);
            }
        } catch (err) {
            log('BG_ERR', err.message);
        }
    })();
});

module.exports = app;
