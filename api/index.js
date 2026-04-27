const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ===================== ENV =====================
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const ADMIN_ID = process.env.ADMIN_ID;
const INTERCOM_VERSION = '2.14';
const TAG_NAME = 'note_sent'; 

// ===================== API CONFIG =====================
const intercom = axios.create({
    baseURL: 'https://api.intercom.io',
    timeout: 5000, // Быстрый таймаут, чтобы не вешать очередь
    headers: {
        Authorization: `Bearer ${INTERCOM_TOKEN}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Intercom-Version': INTERCOM_VERSION
    }
});

const log = (tag, msg) => console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);

// ===================== МГНОВЕННЫЙ КЭШ (защита от дублей вебхука) =====================
const processedSubNotes = new Set(); 
const processedUnpaidContacts = new Map();

// ===================== SUBSCRIPTION LOGIC =====================
async function handleSubscription(item) {
    const conversationId = item?.id;
    // Находим ID пользователя (контакта)
    const contactId = item?.contacts?.contacts?.[0]?.id || item?.source?.author?.id;
    
    if (!conversationId || !contactId) return;
    if (processedSubNotes.has(conversationId)) return;

    try {
        const adminId = item?.admin_assignee_id;
        if (!adminId) return; // Если чат не на агенте, выходим

        // --- КЛЮЧЕВОЕ ИСПРАВЛЕНИЕ: ПЕРЕСПРАШИВАЕМ INTERCOM ---
        // Получаем свежие данные контакта, чтобы точно знать состояние поля Subscription
        const contactRes = await intercom.get(`/contacts/${contactId}`);
        const actualAttributes = contactRes.data?.custom_attributes || {};

        // Проверяем и маленькую, и большую букву (как в Intercom)
        const subValue = actualAttributes.subscription || actualAttributes.Subscription;
        
        // Считаем пустым если: null, undefined, "", " ", или "Unknown"
        const isSubscriptionEmpty = !subValue || 
                                    String(subValue).trim() === "" || 
                                    String(subValue).toLowerCase() === "unknown";

        // Проверяем тег в текущем айтеме (из вебхука)
        const tags = item?.tags?.tags || [];
        const alreadyTagged = tags.some(t => t.name === TAG_NAME);

        if (isSubscriptionEmpty && !alreadyTagged) {
            // Мгновенно блокируем дубли в памяти
            processedSubNotes.add(conversationId);

            log('SUB_LOGIC', `Sending note to ${conversationId} - attribute is really empty`);

            // Отправляем ноут
            await intercom.post(`/conversations/${conversationId}/reply`, {
                message_type: 'note',
                admin_id: ADMIN_ID,
                body: 'Заповніть будь ласка subscription 😇🙏'
            });

            // Ставим тег
            await intercom.post(`/conversations/${conversationId}/tags`, { name: TAG_NAME });
        } else if (!isSubscriptionEmpty) {
            log('SUB_SKIP', `Skip ${conversationId}: Subscription is already set to "${subValue}"`);
        }
    } catch (e) {
        log('SUB_ERR', `Err in ${conversationId}: ${e.message}`);
    }
}

// ===================== UNPAID LOGIC =====================
async function handleUnpaid(item) {
    const contactId = item?.contacts?.contacts?.[0]?.id || item?.source?.author?.id;
    const conversationId = item?.id;
    if (!contactId || !conversationId) return;

    try {
        const emailSet = await getEmailSet();
        const email = (item?.contacts?.contacts?.[0]?.email || item?.source?.author?.email || "").toLowerCase();

        if (!email) return;

        if (emailSet.has(email)) {
            // === КЛИЕНТ В СПИСКЕ (НЕ ОПЛАЧЕНО) ===
            
            // 1. Ставим флаг true
            intercom.put(`/contacts/${contactId}`, {
                custom_attributes: { 'Unpaid Custom': true }
            }).catch(() => {});

            // 2. Логика ноута (только если назначен агент и еще не спамили)
            if (item?.admin_assignee_id && !processedSubNotes.has(conversationId + '_unpaid')) {
                const tags = item?.tags?.tags || [];
                if (!tags.some(t => t.name === 'unpaid_note_sent')) {
                    processedSubNotes.add(conversationId + '_unpaid');
                    
                    await intercom.post(`/conversations/${conversationId}/reply`, {
                        message_type: 'note',
                        admin_id: ADMIN_ID,
                        body: '🛑 Attention!!! Клієнт не заплатив за кастом - саппорт не надаємо!'
                    });
                    await intercom.post(`/conversations/${conversationId}/tags`, { name: 'unpaid_note_sent' });
                }
            }
        } else {
            // === КЛИЕНТА НЕТ В СПИСКЕ (ОПЛАЧЕНО / ЧИСТ) ===
            
            // Снимаем флаг, если он был. 
            // Это гарантирует, что если клиент заплатит, атрибут обновится на false при следующем сообщении.
            intercom.put(`/contacts/${contactId}`, {
                custom_attributes: { 'Unpaid Custom': false }
            }).catch(() => {});
        }
    } catch (e) { 
        log('UNPAID_ERR', e.message); 
    }
}

// ===================== EMAIL CACHE =====================
let emailCache = { set: new Set(), ts: 0, promise: null };
async function getEmailSet() {
    if (emailCache.set.size && Date.now() - emailCache.ts < 3600000) return emailCache.set;
    if (emailCache.promise) return emailCache.promise;
    emailCache.promise = axios.get(LIST_URL).then(res => {
        const list = Array.isArray(res.data) ? res.data : String(res.data).split('\n');
        const set = new Set(list.map(e => String(e).trim().toLowerCase()).filter(Boolean));
        emailCache = { set, ts: Date.now(), promise: null };
        return set;
    }).catch(() => emailCache.set);
    return emailCache.promise;
}

// ===================== WEBHOOK HANDLER =====================
app.post('*', (req, res) => {
    // 1. Мгновенный ответ Интеркому, чтобы он не слал дубликаты по таймауту 5с
    res.status(200).send('OK');

    const topic = req.body?.topic;
    const item = req.body?.data?.item;
    if (!topic || !item) return;

    // Запускаем логику в "фоне" после ответа 200 OK
    if (topic === 'conversation.admin.assigned') {
        handleSubscription(item);
        handleUnpaid(item);
    } else if (topic === 'conversation.user.created' || topic === 'conversation.user.replied') {
        handleUnpaid(item);
    }
});

app.get('/', (req, res) => res.send('System Online'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

module.exports = app;
