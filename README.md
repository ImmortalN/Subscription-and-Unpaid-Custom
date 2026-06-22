# Subscription & Unpaid Custom Intercom Handler

Сервіс автоматично обробляє webhook'и від Intercom:
- Якщо **Subscription** порожній — надсилає нотатку "Заповніть будь ласка subscription 😇🙏"
- Якщо email клієнта є в списку неплатників — ставить `Unpaid Custom: true` + нотатку

---

## Структура проєкту

- `render-server.js` — **основний файл** (рекомендовано для Render)
- `vercel-api.js` — варіант для Vercel (serverless)
- `package.json`

---

## Як запустити

### 1. Render (Рекомендовано)

1. Створи новий **Web Service** на [Render.com](https://dashboard.render.com/)
2. Підключи цей репозиторій
3. Налаштування:
   - **Name**: будь-яке
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start` (або `node render-server.js`)
4. Додай Environment Variables:
   - `INTERCOM_TOKEN` — твій Intercom Personal Access Token
   - `LIST_URL` — посилання на Google Sheet / текстовий файл з email неплатників
   - `ADMIN_ID` — ID адміністратора в Intercom (для нотаток)
5. Deploy

**Порада**: Додай cron-пінг кожні 10 хвилин на URL `/` щоб сервіс не засинав.

---

### 2. Vercel (альтернатива)

1. Підключи репозиторій до Vercel
2. У `vercel.json` (створи файл) додай:

```json
{
  "version": 2,
  "builds": [
    { "src": "vercel-api.js", "use": "@vercel/node" }
  ],
  "routes": [
    { "src": "/(.*)", "dest": "/vercel-api.js" }
  ]
}
