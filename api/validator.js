const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// === НАСТРОЙКИ (ENV) ===
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const UNPAID_ATTR_NAME = 'Unpaid Custom'; // Твой атрибут

// Вспомогательная функция для логов
const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

// 1. ЛОГИКА UNPAID CUSTOM (Email Check)
async function checkUnpaidEmail(contactId, conversationId) {
    try {
        // Получаем полные данные контакта (включая все имейлы)
        const contactRes = await axios.get(`https://api.intercom.io/contacts/${contactId}`, {
            headers: { 'Authorization': `Bearer ${INTERCOM_TOKEN}`, 'Accept': 'application/json' }
        });
        const contact = contactRes.data;
        
        // Собираем все имейлы контакта
        const emails = [contact.email, ...(contact.additional_emails || [])].filter(Boolean);
        if (emails.length === 0) return;

        // Получаем список "плохих" имейлов
        const listRes = await axios.get(LIST_URL);
        const badEmails = listRes.data.toString().toLowerCase();

        // Проверяем совпадение
        const isUnpaid = emails.some(email => badEmails.includes(email.toLowerCase()));

        if (isUnpaid) {
            log(`Found unpaid user: ${contactId}. Setting attribute...`);
            await axios.put(`https://api.intercom.io/contacts/${contactId}`, 
                { custom_attributes: { [UNPAID_ATTR_NAME]: true } },
                { headers: { 'Authorization': `Bearer ${INTERCOM_TOKEN}`, 'Content-Type': 'application/json' } }
            );
        }
    } catch (e) {
        log(`Error in Unpaid logic: ${e.message}`);
    }
}

// 2. ЛОГИКА SUBSCRIPTION (Note for Admin)
async function checkSubscription(item) {
    const conversationId = item.id;
    const contactId = item.contacts?.contacts?.[0]?.id;
    const assignee = item.assignee;
    const subscription = item.custom_attributes?.subscription;

    // ПРОВЕРКА: Только если назначен живой агент (admin) и поле пустое
    if (assignee?.type === 'admin' && !subscription) {
        log(`Admin ${assignee.id} took chat ${conversationId}. Subscription empty!`);
        try {
            await axios.post(`https://api.intercom.io/conversations/${conversationId}/reply`, {
                message_type: 'note',
                type: 'admin',
                admin_id: process.env.BOT_ADMIN_ID, // ID твоего бота/админа, от которого придет ноут
                body: 'Заповніть будь ласка subscription 😇🙏'
            }, {
                headers: { 'Authorization': `Bearer ${INTERCOM_TOKEN}`, 'Content-Type': 'application/json' }
            });
        } catch (e) {
            log(`Error sending note: ${e.message}`);
        }
    }
}

// === WEBHOOK ENDPOINT ===
app.post('/webhook', async (req, res) => {
    const { topic, data } = req.body;
    const item = data?.item;
    if (!item) return res.status(200).send('OK');

    const conversationId = item.id;
    const contactId = item.contacts?.contacts?.[0]?.id;

    // Триггеры для проверки имейла (в начале чата)
    if (topic === 'conversation.user.created' || topic === 'conversation.user.replied') {
        if (contactId) checkUnpaidEmail(contactId, conversationId);
    }

    // Триггер для подписки (когда чат попал к агенту)
    if (topic === 'conversation.admin.assigned') {
        checkSubscription(item);
    }

    res.status(200).send('OK');
});

app.listen(process.env.PORT || 3000, () => log('Server started'));
