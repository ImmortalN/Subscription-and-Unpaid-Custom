const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const ADMIN_ID = process.env.ADMIN_ID; 
const INTERCOM_VERSION = '2.14';

// Защита от дублей в памяти
const processedNotes = new Set();

const intercom = axios.create({
    baseURL: 'https://api.intercom.io',
    headers: {
        'Authorization': `Bearer ${INTERCOM_TOKEN}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Intercom-Version': INTERCOM_VERSION
    },
    timeout: 8000 
});

const log = (tag, msg) => console.log(`[${tag}] ${msg}`);

// --- ЛОГИКА UNPAID ---
async function handleUnpaid(contactId) {
    try {
        const { data: contact } = await intercom.get(`/contacts/${contactId}`);
        const emails = [
            contact.email,
            contact.custom_attributes?.['Purchase email']
        ].filter(Boolean).map(e => String(e).toLowerCase());

        if (emails.length === 0) return;

        const { data: rawList } = await axios.get(LIST_URL);
        const badEmails = (typeof rawList === 'string' ? rawList : JSON.stringify(rawList)).toLowerCase();

        if (emails.some(email => badEmails.includes(email))) {
            await intercom.put(`/contacts/${contactId}`, {
                custom_attributes: { 'Unpaid Custom': true }
            });
            log('UNPAID', `Атрибут Unpaid Custom установлен для ${contactId}`);
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
            log('SUBSCRIPTION', `Ноут отправлен в чат ${conversationId}`);

            // Очистка кэша через 10 минут
            setTimeout(() => processedNotes.delete(conversationId), 600000);
        }
    } catch (e) {
        processedNotes.delete(conversationId);
        log('SUBSCRIPTION_ERROR', e.message);
    }
}

// --- ОСНОВНОЙ ОБРАБОТЧИК ---
app.post('*', (req, res) => {
    // 1. МГНОВЕННЫЙ ОТВЕТ (Совет от Intercom)
    res.status(200).send('OK');

    // 2. ВЫПОЛНЕНИЕ ЛОГИКИ В ФОНЕ
    const body = req.body;
    const topic = body?.topic;
    const item = body?.data?.item;

    if (!topic || !item) return;

    // Используем асинхронную функцию внутри, чтобы не блокировать поток
    (async () => {
        try {
            // Проверка Unpaid (создание или ответ)
            if (topic === 'conversation.user.created' || topic === 'conversation.user.replied') {
                const contactId = item.contacts?.contacts?.[0]?.id || item.source?.author?.id;
                if (contactId && contactId !== 'bot') {
                    await handleUnpaid(contactId);
                }
            }

            // Проверка Subscription (назначение на админа)
            if (topic === 'conversation.admin.assigned') {
                await handleSubscription(item);
            }
        } catch (err) {
            log('BACKGROUND_PROCESS_ERR', err.message);
        }
    })();
});

module.exports = app;
