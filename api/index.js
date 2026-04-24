const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const ADMIN_ID = process.env.ADMIN_ID;
const INTERCOM_VERSION = '2.14';

const intercom = axios.create({
    baseURL: 'https://api.intercom.io',
    headers: {
        'Authorization': `Bearer ${INTERCOM_TOKEN}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Intercom-Version': INTERCOM_VERSION
    },
    timeout: 9000 
});

const log = (tag, msg) => console.log(`[${tag}] ${msg}`);

// --- ЛОГИКА UNPAID ---
async function handleUnpaid(contactId) {
    try {
        const { data: contact } = await intercom.get(`/contacts/${contactId}`);
        
        // Собираем все возможные имейлы
        const mainEmail = contact.email;
        const additional = contact.additional_emails || [];
        const purchaseEmail = contact.custom_attributes?.['Purchase Email']; // Ваша новая хотелка

        const emails = [mainEmail, ...additional, purchaseEmail]
            .filter(Boolean)
            .map(e => String(e).toLowerCase());

        log('UNPAID', `Проверка имейлов контакта ${contactId}: ${JSON.stringify(emails)}`);

        if (emails.length === 0) return;

        const { data: rawList } = await axios.get(LIST_URL);
        const badEmails = (typeof rawList === 'string' ? rawList : JSON.stringify(rawList)).toLowerCase();

        const isUnpaid = emails.some(email => badEmails.includes(email));

        if (isUnpaid) {
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
    try {
        // Пробуем найти заасайненного админа в разных полях (фикс undefined)
        const assignee = item.assignee || item.teammate;
        const subscription = item.custom_attributes?.subscription;

        if (!assignee) {
            log('SUBSCRIPTION_DEBUG', `Assignee не найден. Доступные поля в item: ${Object.keys(item).join(', ')}`);
            return;
        }

        log('SUBSCRIPTION', `Чат ${conversationId}. Назначен: ${assignee.type} (ID: ${assignee.id}). Sub: ${subscription}`);

        // Если назначен именно админ (человек) и поле пустое
        if (assignee.type === 'admin' && !subscription) {
            log('SUBSCRIPTION', `Условия выполнены. Отправляем ноут...`);
            await intercom.post(`/conversations/${conversationId}/reply`, {
                message_type: 'note',
                admin_id: ADMIN_ID,
                body: 'Заповніть будь ласка subscription 😇🙏'
            });
            log('SUBSCRIPTION', 'Ноут отправлен.');
        }
    } catch (e) {
        log('SUBSCRIPTION_ERROR', e.message);
    }
}

app.post('*', async (req, res) => {
    const body = req.body;
    const topic = body?.topic;
    const item = body?.data?.item;

    if (!topic || !item) return res.status(200).send('OK');

    log('EVENT', `Topic: ${topic}`);

    try {
        // Логика Unpaid
        if (topic === 'conversation.user.created' || topic === 'conversation.user.replied') {
            const contactId = item.contacts?.contacts?.[0]?.id || item.source?.author?.id;
            if (contactId && contactId !== 'bot') {
                await handleUnpaid(contactId);
            }
        }

        // Логика Subscription
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
