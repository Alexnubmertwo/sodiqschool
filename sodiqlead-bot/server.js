import { createServer } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const directory = path.dirname(fileURLToPath(import.meta.url));
try {
  const envText = await readFile(path.join(directory, '.env'), 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch {}

const port = Number(process.env.PORT ?? 3000);
const apiSecret = process.env.SODIQLEAD_API_SECRET;
const adminTelegramUsername = (process.env.SODIQSCHOOL_ADMIN_TELEGRAM ?? '').replace(/^@/, '').toLocaleLowerCase('en');
// DATA_DIR should point at a persistent volume in production; the default is the app folder (lost on redeploy).
const dataDirectory = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : directory;
const dbPath = path.join(dataDirectory, 'data.json');
const backupDirectory = path.join(dataDirectory, 'backups');
const codes = new Map();
const accounts = new Map();
const sessions = new Map();
const classes = new Set();
const posts = new Map();
const initiatives = new Map();
const problems = new Map();
let siteIcon = null; // data URL of the browser-tab icon; null means the default icon
const imagePattern = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const issuedByAddress = new Map();
const loginAttemptsByAddress = new Map();
const studentActions = new Map();
const maxRegistrationsPerWindow = 5;
const codeLifetime = 10 * 60_000;
const sessionLifetime = 30 * 24 * 60 * 60;
const securityHeaders = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()'
};

if (!apiSecret || apiSecret.length < 24) {
  console.error('Set a random SODIQLEAD_API_SECRET of at least 24 characters in .env.');
  process.exit(1);
}

// Optional Supabase storage: when SUPABASE_URL and SUPABASE_SECRET_KEY are set, the whole store lives in
// the app_store table (row id = 1) instead of data.json, so it survives every redeploy.
const supabaseUrl = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
const supabaseKey = process.env.SUPABASE_SECRET_KEY ?? '';
const useSupabase = Boolean(supabaseUrl && supabaseKey);
const supabaseHeaders = { apikey: supabaseKey, authorization: `Bearer ${supabaseKey}`, 'content-type': 'application/json' };

async function loadSavedData() {
  if (!useSupabase) {
    try { return JSON.parse(await readFile(dbPath, 'utf8')); }
    catch { return null; }
  }
  const response = await fetch(`${supabaseUrl}/rest/v1/app_store?id=eq.1&select=data`, {
    headers: supabaseHeaders,
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`Supabase load failed with status ${response.status}`);
  const rows = await response.json();
  return rows[0]?.data ?? null;
}

let saved;
try { saved = await loadSavedData(); }
catch (error) {
  // Never start from empty data when the remote store is unreachable: the next save would overwrite everything.
  if (useSupabase) {
    console.error(error.message);
    process.exit(1);
  }
  saved = null;
}

if (saved) {
  for (const [code, value] of Object.entries(saved.codes ?? {})) codes.set(code, value);
  for (const [telegramId, value] of Object.entries(saved.accounts ?? {})) accounts.set(telegramId, value);
  for (const [sessionId, value] of Object.entries(saved.sessions ?? {})) sessions.set(sessionId, value);
  for (const className of saved.classes ?? ['10A', '10Oxford']) classes.add(className);
  for (const post of saved.posts ?? []) posts.set(post.id, post);
  for (const initiative of saved.initiatives ?? []) initiatives.set(initiative.id, initiative);
  for (const problem of saved.problems ?? []) problems.set(problem.id, problem);
  siteIcon = typeof saved.siteIcon === 'string' && imagePattern.test(saved.siteIcon) ? saved.siteIcon : null;
} else {
  classes.add('10A');
  classes.add('10Oxford');
}

if (useSupabase) console.log('SodiqSchool data store: Supabase');

let saveQueue = Promise.resolve();
async function backupCurrentData() {
  await mkdir(backupDirectory, { recursive: true });
  try {
    const backupName = `data-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}.json`;
    await copyFile(dbPath, path.join(backupDirectory, backupName));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const backups = (await readdir(backupDirectory)).filter(name => name.endsWith('.json')).sort().reverse();
  await Promise.all(backups.slice(20).map(name => unlink(path.join(backupDirectory, name)).catch(() => {})));
}

function persist() {
  const snapshot = JSON.stringify({
    codes: Object.fromEntries(codes),
    accounts: Object.fromEntries(accounts),
    sessions: Object.fromEntries(sessions),
  classes: [...classes],
  posts: [...posts.values()],
  initiatives: [...initiatives.values()],
  problems: [...problems.values()],
  siteIcon
  }, null, 2);
  saveQueue = saveQueue.catch(() => {}).then(async () => {
    if (useSupabase) {
      const response = await fetch(`${supabaseUrl}/rest/v1/app_store?id=eq.1`, {
        method: 'PATCH',
        headers: { ...supabaseHeaders, prefer: 'return=minimal' },
        body: JSON.stringify({ data: JSON.parse(snapshot), updated_at: new Date().toISOString() }),
        signal: AbortSignal.timeout(15_000)
      });
      if (!response.ok) throw new Error(`Supabase save failed with status ${response.status}`);
      return;
    }
    try { await backupCurrentData(); }
    catch (error) { console.error('Could not create data backup:', error.message); }
    const temporaryPath = `${dbPath}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(temporaryPath, snapshot, { mode: 0o600 });
    await rename(temporaryPath, dbPath);
  });
  return saveQueue;
}

if (!useSupabase) {
  try { await backupCurrentData(); }
  catch (error) { console.error('Could not create initial data backup:', error.message); }
}

async function notifyTelegram(telegramId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !telegramId) return;
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: telegramId, text }),
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) console.error('Telegram notification returned status:', response.status);
  } catch (error) {
    console.error('Telegram notification failed:', error.message);
  }
}

function json(response, status, value, extraHeaders = {}) {
  response.writeHead(status, { ...securityHeaders, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders });
  response.end(JSON.stringify(value));
}

function publicInitiative(idea, account) {
  const likes = Array.isArray(idea.likes) ? idea.likes : [];
  const { likes: storedLikes, authorTelegramId, ...visibleIdea } = idea;
  return {
    ...visibleIdea,
    likeCount: likes.length,
    liked: Boolean(account && likes.some(like => (typeof like === 'string' ? like : like?.telegramId) === account.telegramId)),
    isOwner: Boolean(account && authorTelegramId === account.telegramId),
    votingClosesAt: idea.votingClosesAt ?? (idea.createdAt + 14 * 24 * 60 * 60 * 1000)
  };
}

function publicPost(post, account) {
  const attendees = Array.isArray(post.attendees) ? post.attendees : [];
  const { attendees: storedAttendees, ...visiblePost } = post;
  return { ...visiblePost, goingCount: attendees.length, going: Boolean(account && attendees.includes(account.telegramId)) };
}

function publicProblem(problem, key = '') {
  return { id: problem.id, text: problem.text, createdAt: problem.createdAt, supportCount: problem.supporters.length, supported: Boolean(key && problem.supporters.includes(key)) };
}

// Stable keyed hash of an account; stored instead of the account id so supports cannot be traced back without the server secret.
function problemKey(telegramId) {
  return createHmac('sha256', apiSecret).update(String(telegramId)).digest('hex').slice(0, 32);
}

// undefined = keep existing, null = remove, string = new valid image, false = invalid
function normalizeImage(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 1_500_000 || !imagePattern.test(value)) return false;
  return value;
}

async function readBody(request, limit = 10_000) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > limit) throw new Error('Request body too large');
  }
  return JSON.parse(body || '{}');
}

function constantTimeMatch(actual, expected) {
  if (!actual || !expected) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function hasApiSecret(request) {
  return constantTimeMatch(request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '', apiSecret);
}

function getAccount(request) {
  const cookieHeader = request.headers.cookie ?? '';
  const sessionId = cookieHeader.match(/(?:^|;\s*)sodiqschool_session=([a-f0-9]+)/)?.[1];
  const session = sessionId ? sessions.get(sessionId) : null;
  if (!session || session.expiresAt <= Date.now()) return null;
  const account = accounts.get(session.telegramId);
  return account ? { ...account, telegramId: session.telegramId, sessionId } : null;
}

// Behind Railway's proxy the socket address is shared by everyone, so use the address the proxy appended to X-Forwarded-For.
function clientAddress(request) {
  const forwarded = String(request.headers['x-forwarded-for'] ?? '').split(',').map(part => part.trim()).filter(Boolean);
  return forwarded.at(-1) ?? request.socket.remoteAddress ?? 'unknown';
}

function isAdmin(account) {
  return Boolean(adminTelegramUsername && account?.username?.replace(/^@/, '').trim().toLocaleLowerCase('en') === adminTelegramUsername);
}

function allowAction(key, limit, windowMs) {
  const recent = (studentActions.get(key) ?? []).filter(time => Date.now() - time < windowMs);
  if (recent.length >= limit) return false;
  recent.push(Date.now());
  studentActions.set(key, recent);
  return true;
}

function isValidClassName(value) {
  return typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 30 && /^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u.test(value.trim());
}

function findAccountByDetails(body) {
  const firstName = String(body.firstName ?? '').trim().toLocaleLowerCase('ru');
  const lastName = String(body.lastName ?? '').trim().toLocaleLowerCase('ru');
  const schoolClass = String(body.schoolClass ?? '').trim().toLocaleLowerCase('ru');
  for (const [telegramId, account] of accounts) {
    if (account.firstName.toLocaleLowerCase('ru') === firstName && account.lastName.toLocaleLowerCase('ru') === lastName && account.schoolClass.toLocaleLowerCase('ru') === schoolClass) return telegramId;
  }
  return null;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
  try {
    const hasOrigin = request.headers.origin;
    if (hasOrigin) {
      const forwardedProtocol = request.headers['x-forwarded-proto']?.split(',')[0].trim();
      const expectedOrigin = `${request.socket.encrypted || forwardedProtocol === 'https' ? 'https' : 'http'}://${request.headers.host ?? 'localhost'}`;
      try {
        if (new URL(hasOrigin).origin !== new URL(expectedOrigin).origin) return json(response, 403, { error: 'Cross-origin request rejected.' });
      } catch {
        return json(response, 403, { error: 'Invalid request origin.' });
      }
    }
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const page = await readFile(path.join(directory, '..', 'index.html'));
      response.writeHead(200, { ...securityHeaders, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return response.end(page);
    }
    if (request.method === 'GET' && ['/icon.png', '/favicon.png', '/favicon.ico'].includes(url.pathname)) {
      // Search engines need a plain URL with real image bytes: the admin-uploaded icon if there is one, otherwise the SodiqLead logo file.
      const match = siteIcon?.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
      const icon = match ? Buffer.from(match[2], 'base64') : await readFile(path.join(directory, '..', 'icon.png'));
      response.writeHead(200, { ...securityHeaders, 'content-type': match ? match[1] : 'image/png', 'cache-control': 'public, max-age=300' });
      return response.end(icon);
    }
    if (request.method === 'GET' && (url.pathname === '/sitemap.xml' || url.pathname === '/robots.txt')) {
      const protocol = request.headers['x-forwarded-proto']?.split(',')[0].trim() === 'http' ? 'http' : 'https';
      const host = /^[a-z0-9.-]+(:\d+)?$/i.test(request.headers.host ?? '') ? request.headers.host : 'localhost';
      const origin = `${protocol}://${host}`;
      const isSitemap = url.pathname === '/sitemap.xml';
      const body = isSitemap
        ? `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/</loc></url></urlset>\n`
        : `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`;
      response.writeHead(200, { ...securityHeaders, 'content-type': isSitemap ? 'application/xml; charset=utf-8' : 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' });
      return response.end(body);
    }
    if (request.method === 'GET' && url.pathname === '/api/health') return json(response, 200, { ok: true });
    if (request.method === 'GET' && url.pathname === '/api/classes') return json(response, 200, { classes: [...classes].sort((a, b) => a.localeCompare(b, 'ru')) });
    if (request.method === 'GET' && url.pathname === '/api/site-icon') return json(response, 200, { icon: siteIcon });
    if (request.method === 'GET' && url.pathname === '/api/content') {
      const account = getAccount(request);
      return json(response, 200, {
        classes: [...classes].sort((a, b) => a.localeCompare(b, 'ru')),
        posts: [...posts.values()].sort((a, b) => Number(b.scheduledAt ?? b.createdAt) - Number(a.scheduledAt ?? a.createdAt)).map(post => publicPost(post, account)),
        initiatives: [...initiatives.values()].sort((a, b) => b.createdAt - a.createdAt).map(idea => publicInitiative(idea, account))
      });
    }
    const rsvpMatch = url.pathname.match(/^\/api\/events\/([a-f0-9]+)\/rsvp$/);
    if (request.method === 'POST' && rsvpMatch) {
      const account = getAccount(request);
      if (!account) return json(response, 401, { error: 'Войди, чтобы записаться на мероприятие.' });
      if (!allowAction(`rsvp:${account.telegramId}`, 15, 60_000)) return json(response, 429, { error: 'Слишком много действий с событиями. Подожди минуту.' });
      const event = posts.get(rsvpMatch[1]);
      if (!event || event.type !== 'event') return json(response, 404, { error: 'Мероприятие не найдено.' });
      if (event.scheduledAt && Date.parse(event.scheduledAt) < Date.now()) return json(response, 410, { error: 'Запись на это мероприятие завершена.' });
      event.attendees = Array.isArray(event.attendees) ? event.attendees : [];
      const existing = event.attendees.indexOf(account.telegramId);
      if (existing >= 0) event.attendees.splice(existing, 1);
      else event.attendees.push(account.telegramId);
      await persist();
      return json(response, 200, { goingCount: event.attendees.length, going: existing < 0 });
    }
    if (request.method === 'GET' && url.pathname === '/api/problems') {
      const account = getAccount(request);
      const token = String(url.searchParams.get('token') ?? '');
      const key = account ? problemKey(account.telegramId) : (/^[a-f0-9]{16,64}$/.test(token) ? problemKey(`anon:${token}`) : '');
      return json(response, 200, { canWrite: Boolean(account), problems: [...problems.values()].sort((a, b) => b.createdAt - a.createdAt).map(problem => publicProblem(problem, key)) });
    }
    if (request.method === 'POST' && url.pathname === '/api/problems') {
      const account = getAccount(request);
      if (!account) return json(response, 401, { error: 'Войди в аккаунт ученика, чтобы написать проблему.' });
      if (!allowAction(`problem:${account.telegramId}`, 3, 10 * 60_000)) return json(response, 429, { error: 'Слишком много сообщений. Попробуй через несколько минут.' });
      const body = await readBody(request);
      const text = String(body.text ?? '').trim();
      if (text.length < 5 || text.length > 1000) return json(response, 400, { error: 'Опиши проблему в 5–1000 символах.' });
      // Anonymous: the record holds no name, account or IP. Only a keyed hash of the account is kept, for "Я тоже".
      const problem = { id: randomBytes(8).toString('hex'), text, createdAt: Date.now(), supporters: [] };
      problems.set(problem.id, problem);
      await persist();
      return json(response, 201, publicProblem(problem, problemKey(account.telegramId)));
    }
    const problemSupportMatch = url.pathname.match(/^\/api\/problems\/([a-f0-9]+)\/support$/);
    if (request.method === 'POST' && problemSupportMatch) {
      // Anyone can support. Students are counted by account, guests by a random per-browser token.
      const account = getAccount(request);
      const body = await readBody(request);
      const token = String(body.token ?? '').trim();
      if (!account && !/^[a-f0-9]{16,64}$/.test(token)) return json(response, 400, { error: 'Не удалось определить браузер. Обнови страницу.' });
      const problem = problems.get(problemSupportMatch[1]);
      if (!problem) return json(response, 404, { error: 'Проблема не найдена.' });
      const limitKey = account ? `support:${account.telegramId}` : `support-ip:${clientAddress(request)}`;
      if (!allowAction(limitKey, account ? 60 : 30, 60_000)) return json(response, 429, { error: 'Слишком часто. Подожди минуту.' });
      const key = account ? problemKey(account.telegramId) : problemKey(`anon:${token}`);
      const existing = problem.supporters.indexOf(key);
      if (existing >= 0) problem.supporters.splice(existing, 1);
      else problem.supporters.push(key);
      await persist();
      return json(response, 200, publicProblem(problem, key));
    }
    if (request.method === 'GET' && url.pathname === '/api/rating') {
      if (!getAccount(request)) return json(response, 401, { error: 'Войди в аккаунт, чтобы открыть рейтинг.' });
      const periodDays = 14;
      const since = Date.now() - periodDays * 24 * 60 * 60 * 1000;
      const accountById = accounts;
      const ranking = new Map([...classes].map(schoolClass => [schoolClass, { schoolClass, activeIds: new Set(), initiatives: 0, likes: 0 }]));
      const getRow = schoolClass => {
        if (!schoolClass) return null;
        if (!ranking.has(schoolClass)) ranking.set(schoolClass, { schoolClass, activeIds: new Set(), initiatives: 0, likes: 0 });
        return ranking.get(schoolClass);
      };
      for (const idea of initiatives.values()) {
        const row = getRow(idea.schoolClass);
        if (!row) continue;
        const createdAt = Number(idea.createdAt) || 0;
        if (createdAt >= since) {
          row.initiatives += 1;
          row.activeIds.add(idea.authorTelegramId ? `tg:${idea.authorTelegramId}` : `author:${idea.author || idea.id}`);
        }
        const likes = Array.isArray(idea.likes) ? idea.likes : [];
        for (const like of likes) {
          const telegramId = typeof like === 'string' ? like : like?.telegramId;
          const likedAt = typeof like === 'string' ? createdAt : Number(like?.createdAt) || createdAt;
          if (likedAt < since) continue;
          row.likes += 1;
          const voter = telegramId ? accountById.get(telegramId) : null;
          const voterRow = getRow(voter?.schoolClass);
          if (voterRow && telegramId && !isAdmin(voter)) voterRow.activeIds.add(`tg:${telegramId}`);
        }
      }
      const rows = [...ranking.values()].map(({ activeIds, ...row }) => ({ ...row, activeStudents: activeIds.size }))
        .sort((a, b) => b.activeStudents - a.activeStudents || b.likes - a.likes || b.initiatives - a.initiatives || a.schoolClass.localeCompare(b.schoolClass, 'ru'));
      return json(response, 200, { periodDays, since, rows });
    }
    if (request.method === 'POST' && url.pathname === '/api/initiatives') {
      const account = getAccount(request);
      if (!account) return json(response, 401, { error: 'Войди в аккаунт ученика, чтобы предложить инициативу.' });
      if (isAdmin(account)) return json(response, 403, { error: 'Инициативы могут предлагать только ученики.' });
      if (!allowAction(`idea:${account.telegramId}`, 5, 60 * 60_000)) return json(response, 429, { error: 'Можно отправить не больше 5 инициатив в час.' });
      const body = await readBody(request);
      const title = String(body.title ?? '').trim();
      const description = String(body.description ?? '').trim();
      const category = String(body.category ?? 'Другое').trim().slice(0, 40);
      if (title.length < 3 || title.length > 70 || description.length < 5 || description.length > 1000) return json(response, 400, { error: 'Проверь название и описание инициативы.' });
      const createdAt = Date.now();
      const idea = { id: randomBytes(8).toString('hex'), title, description, category, status: 'На рассмотрении', adminNote: '', author: `${account.firstName} ${account.lastName}`, authorTelegramId: account.telegramId, schoolClass: account.schoolClass, createdAt, votingClosesAt: createdAt + 14 * 24 * 60 * 60 * 1000, likes: [] };
      initiatives.set(idea.id, idea);
      await persist();
      return json(response, 201, publicInitiative(idea, account));
    }
    const likeMatch = url.pathname.match(/^\/api\/initiatives\/([a-f0-9]+)\/like$/);
    if (request.method === 'POST' && likeMatch) {
      const account = getAccount(request);
      if (!account) return json(response, 401, { error: 'Войди в аккаунт, чтобы поддержать инициативу.' });
      if (isAdmin(account)) return json(response, 403, { error: 'Голосовать за инициативы могут ученики.' });
      if (!allowAction(`like:${account.telegramId}`, 40, 60_000)) return json(response, 429, { error: 'Слишком много голосов. Подожди минуту.' });
      const idea = initiatives.get(likeMatch[1]);
      if (!idea) return json(response, 404, { error: 'Инициатива не найдена.' });
      if (Date.now() > (idea.votingClosesAt ?? idea.createdAt + 14 * 24 * 60 * 60 * 1000)) return json(response, 410, { error: 'Срок голосования по этой инициативе завершён.' });
      idea.likes = Array.isArray(idea.likes) ? idea.likes : [];
      const existing = idea.likes.findIndex(like => (typeof like === 'string' ? like : like?.telegramId) === account.telegramId);
      if (existing >= 0) idea.likes.splice(existing, 1);
      else idea.likes.push({ telegramId: account.telegramId, createdAt: Date.now() });
      await persist();
      return json(response, 200, { likeCount: idea.likes.length, liked: existing < 0 });
    }
    const initiativeMatch = url.pathname.match(/^\/api\/initiatives\/([a-f0-9]+)$/);
    if (initiativeMatch && ['PUT', 'DELETE'].includes(request.method)) {
      const account = getAccount(request);
      if (!account) return json(response, 401, { error: 'Войди в аккаунт.' });
      const idea = initiatives.get(initiativeMatch[1]);
      if (!idea) return json(response, 404, { error: 'Инициатива не найдена.' });
      if (idea.authorTelegramId !== account.telegramId) return json(response, 403, { error: 'Можно изменять только свои инициативы.' });
      if (request.method === 'DELETE') {
        initiatives.delete(idea.id);
        await persist();
        return json(response, 200, { ok: true });
      }
      if (idea.status !== 'На рассмотрении') return json(response, 409, { error: 'Инициативу можно редактировать только пока она на рассмотрении.' });
      const body = await readBody(request);
      const title = String(body.title ?? '').trim();
      const description = String(body.description ?? '').trim();
      const category = String(body.category ?? '').trim().slice(0, 40);
      if (title.length < 3 || title.length > 70 || description.length < 5 || description.length > 1000) return json(response, 400, { error: 'Проверь название и описание инициативы.' });
      Object.assign(idea, { title, description, category: category || 'Другое', updatedAt: Date.now() });
      await persist();
      return json(response, 200, publicInitiative(idea, account));
    }
    if (request.method === 'GET' && url.pathname === '/api/me') {
      const account = getAccount(request);
      if (!account) return json(response, 401, { error: 'Войди в аккаунт.' });
      return json(response, 200, { firstName: account.firstName, lastName: account.lastName, schoolClass: account.schoolClass, telegramUsername: account.username, isAdmin: isAdmin(account) });
    }

    if (request.method === 'POST' && url.pathname === '/api/register') {
      const address = clientAddress(request);
      const recent = (issuedByAddress.get(address) ?? []).filter(time => Date.now() - time < 60_000);
      if (recent.length >= maxRegistrationsPerWindow) return json(response, 429, { error: 'Слишком много попыток. Попробуй позже.' });
      const body = await readBody(request);
      const firstName = String(body.firstName ?? '').trim();
      const lastName = String(body.lastName ?? '').trim();
      const schoolClass = String(body.schoolClass ?? '').trim();
      if (firstName.length < 2 || firstName.length > 50 || lastName.length < 2 || lastName.length > 50 || !classes.has(schoolClass)) return json(response, 400, { error: 'Проверь имя, фамилию и выбери класс из списка.' });
      if ([...accounts.values()].some(account => account.firstName.toLocaleLowerCase('ru') === firstName.toLocaleLowerCase('ru') && account.lastName.toLocaleLowerCase('ru') === lastName.toLocaleLowerCase('ru') && account.schoolClass === schoolClass)) return json(response, 409, { error: 'Такой аккаунт уже зарегистрирован. Используй кнопку «Войти».' });
      const code = randomBytes(6).toString('hex').toUpperCase();
      const expiresAt = Date.now() + codeLifetime;
      codes.set(code, { type: 'register', firstName, lastName, schoolClass, expiresAt, confirmed: false, telegramId: null, username: null });
      recent.push(Date.now());
      issuedByAddress.set(address, recent);
      await persist();
      return json(response, 201, { code, expiresAt });
    }

    if (request.method === 'POST' && url.pathname === '/api/login') {
      const address = clientAddress(request);
      const recent = (loginAttemptsByAddress.get(address) ?? []).filter(time => Date.now() - time < 60_000);
      if (recent.length >= 10) return json(response, 429, { error: 'Слишком много попыток входа. Попробуй через минуту.' });
      recent.push(Date.now());
      loginAttemptsByAddress.set(address, recent);
      const body = await readBody(request);
      const telegramId = findAccountByDetails(body);
      if (!telegramId) return json(response, 404, { error: 'Аккаунт не найден. Проверь данные или зарегистрируйся.' });
      const account = accounts.get(telegramId);
      const code = randomBytes(6).toString('hex').toUpperCase();
      const expiresAt = Date.now() + codeLifetime;
      codes.set(code, { type: 'login', firstName: account.firstName, lastName: account.lastName, schoolClass: account.schoolClass, expectedTelegramId: telegramId, expiresAt, confirmed: false, telegramId: null, username: account.username });
      await persist();
      return json(response, 201, { code, expiresAt });
    }

    if (request.method === 'POST' && url.pathname === '/api/telegram/confirm') {
      if (!hasApiSecret(request)) return json(response, 401, { error: 'Unauthorized' });
      const body = await readBody(request);
      const code = String(body.code ?? '').trim();
      const telegramId = String(body.telegramId ?? '').trim();
      const entry = codes.get(code);
      if (!entry || entry.expiresAt <= Date.now() || entry.confirmed) return json(response, entry?.expiresAt <= Date.now() ? 410 : 404, { error: 'Код не найден, истёк или уже использован.' });
      if (!/^\d{1,30}$/.test(telegramId)) return json(response, 400, { error: 'Некорректный Telegram ID.' });
      if (entry.type === 'login' && telegramId !== entry.expectedTelegramId) return json(response, 403, { error: 'Этот код создан для другого Telegram аккаунта.' });
      if (entry.type === 'register' && accounts.has(telegramId)) return json(response, 409, { error: 'Этот Telegram аккаунт уже привязан. Используй вход.' });
      entry.confirmed = true;
      entry.telegramId = telegramId;
      entry.username = typeof body.username === 'string' ? body.username.slice(0, 64) : null;
      if (entry.type === 'register') accounts.set(telegramId, { firstName: entry.firstName, lastName: entry.lastName, schoolClass: entry.schoolClass, username: entry.username, confirmedAt: Date.now() });
      else if (entry.type === 'login') accounts.set(telegramId, { ...accounts.get(telegramId), username: entry.username, lastLoginAt: Date.now() });
      await persist();
      return json(response, 200, { ok: true });
    }

    if (request.method === 'GET' && url.pathname === '/api/link-status') {
      const code = String(url.searchParams.get('code') ?? '').trim();
      const entry = codes.get(code);
      if (!entry || entry.expiresAt <= Date.now()) return json(response, 404, { error: 'Код не найден или истёк.' });
      if (!entry.confirmed) return json(response, 200, { confirmed: false, expiresAt: entry.expiresAt });
      if (!entry.sessionId || !sessions.has(entry.sessionId)) {
        entry.sessionId = randomBytes(32).toString('hex');
        sessions.set(entry.sessionId, { telegramId: entry.telegramId, expiresAt: Date.now() + sessionLifetime * 1000 });
      }
      const secureCookie = request.socket.encrypted || request.headers['x-forwarded-proto']?.split(',')[0].trim() === 'https' ? '; Secure' : '';
      const cookie = `sodiqschool_session=${entry.sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${sessionLifetime}${secureCookie}`;
      if (!entry.sessionIssued) {
        entry.sessionIssued = true;
        await persist();
      }
      return json(response, 200, { confirmed: true, firstName: entry.firstName, lastName: entry.lastName, schoolClass: entry.schoolClass }, { 'set-cookie': cookie });
    }

    if (request.method === 'POST' && url.pathname === '/api/logout') {
      const account = getAccount(request);
      if (account) sessions.delete(account.sessionId);
      await persist();
      return json(response, 200, { ok: true }, { 'set-cookie': 'sodiqschool_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
    }

    if (url.pathname.startsWith('/api/admin/')) {
      const account = getAccount(request);
      if (!account || !isAdmin(account)) return json(response, 403, { error: 'Этот раздел доступен только администратору @ShindoTensei.' });
      if (request.method === 'GET' && url.pathname === '/api/admin/classes') return json(response, 200, { classes: [...classes].sort((a, b) => a.localeCompare(b, 'ru')) });
      if (request.method === 'PUT' && url.pathname === '/api/admin/site-icon') {
        const body = await readBody(request, 2_000_000);
        const icon = normalizeImage(body.image);
        if (icon === false) return json(response, 400, { error: 'Выбери картинку JPG, PNG или WebP.' });
        siteIcon = icon ?? null;
        await persist();
        return json(response, 200, { icon: siteIcon });
      }
      if (request.method === 'GET' && url.pathname === '/api/admin/stats') {
        const allLikes = [...initiatives.values()].reduce((sum, idea) => sum + (Array.isArray(idea.likes) ? idea.likes.length : 0), 0);
        const eventAttendees = [...posts.values()].reduce((sum, post) => sum + (Array.isArray(post.attendees) ? post.attendees.length : 0), 0);
        return json(response, 200, {
          students: [...accounts.values()].filter(student => !isAdmin(student)).length,
          initiatives: initiatives.size,
          likes: allLikes,
          news: [...posts.values()].filter(post => post.type === 'news').length,
          events: [...posts.values()].filter(post => post.type === 'event').length,
          eventAttendees,
          inProgress: [...initiatives.values()].filter(idea => idea.status === 'В работе').length,
          realized: [...initiatives.values()].filter(idea => idea.status === 'Реализовано').length
        });
      }
      const adminIdeaMatch = url.pathname.match(/^\/api\/admin\/initiatives\/([a-f0-9]+)$/);
      if (adminIdeaMatch && request.method === 'PATCH') {
        const idea = initiatives.get(adminIdeaMatch[1]);
        if (!idea) return json(response, 404, { error: 'Инициатива не найдена.' });
        const body = await readBody(request);
        const statuses = ['На рассмотрении', 'В работе', 'Реализовано'];
        const status = String(body.status ?? idea.status);
        const adminNote = String(body.adminNote ?? '').trim();
        if (!statuses.includes(status) || adminNote.length > 500) return json(response, 400, { error: 'Проверь статус и пояснение (до 500 символов).' });
        const statusChanged = status !== idea.status;
        const noteChanged = adminNote !== (idea.adminNote ?? '');
        Object.assign(idea, { status, adminNote, reviewedAt: Date.now() });
        await persist();
        if ((statusChanged || noteChanged) && idea.authorTelegramId) {
          const noteText = adminNote ? `\nКомментарий администрации: ${adminNote}` : '';
          await notifyTelegram(idea.authorTelegramId, `Обновление по инициативе «${idea.title}»: ${status}.${noteText}`);
        }
        return json(response, 200, publicInitiative(idea, account));
      }
      if (adminIdeaMatch && request.method === 'DELETE') {
        if (!initiatives.has(adminIdeaMatch[1])) return json(response, 404, { error: 'Инициатива не найдена.' });
        initiatives.delete(adminIdeaMatch[1]);
        await persist();
        return json(response, 200, { ok: true });
      }
      if (request.method === 'POST' && url.pathname === '/api/admin/initiatives/clear') {
        const body = await readBody(request);
        if (body.confirm !== 'УДАЛИТЬ') return json(response, 400, { error: 'Чтобы удалить все инициативы, напиши УДАЛИТЬ.' });
        const deleted = initiatives.size;
        initiatives.clear();
        await persist();
        return json(response, 200, { ok: true, deleted });
      }
      if (request.method === 'POST' && url.pathname === '/api/admin/problems/clear') {
        const body = await readBody(request);
        if (body.confirm !== 'УДАЛИТЬ') return json(response, 400, { error: 'Чтобы удалить все проблемы, напиши УДАЛИТЬ.' });
        const deleted = problems.size;
        problems.clear();
        await persist();
        return json(response, 200, { ok: true, deleted });
      }
      const adminProblemMatch = url.pathname.match(/^\/api\/admin\/problems\/([a-f0-9]+)$/);
      if (adminProblemMatch && request.method === 'DELETE') {
        if (!problems.has(adminProblemMatch[1])) return json(response, 404, { error: 'Проблема не найдена.' });
        problems.delete(adminProblemMatch[1]);
        await persist();
        return json(response, 200, { ok: true });
      }
      if (request.method === 'POST' && url.pathname === '/api/admin/posts') {
        const body = await readBody(request, 2_000_000);
        const image = normalizeImage(body.image);
        if (image === false) return json(response, 400, { error: 'Фото должно быть JPG, PNG или WebP до 1 МБ.' });
        const type = body.type;
        const title = String(body.title ?? '').trim();
        const description = String(body.description ?? '').trim();
        const category = String(body.category ?? '').trim().slice(0, 40);
        if (!['news', 'event'].includes(type) || title.length < 3 || title.length > 100 || description.length < 5 || description.length > 2000) return json(response, 400, { error: 'Проверь категорию, заголовок и текст публикации.' });
        const scheduledAt = body.scheduledAt ? Date.parse(body.scheduledAt) : null;
        const location = type === 'event' ? String(body.location ?? '').trim().slice(0, 120) : '';
        if (scheduledAt !== null && !Number.isFinite(scheduledAt)) return json(response, 400, { error: 'Некорректная дата публикации.' });
        if (type === 'event' && (!Number.isFinite(scheduledAt) || !location)) return json(response, 400, { error: 'Для мероприятия укажи дату, время и место.' });
        const post = { id: randomBytes(8).toString('hex'), type, title, description, category: category || (type === 'event' ? 'Мероприятие' : 'Новости школы'), author: `${account.firstName} ${account.lastName}`, createdAt: Date.now(), scheduledAt, location, attendees: [], image: image ?? null };
        posts.set(post.id, post);
        await persist();
        return json(response, 201, publicPost(post, account));
      }
      const adminPostMatch = url.pathname.match(/^\/api\/admin\/posts\/([a-f0-9]+)$/);
      if (adminPostMatch && request.method === 'PUT') {
        const post = posts.get(adminPostMatch[1]);
        if (!post) return json(response, 404, { error: 'Публикация не найдена.' });
        const body = await readBody(request, 2_000_000);
        const image = normalizeImage(body.image);
        if (image === false) return json(response, 400, { error: 'Фото должно быть JPG, PNG или WebP до 1 МБ.' });
        const title = String(body.title ?? '').trim();
        const description = String(body.description ?? '').trim();
        const category = String(body.category ?? '').trim().slice(0, 40);
        const scheduledAt = body.scheduledAt ? Date.parse(body.scheduledAt) : null;
        const location = post.type === 'event' ? String(body.location ?? '').trim().slice(0, 120) : '';
        if (scheduledAt !== null && !Number.isFinite(scheduledAt)) return json(response, 400, { error: 'Некорректная дата публикации.' });
        if (title.length < 3 || title.length > 100 || description.length < 5 || description.length > 2000 || (post.type === 'event' && (!Number.isFinite(scheduledAt) || !location))) return json(response, 400, { error: 'Проверь заголовок, текст и данные мероприятия.' });
        Object.assign(post, { title, description, category: category || post.category, scheduledAt, location, updatedAt: Date.now() });
        if (image !== undefined) post.image = image;
        await persist();
        return json(response, 200, publicPost(post, account));
      }
      if (adminPostMatch && request.method === 'DELETE') {
        if (!posts.has(adminPostMatch[1])) return json(response, 404, { error: 'Публикация не найдена.' });
        posts.delete(adminPostMatch[1]);
        await persist();
        return json(response, 200, { ok: true });
      }
      if (request.method === 'POST' && url.pathname === '/api/admin/classes') {
        const body = await readBody(request);
        const className = String(body.className ?? '').trim();
        if (!isValidClassName(className)) return json(response, 400, { error: 'Название класса: 1–30 букв, цифр, пробелов, дефиса или подчёркивания.' });
        if (classes.has(className)) return json(response, 409, { error: 'Такой класс уже есть.' });
        classes.add(className);
        await persist();
        return json(response, 201, { classes: [...classes].sort((a, b) => a.localeCompare(b, 'ru')) });
      }
      if (request.method === 'DELETE' && url.pathname === '/api/admin/classes') {
        const body = await readBody(request);
        const className = String(body.className ?? '').trim();
        if ([...accounts.values()].some(account => account.schoolClass === className)) return json(response, 409, { error: 'Класс используется аккаунтами учеников, удалить его нельзя.' });
        classes.delete(className);
        await persist();
        return json(response, 200, { classes: [...classes].sort((a, b) => a.localeCompare(b, 'ru')) });
      }
    }

    return json(response, 404, { error: 'Not found' });
  } catch (error) {
    console.error('Request failed:', error.message);
    if (error.message === 'Request body too large') return json(response, 413, { error: 'Слишком большой файл или текст.' });
    return json(response, error instanceof SyntaxError ? 400 : 500, { error: error instanceof SyntaxError ? 'Некорректный JSON.' : 'Внутренняя ошибка сервера.' });
  }
});

server.listen(port, () => console.log(`SodiqSchool server listening on port ${port}`));

if (process.env.TELEGRAM_BOT_TOKEN) import('./bot.js').catch(error => console.error('Bot failed to start:', error));
else console.log('Telegram bot is disabled until TELEGRAM_BOT_TOKEN is added to .env.');
