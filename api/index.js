const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ===================== ENV =====================
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const ADMIN_ID = process.env.ADMIN_ID;
const INTERCOM_VERSION = '2.14';

// Название тега для защиты от дублей
const TAG_NAME = 'note_sent'; 

// ===================== INTERCOM API =====================
const intercom = axios.create({
    baseURL: 'https://api.intercom.io',
    timeout: 10000,
    headers: {
        Authorization: `Bearer ${INTERCOM_TOKEN}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Intercom-Version': INTERCOM_VERSION
    }
});

const log = (tag, msg) => console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);

async function safeRequest(fn, retries = 2) {
    let err;
    for (let i = 0; i <= retries; i++) {
        try { return await fn(); } catch (e) {
            err = e;
            await new Promise(r => setTimeout(r, 500 * Math.pow(2, i)));
        }
    }
    throw err;
}

// ===================== HELPER: TAGGING =====================
// Функция для добавления тега к переписке
async function tagConversation(conversationId) {
    try {
        await safeRequest(() => 
            intercom.post(`/conversations/${conversationId}/tags`, {
                name: TAG_NAME
            })
        );
        log('TAG', `Tag "${TAG_NAME}" added to ${conversationId}`);
    } catch (e) {
        log('TAG_ERR', `Could not tag ${conversationId}: ${e.message}`);
    }
}

// Проверка: есть ли уже тег в объекте переписки
function hasNoteTag(item) {
    const tags = item?.tags?.tags || [];
    return tags.some(t => t.name === TAG_NAME);
}

// ===================== EMAIL CACHE =====================
let emailCache = { set: new Set(), ts: 0, promise: null };
async function getEmailSet() {
    const now = Date.now();
    if (emailCache.set.size && now - emailCache.ts < 60 * 60 * 1000) return emailCache.set;
    if (emailCache.promise) return emailCache.promise;

    emailCache.promise = (async () => {
        try {
            const res = await axios.get(LIST_URL, { timeout: 8000 });
            const list = Array.isArray(res.data) ? res.data : String(res.data).split('\n');
            const set = new Set(list.map(e => String(e).trim().toLowerCase()).filter(Boolean));
            emailCache = { set, ts: Date.now(), promise: null };
            return set;
        } catch (e) {
            emailCache.promise = null;
            return emailCache.set;
        }
    })();
    return emailCache.promise;
}

// ===================== LOGIC: UNPAID =====================
async function handleUnpaid(item) {
    const conversationId = item?.id;
    const contactId = item?.contacts?.contacts?.[0]?.id || item?.source?.author?.id;

    if (!conversationId || !contactId) return;

    try {
        const emailSet = await getEmailSet();
        const email = item?.contacts?.contacts?.[0]?.email ?? item?.source?.author?.email;
        const normalized = email?.toLowerCase();

        // 1. Проверяем имейл (Unpaid Custom)
        if (normalized && emailSet.has(normalized)) {
            // Ставим атрибут если не стоит
            safeRequest(() => intercom.put(`/contacts/${contactId}`, {
                custom_attributes: { 'Unpaid Custom': true }
            })).catch(() => {});

            // 2. Оставляем ноут, если назначен агент И еще нет тега "note_sent"
            if (item?.admin_assignee_id && !hasNoteTag(item)) {
                await safeRequest(() => intercom.post(`/conversations/${conversationId}/reply`, {
                    message_type: 'note',
                    admin_id: ADMIN_ID,
                    body: '🛑 Attention!!! Клієнт не заплатив за кастом - саппорт не надаємо!'
                }));
                log('UNPAID_NOTE', conversationId);
                await tagConversation(conversationId);
            }
        }
    } catch (e) { log('UNPAID_ERR', e.message); }
}

// ===================== LOGIC: SUBSCRIPTION =====================
// ===================== LOGIC: SUBSCRIPTION =====================
async function handleSubscription(item) {
    const conversationId = item?.id;
    if (!conversationId) return;

    try {
        const adminId = item?.admin_assignee_id;
        
        // Достаем атрибут. ВАЖНО: Проверьте в Intercom, называется ли он 
        // точно "subscription" (с маленькой буквы) или "Subscription".
        const subscription = item?.custom_attributes?.subscription;

        // ПРОВЕРКА: 
        // 1. Назначен ли живой агент (adminId)
        // 2. Пусто ли поле (null, undefined, пустая строка или строка с пробелами)
        // 3. НЕТ ЛИ ТЕГА note_sent (чтобы не дублировать ноут)
        
        const isSubscriptionEmpty = !subscription || String(subscription).trim() === "";

        if (adminId && isSubscriptionEmpty && !hasNoteTag(item)) {
            
            await safeRequest(() => 
                intercom.post(`/conversations/${conversationId}/reply`, {
                    message_type: 'note',
                    admin_id: ADMIN_ID,
                    body: 'Заповніть будь ласка subscription 😇🙏'
                })
            );

            log('SUB_NOTE', `Sent to ${conversationId}`);

            // Ставим тег, чтобы больше не заходить в это условие для данного чата
            await tagConversation(conversationId);
        }
    } catch (e) {
        log('SUB_LOGIC_ERR', e.message);
    }
}

// ===================== WEBHOOK =====================
app.post('*', (req, res) => {
    res.status(200).send('OK'); // Мгновенный ответ Intercom

    try {
        const topic = req.body?.topic;
        const item = req.body?.data?.item;
        if (!topic || !item) return;

        // Если это назначение на агента
        if (topic === 'conversation.admin.assigned') {
            handleUnpaid(item);
            handleSubscription(item);
        }

        // Если юзер написал первым или ответил (для логики Unpaid)
        if (topic === 'conversation.user.created' || topic === 'conversation.user.replied') {
            handleUnpaid(item);
        }

    } catch (e) { log('WEBHOOK_ERR', e.message); }
});

app.get('/', (req, res) => res.send('System Online'));

module.exports = app;
