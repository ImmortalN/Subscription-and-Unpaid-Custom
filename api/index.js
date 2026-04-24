const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

// === ENV ===
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const ADMIN_ID = process.env.ADMIN_ID;
const INTERCOM_VERSION = '2.14';

// === AXIOS INSTANCE ===
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

// === RETRY HELPER ===
async function safeRequest(fn, retries = 2) {
    try {
        return await fn();
    } catch (e) {
        if (retries > 0) {
            await new Promise(r => setTimeout(r, 1500));
            return safeRequest(fn, retries - 1);
        }
        throw e;
    }
}

// === EMAIL CACHE (1 ЧАС) ===
let emailCache = { set: new Set(), ts: 0, isFetching: false };

async function getEmailSet() {
    const now = Date.now();
    // Если кэш свежий — отдаем сразу
    if (emailCache.set.size && (now - emailCache.ts < 60 * 60 * 1000)) {
        return emailCache.set;
    }
    // Если уже грузится — не создаем параллельный запрос, отдаем старый кэш
    if (emailCache.isFetching) return emailCache.set;

    emailCache.isFetching = true;
    try {
        log('CACHE', 'Загрузка списка имейлов...');
        const res = await axios.get(LIST_URL, { timeout: 12000 });
        let list = Array.isArray(res.data) ? res.data : (typeof res.data === 'string' ? res.data.split('\n') : []);
        
        const set = new Set(list.map(e => String(e).trim().toLowerCase()).filter(Boolean));
        emailCache = { set, ts: now, isFetching: false };
        log('CACHE', `Загружено имейлов: ${set.size}`);
        return set;
    } catch (e) {
        emailCache.isFetching = false;
        log('CACHE_ERR', `Ошибка загрузки: ${e.message}`);
        return emailCache.set; // Возвращаем что есть
    }
}

// === АНТИ-ДУБЛИКАТЫ ===
const processedContacts = new Set();
const processedUnpaidNotes = new Set(); // Для ноутов об оплате
const processedSubNotes = new Set();    // Для ноутов о подписке

// === ЛОГИКА UNPAID ===
async function handleUnpaid(item) {
    const conversationId = item.id;
    const contactId = item.contacts?.contacts?.[0]?.id || item.source?.author?.id;

    if (!contactId || contactId === 'bot') return;

    // Чтобы не дергать API Intercom на каждое сообщение одного юзера
    if (processedContacts.has(contactId)) return;
    processedContacts.add(contactId);
    setTimeout(() => processedContacts.delete(contactId), 300000); // 5 мин кэш юзера

    try {
        const emailSet = await getEmailSet();
        let email = (item.contacts?.contacts?.[0]?.email || item.source?.author?.email)?.toLowerCase();
        
        let isMatch = email && emailSet.has(email);
        let contact = null;

        // Если в вебхуке нет имейла или он не в списке — проверяем через API (включая Purchase email)
        if (!isMatch) {
            const contactRes = await safeRequest(() => intercom.get(`/contacts/${contactId}`));
            contact = contactRes.data;
            const mainEmail = contact.email?.toLowerCase();
            const purchaseEmail = contact.custom_attributes?.['Purchase email']?.toLowerCase();
            isMatch = emailSet.has(mainEmail) || emailSet.has(purchaseEmail);
        }

        if (isMatch) {
            // 1. Ставим атрибут (если еще не стоит)
            if (contact?.custom_attributes?.['Unpaid Custom'] !== true) {
                safeRequest(() => intercom.put(`/contacts/${contactId}`, {
                    custom_attributes: { 'Unpaid Custom': true }
                })).catch(e => log('UNPAID_ATTR_ERR', e.message));
            }

            // 2. Шлем Note (если назначен админ и еще не слали в этот чат)
            if (item.admin_assignee_id && !processedUnpaidNotes.has(conversationId)) {
                processedUnpaidNotes.add(conversationId);
                safeRequest(() => intercom.post(`/conversations/${conversationId}/reply`, {
                    message_type: 'note',
                    admin_id: ADMIN_ID,
                    body: '🛑 Attention!!! Клієнт не заплатив за кастом - саппорт не надаємо!'
                })).then(() => log('NOTE_UNPAID', conversationId)).catch(() => {});
            }
        }
    } catch (e) {
        log('UNPAID_LOGIC_ERR', e.message);
    }
}

// === ЛОГИКА SUBSCRIPTION ===
async function handleSubscription(item) {
    const conversationId = item.id;
    if (!conversationId || processedSubNotes.has(conversationId)) return;

    try {
        const adminId = item.admin_assignee_id;
        const subscription = item.custom_attributes?.subscription;

        if (adminId && !subscription) {
            processedSubNotes.add(conversationId);
            safeRequest(() => intercom.post(`/conversations/${conversationId}/reply`, {
                message_type: 'note',
                admin_id: ADMIN_ID,
                body: 'Заповніть будь ласка subscription 😇🙏'
            })).then(() => log('NOTE_SUB', conversationId)).catch(() => {});
            
            // Очистка через 10 мин, чтобы при переназначении через час ноут мог прийти снова
            setTimeout(() => processedSubNotes.delete(conversationId), 600000);
        }
    } catch (e) {
        log('SUB_LOGIC_ERR', e.message);
    }
}

// === WEBHOOK ENTRY ===
app.post('*', (req, res) => {
    res.status(200).send('OK');

    const topic = req.body?.topic;
    const item = req.body?.data?.item;
    if (!topic || !item) return;

    // Фоновое выполнение
    if (topic === 'conversation.user.created' || topic === 'conversation.user.replied') {
        handleUnpaid(item);
    }

    if (topic === 'conversation.admin.assigned') {
        handleUnpaid(item); // Проверяем оплату при назначении
        handleSubscription(item); // Проверяем подписку при назначении
    }
});

app.get('/', (req, res) => res.send('System Online'));

module.exports = app;
