const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// === НАСТРОЙКИ ===
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const ADMIN_ID = process.env.ADMIN_ID; // ID админа, от которого полетит ноут
const INTERCOM_VERSION = '2.14';

// Инстанс для запросов к Intercom
const intercom = axios.create({
    baseURL: 'https://api.intercom.io',
    headers: {
        'Authorization': `Bearer ${INTERCOM_TOKEN}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Intercom-Version': INTERCOM_VERSION
    }
});

const log = (tag, msg) => console.log(`[${tag}] [${new Date().toISOString()}] ${msg}`);

// --- ЛОГИКА 1: UNPAID CUSTOM ---
async function checkUnpaidEmail(contactId) {
    try {
        // 1. Получаем полные данные контакта
        const { data: contact } = await intercom.get(`/contacts/${contactId}`);
        const emails = [contact.email, ...(contact.additional_emails || [])].filter(Boolean).map(e => e.toLowerCase());

        if (emails.length === 0) return;

        // 2. Получаем список из вашей API ссылки
        const { data: rawList } = await axios.get(LIST_URL);
        const badEmailsStr = typeof rawList === 'string' ? rawList : JSON.stringify(rawList);
        const badEmails = badEmailsStr.toLowerCase();

        // 3. Сверяем
        const isUnpaid = emails.some(email => badEmails.includes(email));

        if (isUnpaid) {
            await intercom.put(`/contacts/${contactId}`, {
                custom_attributes: { 'Unpaid Custom': true }
            });
            log('UNPAID', `Set Unpaid=true for contact ${contactId}`);
        }
    } catch (e) {
        log('UNPAID_ERROR', e.message);
    }
}

// --- ЛОГИКА 2: SUBSCRIPTION ---
async function checkSubscription(item) {
    try {
        const conversationId = item.id;
        const subscription = item.custom_attributes?.subscription;
        const assigneeType = item.assignee?.type; // 'admin' или 'team'

        // Условие: Назначено на живого админа и поле subscription пустое
        if (assigneeType === 'admin' && !subscription) {
            await intercom.post(`/conversations/${conversationId}/reply`, {
                message_type: 'note',
                admin_id: ADMIN_ID,
                body: 'Заповніть будь ласка subscription 😇🙏'
            });
            log('SUBSCRIPTION', `Note sent to chat ${conversationId}`);
        }
    } catch (e) {
        log('SUBSCRIPTION_ERROR', e.message);
    }
}

// === ОСНОВНОЙ WEBHOOK ===
app.post('*', async (req, res) => {
    // Сразу отвечаем Intercom 200 OK, чтобы он не ругался на таймауты
    res.status(200).send('OK');

    const body = req.body;
    const topic = body?.topic;
    const item = body?.data?.item;

    // Защита от пустых или тестовых запросов Intercom
    if (!item || !topic) return;

    try {
        // Определение ID контакта
        const contactId = item.contacts?.contacts?.[0]?.id || item.source?.author?.id;

        // 1. Логика Unpaid (срабатывает при создании чата или ответе юзера)
        if (topic === 'conversation.user.created' || topic === 'conversation.user.replied') {
            if (contactId && contactId !== 'bot') {
                checkUnpaidEmail(contactId);
            }
        }

        // 2. Логика Subscription (срабатывает при ассайне на агента)
        if (topic === 'conversation.admin.assigned') {
            checkSubscription(item);
        }

    } catch (err) {
        log('WEBHOOK_PROCESS_ERR', err.message);
    }
});

// Для локального запуска
if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 3000;
}

// ЭКСПОРТ ДЛЯ VERCEL
module.exports = app;
