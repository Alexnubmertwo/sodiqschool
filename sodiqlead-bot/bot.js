const token = process.env.TELEGRAM_BOT_TOKEN;
const apiUrl = process.env.SODIQLEAD_API_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
const apiSecret = process.env.SODIQLEAD_API_SECRET;

if (!token || !apiUrl || !apiSecret) {
  console.error('Set TELEGRAM_BOT_TOKEN, SODIQLEAD_API_URL, and SODIQLEAD_API_SECRET.');
  process.exit(1);
}

const telegramApi = `https://api.telegram.org/bot${token}`;
let offset = 0;
const waitingForCode = new Set();

async function sendMessage(chatId, text) {
  const response = await fetch(`${telegramApi}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  if (!response.ok) console.error('Telegram sendMessage failed:', await response.text());
}

async function confirmCode(code, telegramUser) {
  const response = await fetch(`${apiUrl.replace(/\/$/, '')}/api/telegram/confirm`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiSecret}`
    },
    body: JSON.stringify({ code, telegramId: String(telegramUser.id), username: telegramUser.username ?? null })
  });
  if (response.status === 404 || response.status === 410) return { ok: false, message: 'Код не найден или срок его действия истёк. Создай новый код на сайте и попробуй ещё раз.' };
  if (response.status === 403) return { ok: false, message: 'Этот код создан для другого Telegram-аккаунта. Войди в Telegram, который привязан к профилю.' };
  if (response.status === 409) return { ok: false, message: 'Этот Telegram-аккаунт уже связан с профилем. Используй вход на сайте.' };
  if (!response.ok) throw new Error(`SodiqLead API returned ${response.status}`);
  return { ok: true };
}

async function handleMessage(message) {
  if (!message?.chat?.id || !message.from) return;
  const chatId = message.chat.id;
  const text = (message.text ?? '').trim();

  if (text.startsWith('/start')) {
    waitingForCode.add(chatId);
    await sendMessage(chatId, 'Привет! Это бот SodiqSchool 👋\n\nЧтобы подтвердить регистрацию или вход, отправь код, который сайт показал на экране.');
    return;
  }

  if (text.startsWith('/cancel')) {
    waitingForCode.delete(chatId);
    await sendMessage(chatId, 'Привязка отменена. Чтобы начать снова, отправь /start.');
    return;
  }

  if (!waitingForCode.has(chatId)) {
    await sendMessage(chatId, 'Для привязки аккаунта отправь /start.');
    return;
  }

  const code = text.replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z0-9-]{5,20}$/.test(code)) {
    await sendMessage(chatId, 'Похоже, это не код привязки. Проверь его на сайте или отправь /cancel.');
    return;
  }

  try {
    const result = await confirmCode(code, message.from);
    if (!result.ok) {
      await sendMessage(chatId, result.message);
      return;
    }
    waitingForCode.delete(chatId);
    await sendMessage(chatId, 'Подтверждено ✅\n\nВозвращайся на SodiqSchool — аккаунт откроется автоматически.');
  } catch (error) {
    console.error('Could not confirm account:', error);
    await sendMessage(chatId, 'Сейчас не получается связаться с сайтом. Попробуй ещё раз чуть позже.');
  }
}

async function poll() {
  while (true) {
    try {
      const response = await fetch(`${telegramApi}/getUpdates?timeout=30&offset=${offset}`);
      if (!response.ok) throw new Error(`Telegram returned ${response.status}: ${await response.text()}`);
      const result = await response.json();
      if (!result.ok) throw new Error(result.description ?? 'Telegram polling failed');
      for (const update of result.result) {
        offset = update.update_id + 1;
        await handleMessage(update.message);
      }
    } catch (error) {
      console.error('Polling error:', error.message);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
}

console.log('SodiqSchool Telegram bot is running.');
poll();
