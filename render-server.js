const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

// ===================== ENV =====================
const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const LIST_URL = process.env.LIST_URL;
const ADMIN_ID = process.env.ADMIN_ID;
const INTERCOM_VERSION = '2.14';

const SUB_TAG = 'note_sent';
const UNPAID_TAG = 'unpaid_note_sent';

// ===================== API CONFIG =====================
const intercom = axios.create({
    baseURL: 'https://api.intercom.io',
    timeout: 12000,
    headers: {
        Authorization: `Bearer ${INTERCOM_TOKEN}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Intercom-Version': INTERCOM_VERSION
    }
});

const log = (tag, msg) => console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);

// ===================== КЕШ ТА ЗАХИСТ =====================
const processedSubNotes = new Set();
const PROCESSING_LOCK = new Set();

async function handleSubscription(item) {
    const conversationId = item?.id;
    if (!conversationId) return;
    if (processedSubNotes.has(conversationId) || PROCESSING_LOCK.has(conversationId)) return;

    const adminId = item?.admin_assignee_id;
    if (!adminId) return;

    PROCESSING_LOCK.add(conversationId);

    try {
        const contactId = item?.contacts?.contacts?.[0]?.id || item?.source?.author?.id;
        if (!contactId) return;

        const contactRes = await intercom.get(`/contacts/${contactId}`);
        const attrs = contactRes.data?.custom_attributes || {};

        const subValue = attrs.subscription || attrs.Subscription;
        const isSubscriptionEmpty = !subValue || 
                                   String(subValue).trim() === "" || 
                                   String(subValue).toLowerCase() === "unknown";

        if (isSubscriptionEmpty) {
            processedSubNotes.add(conversationId);
            log('SUB_LOGIC', `Sending subscription note to ${conversationId}`);

            await Promise.all([
                intercom.post(`/conversations/${conversationId}/reply`, {
                    message_type: 'note',
                    admin_id: ADMIN_ID,
                    body: 'Заповніть будь ласка subscription 😇🙏'
                }),
                intercom.post(`/conversations/${conversationId}/tags`, { name: SUB_TAG })
            ]);
        }
    } catch (e) {
        log('SUB_ERR', `Conv ${conversationId}: ${e.message}`);
        if (e.message.includes('timeout') || e.code === 'ECONNABORTED') {
            processedSubNotes.delete(conversationId);
        }
    } finally {
        PROCESSING_LOCK.delete(conversationId);
    }
}

// ===================== UNPAID LOGIC =====================
async function handleUnpaid(item) {
    const conversationId = item?.id;
    const contactId = item?.contacts?.contacts?.[0]?.id || item?.source?.author?.id;
    if (!contactId || !conversationId) return;

    try {
        const emailSet = await getEmailSet();
        const email = (item?.contacts?.contacts?.[0]?.email || 
                      item?.source?.author?.email || "").toLowerCase().trim();

        if (!email) return;

        const isUnpaid = emailSet.has(email);

        // Оновлюємо Unpaid Custom
        await intercom.put(`/contacts/${contactId}`, {
            custom_attributes: { 'Unpaid Custom': isUnpaid }
        }).catch(() => {});

        // Якщо unpaid і є агент — нотатка один раз
        if (isUnpaid && item?.admin_assignee_id && !processedSubNotes.has(conversationId + '_unpaid')) {
            const tags = item?.tags?.tags || [];
            if (!tags.some(t => t.name === UNPAID_TAG)) {
                processedSubNotes.add(conversationId + '_unpaid');

                log('UNPAID_LOGIC', `Sending unpaid note to ${conversationId}`);

                await Promise.all([
                    intercom.post(`/conversations/${conversationId}/reply`, {
                        message_type: 'note',
                        admin_id: ADMIN_ID,
                        body: '🛑 Attention!!! Клієнт не заплатив за кастом - саппорт не надаємо!'
                    }),
                    intercom.post(`/conversations/${conversationId}/tags`, { name: UNPAID_TAG })
                ]);
            }
        }
    } catch (e) {
        log('UNPAID_ERR', `Contact ${contactId}: ${e.message}`);
    }
}

// ===================== EMAIL CACHE =====================
let emailCache = { set: new Set(), ts: 0, promise: null };

async function getEmailSet() {
    if (emailCache.set.size && Date.now() - emailCache.ts < 3600000) return emailCache.set;
    if (emailCache.promise) return emailCache.promise;

    emailCache.promise = axios.get(LIST_URL)
        .then(res => {
            const list = Array.isArray(res.data) ? res.data : String(res.data).split('\n');
            const set = new Set(list.map(e => String(e).trim().toLowerCase()).filter(Boolean));
            emailCache = { set, ts: Date.now(), promise: null };
            return set;
        })
        .catch(err => {
            log('EMAIL_CACHE_ERR', err.message);
            return emailCache.set;
        });

    return emailCache.promise;
}

// ===================== WEBHOOK =====================
app.post('*', (req, res) => {
    res.status(200).send('OK');   // швидко відповідаємо Intercom

    const topic = req.body?.topic;
    const item = req.body?.data?.item;
    if (!topic || !item) return;

    if (topic === 'conversation.admin.assigned') {
        setTimeout(() => {
            handleSubscription(item);
            handleUnpaid(item);
        }, 400);
    } else if (topic === 'conversation.user.created' || topic === 'conversation.user.replied') {
        handleUnpaid(item);
    }
});

app.get('/', (req, res) => res.send('✅ Subscription & Unpaid Custom Service Online'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Render server running on port ${PORT}`));

module.exports = app;
