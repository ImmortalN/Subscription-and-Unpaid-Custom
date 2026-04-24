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
    // Ограничиваем таймаут, чтобы Vercel не убивал функцию молча (лимит Vercel - 10s)
    timeout: 8000 
});

// Расширенная функция для логов
const log = (tag, msg) => console.log(`[${tag}] ${msg}`);

// --- ЛОГИКА UNPAID ---
async function handleUnpaid(contactId) {
    log('UNPAID', `Начинаем проверку для контакта: ${contactId}`);
    try {
        const { data: contact } = await intercom.get(`/contacts/${contactId}`);
        const emails = [contact.email, ...(contact.additional_emails || [])].filter(Boolean).map(e => e.toLowerCase());
        log('UNPAID', `Найдены имейлы: ${JSON.stringify(emails)}`);

        if (emails.length === 0) {
            log('UNPAID', 'У контакта нет имейлов. Пропускаем.');
            return;
        }

        const { data: rawList } = await axios.get(LIST_URL);
        const badEmails = (typeof rawList === 'string' ? rawList : JSON.stringify(rawList)).toLowerCase();

        const match = emails.find(email => badEmails.includes(email));
        if (match) {
            log('UNPAID', `Совпадение найдено (${match})! Ставим атрибут...`);
            await intercom.put(`/contacts/${contactId}`, {
                custom_attributes: { 'Unpaid Custom': true }
            });
            log('UNPAID', 'Атрибут успешно установлен!');
        } else {
            log('UNPAID', 'Имейлы не найдены в списке API ссылке.');
        }
    } catch (e) {
        // Логируем детальную ошибку от самого Интеркома (если она есть)
        const errorDetails = e.response?.data ? JSON.stringify(e.response.data) : e.message;
        log('UNPAID_ERROR', `Ошибка: ${errorDetails}`);
    }
}

// --- ЛОГИКА SUBSCRIPTION ---
async function handleSubscription(item) {
    const conversationId = item.id;
    log('SUBSCRIPTION', `Начинаем проверку чата: ${conversationId}`);
    try {
        const subscription = item.custom_attributes?.subscription;
        const assignee = item.assignee;
        
        log('SUBSCRIPTION', `Кто назначен (assignee): ${JSON.stringify(assignee)}`);
        log('SUBSCRIPTION', `Текущее значение поля subscription: "${subscription}"`);

        if (assignee?.type === 'admin') {
            if (!subscription) {
                log('SUBSCRIPTION', 'Условия совпали: назначен админ, поле пустое. Отправляем ноут...');
                await intercom.post(`/conversations/${conversationId}/reply`, {
                    message_type: 'note',
                    admin_id: ADMIN_ID,
                    body: 'Заповніть будь ласка subscription 😇🙏'
                });
                log('SUBSCRIPTION', 'Ноут успешно отправлен!');
            } else {
                log('SUBSCRIPTION', `Пропуск: поле subscription уже заполнено значением "${subscription}".`);
            }
        } else {
            log('SUBSCRIPTION', `Пропуск: assignee.type = ${assignee?.type} (не admin).`);
        }
    } catch (e) {
        const errorDetails = e.response?.data ? JSON.stringify(e.response.data) : e.message;
        log('SUBSCRIPTION_ERROR', `Ошибка: ${errorDetails}`);
    }
}

// --- ОСНОВНОЙ ВЕБХУК ---
app.post('*', async (req, res) => {
    const body = req.body;
    const topic = body?.topic;
    const item = body?.data?.item;

    log('WEBHOOK_RECEIVED', `Пришел топик: ${topic || 'ТЕСТОВЫЙ/ПУСТОЙ'}`);

    if (!topic || !item) {
        log('WEBHOOK_SKIP', 'Нет топика или данных. Отвечаем 200 OK.');
        return res.status(200).send('OK');
    }

    try {
        // Проверка Unpaid (срабатывает ДО ассайна агенту, когда чат только создался или юзер ответил)
        if (topic === 'conversation.user.created' || topic === 'conversation.user.replied') {
            const contactId = item.contacts?.contacts?.[0]?.id || item.source?.author?.id;
            if (contactId && contactId !== 'bot') {
                await handleUnpaid(contactId);
            } else {
                log('UNPAID_SKIP', `Не найден ID контакта (возможно пишет бот). Значение: ${contactId}`);
            }
        }

        // Проверка Subscription (когда назначен агент)
        if (topic === 'conversation.admin.assigned') {
            await handleSubscription(item);
        }

        log('WEBHOOK_SUCCESS', 'Все действия выполнены, отправляем Интеркому 200 OK.');
        res.status(200).send('OK');
    } catch (err) {
        log('GLOBAL_ERR', err.message);
        res.status(200).send('OK'); // Все равно шлем 200, чтобы не провоцировать ретраи Интеркома
    }
});

module.exports = app;
