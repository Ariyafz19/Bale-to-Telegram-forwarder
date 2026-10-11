// Bale public-channel -> Telegram forwarder (Cloudflare Worker, free plan)
// Reads public preview pages: https://ble.ir/s/<username>  (no admin access needed)
// Poll gated by configurable interval (5-10 min) so free quota is never hit.
// Sends to a Telegram group AND/OR to registered private chats (numeric ids).
// Telegram commands: /panel /lastmessages N /status /help + morning reminders.

// ---------- KV keys ----------
// cfg = { poll_minutes, channels:[{username,label,target}], morning:{enabled,days,message},
//         pm_users:[{id,name}], pm_forward }
// seen:<username> = [hash,...] (cap 60)
// last_check = ms timestamp
// morning_sent:<YYYY-MM-DD Tehran> = "1"
// wh_secret = Telegram webhook secret token (created by /setup-tg)

const SEEN_CAP = 60;
const DEFAULT_MORNING_DAYS = [6, 1, 3, 4]; // شنبه، دوشنبه، چهارشنبه، پنجشنبه (Tehran weekday, JS day numbers)
const DEFAULT_MORNING_MESSAGE = "☀️ صبح بخیر!\nیادآوری: امروز {weekday} دانشگاه داری 🎓\nموفق باشی!";
const FA_WEEKDAYS = ["یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه", "شنبه"];
const MAX_NEW_PER_RUN = 12; // safety cap per channel per run
const DEFAULT_CHANNEL = "YOUR_BALE_CHANNEL"; // آیدی عمومی کانال در بله (بدون @)
const DEFAULT_LABEL = "برچسب کانال";
const PROTECTED = ["/run", "/poll", "/diag", "/setup-tg", "/send", "/del", "/test-tg", "/morning-test"];

// ---------- helpers ----------
function envValue(env, key) {
  return env[key] ?? "";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// مقایسهٔ امن رشته‌ها (بدون نشت زمانی) برای کلید ادمین و secret وب‌هوک
function safeEqual(a, b) {
  const x = String(a ?? ""), y = String(b ?? "");
  if (x.length === 0 || x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(+n); } catch { return ""; } })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ""; } })
    .replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
}

// تقسیم متن بلند به قطعه‌های زیر ۴۰۰۰ کاراکتر (سقف تلگرام ۴۰۹۶ است)
function splitText(text, limit = 4000) {
  const src = String(text ?? "");
  if (src.length <= limit) return [src];
  const out = [];
  let cur = "";
  for (const line of src.split("\n")) {
    let piece = line;
    while (piece.length > limit) {
      if (cur) { out.push(cur); cur = ""; }
      out.push(piece.slice(0, limit));
      piece = piece.slice(limit);
    }
    if (!cur) cur = piece;
    else if (cur.length + 1 + piece.length <= limit) cur += "\n" + piece;
    else { out.push(cur); cur = piece; }
  }
  if (cur) out.push(cur);
  return out.length ? out : [src.slice(0, limit)];
}

// ---------- گیرندگان پیوی ----------
function addPmUser(cfg, id, name) {
  cfg.pm_users = Array.isArray(cfg.pm_users) ? cfg.pm_users : [];
  const sid = String(id).trim();
  const found = cfg.pm_users.find((u) => String(u.id) === sid);
  if (found) { if (name && !found.name) found.name = name; return false; }
  cfg.pm_users.push({ id: sid, name: name || "" });
  return true;
}

function removePmUser(cfg, id) {
  const sid = String(id).trim();
  const before = (cfg.pm_users || []).length;
  cfg.pm_users = (cfg.pm_users || []).filter((u) => String(u.id) !== sid);
  return cfg.pm_users.length !== before;
}

// ---------- config ----------
async function getCfg(env) {
  const def = {
    poll_minutes: 7,
    channels: [{
      username: envValue(env, "BALE_CHANNEL") || DEFAULT_CHANNEL,
      label: envValue(env, "BALE_LABEL") || DEFAULT_LABEL,
      target: "",
    }],
    morning: { enabled: true, days: DEFAULT_MORNING_DAYS, message: "" },
    pm_users: [],
    pm_forward: true,
  };
  try {
    const raw = await env.OFFSET_KV?.get("cfg");
    if (!raw) return def;
    const c = JSON.parse(raw);
    if (!Array.isArray(c.channels) || !c.channels.length) c.channels = def.channels;
    if (!c.poll_minutes || c.poll_minutes < 5 || c.poll_minutes > 10) c.poll_minutes = 7;
    if (!c.morning || typeof c.morning !== "object") c.morning = { enabled: true };
    if (typeof c.morning.enabled !== "boolean") c.morning.enabled = true;
    if (!Array.isArray(c.morning.days) || !c.morning.days.length) c.morning.days = DEFAULT_MORNING_DAYS;
    if (typeof c.morning.message !== "string") c.morning.message = "";
    if (!Array.isArray(c.pm_users)) c.pm_users = [];
    c.pm_users = c.pm_users.filter((u) => u && u.id != null && String(u.id).trim() !== "");
    if (typeof c.pm_forward !== "boolean") c.pm_forward = true;
    return c;
  } catch { return def; }
}

async function setCfg(env, cfg) {
  try { await env.OFFSET_KV?.put("cfg", JSON.stringify(cfg)); } catch {}
}

async function getSeen(env, username) {
  try {
    const raw = await env.OFFSET_KV?.get("seen:" + username);
    const a = raw ? JSON.parse(raw) : [];
    return Array.isArray(a) ? a : [];
  } catch { return []; }
}

async function setSeen(env, username, arr) {
  try { await env.OFFSET_KV?.put("seen:" + username, JSON.stringify(arr.slice(-SEEN_CAP))); } catch {}
}

// ---------- Telegram API ----------
async function telegramSend(env, method, payload, isFormData) {
  const token = envValue(env, "TELEGRAM_BOT_TOKEN");
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const headers = {};
  let body;
  if (isFormData) { body = payload; }
  else { headers["content-type"] = "application/json"; body = JSON.stringify(payload); }
  const r = await fetch(url, { method: "POST", headers, body });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`Telegram ${method} error: ${JSON.stringify(j).slice(0, 500)}`);
  return j;
}

async function tgSendText(env, chatId, text, replyMarkup) {
  const chunks = splitText(text, 4000);
  let last = null;
  for (let i = 0; i < chunks.length; i++) {
    const p = { chat_id: chatId, text: chunks[i] };
    if (replyMarkup && i === chunks.length - 1) p.reply_markup = replyMarkup;
    last = await telegramSend(env, "sendMessage", p);
    if (i < chunks.length - 1) await sleep(300);
  }
  return last;
}

async function isAdmin(env, chatId, userId) {
  try {
    const r = await telegramSend(env, "getChatMember", { chat_id: chatId, user_id: userId });
    const st = r.result?.status;
    return st === "creator" || st === "administrator";
  } catch { return false; }
}

// مدیریت: ادمین همان چت، یا ادمین گروه اصلی (برای پنل در چت خصوصی)
async function canManage(env, chatId, userId) {
  if (await isAdmin(env, chatId, userId)) return true;
  const main = envValue(env, "TELEGRAM_CHAT_ID");
  if (main && String(main) !== String(chatId)) return await isAdmin(env, main, userId);
  return false;
}

// ---------- کلید دسترسی endpoint ها ----------
function requireKey(request, url, env) {
  const key = String(envValue(env, "ADMIN_KEY") || "").trim();
  const given = String(url.searchParams.get("key") || request.headers.get("x-admin-key") || "").trim();
  if (!key) {
    return { ok: false, error: "ADMIN_KEY تنظیم نشده است: npx wrangler secret put ADMIN_KEY" };
  }
  if (!given || !safeEqual(given, key)) {
    return { ok: false, error: "کلید دسترسی نادرست یا جا افتاده — آدرس را با ?key=<ADMIN_KEY> باز کنید." };
  }
  return { ok: true };
}

// ---------- Bale public page scraper ----------
async function fetchChannelPage(username) {
  const r = await fetch(`https://ble.ir/s/${encodeURIComponent(username)}`, {
    headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36", "accept-language": "fa,en;q=0.8" },
  });
  if (!r.ok) throw new Error(`ble.ir/s/${username} -> HTTP ${r.status}`);
  const html = await r.text();
  if (!html.includes("MessageItem_messageWrapper")) throw new Error(`کانال ${username} یافت نشد یا صفحه پیام ندارد`);
  return html;
}

function blockToContent(block) {
  let b = String(block);
  // حذف script ها قبل از هر چیز (بقایای Next.js مثل $RB, self.__next_f)
  b = b.replace(/<script[\s\S]*?<\/script>/gi, " ");
  // emoji imgs -> real unicode chars
  b = b.replace(/<img[^>]*data-codepoints="([^"]+)"[^>]*>/g, (_, cps) => {
    try { return cps.split("-").map((x) => String.fromCodePoint(parseInt(x, 16))).join(""); }
    catch { return ""; }
  });
  // حذف بقیه‌ی تگ script ناقص تا انتهای بلاک
  b = b.replace(/\$RB=.*?self\.__next_f[\s\S]*/g, " ");
  b = b.replace(/self\.__next_f[\s\S]*/g, " ");
  // بریدن آمار بازدید/تگ‌های متادیتا دنبال متن (Info_info, Info_meta, Info_ViewWrapper, Info_stats, data-sid) — نه Info_date (ساعت)
  b = b.replace(/<div[^>]*(?:Info_info|Info_meta|Info_ViewWrapper|Info_stats|data-sid)[\s\S]*$/i, " ");
  const imgs = [...b.matchAll(/<img[^>]*src="(https?:[^"]+)"[^>]*>/g)].map((m) => m[1]);
  // فقط http/https واقعی، نه data: و نه svg لوگو
  const realImgs = [...new Set(imgs.filter((u) => /^https?:\/\//.test(u) && !u.includes("bale_logo")))];
  const links = [...b.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
    .map((m) => ({ href: m[1], text: m[2].replace(/<[^>]+>/g, "").trim() }))
    .filter((l) => l.href && !l.href.startsWith("#") && /^https?:\/\//.test(l.href) && !/^https?:\/\/ble\.ir\/?$/i.test(l.href));
  let t = b.replace(/<br\s*\/?>/gi, "\n");
  // تگ باز و بستهٔ بلاک = خط جدید (جلوگیری از چسبیدن جملات)
  t = t.replace(/<(div|p|li|h[1-6]|tr)(\s[^>]*)?>/gi, "\n");
  t = t.replace(/<\/(div|p|li|h[1-6]|tr)>/gi, "\n");
  t = t.replace(/<[^>]+>/g, "");
  t = decodeEntities(t);
  // حذف بقایای JS که بعد از حذف تگ‌ مانده
  t = t.replace(/\$[A-Z]{1,3}=.*$/gm, " ").replace(/performance\.now\(\)[\s\S]*/g, " ");
  t = t.split("\n").map((l) => l.replace(/[ \t\u200c\u200f\u202a-\u202e]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  // اگر هنوز شامل chunk path یا react fragment بود، حذف
  t = t.replace(/static\/chunks\/[^\s]*/g, " ").replace(/\$Sreact[\s\S]*/g, " ").trim();
  return { text: t, imgs: realImgs, links };
}

function parseChannelPage(html) {
  const dividers = [...html.matchAll(/DateDivider_Date__[^>]*>([^<]+)</g)].map((m) => ({ idx: m.index, date: m[1].trim() }));
  const idxs = [...html.matchAll(/MessageItem_messageWrapper/g)].map((m) => m.index);
  const msgs = [];
  let di = 0, curDate = "";
  for (let i = 0; i < idxs.length; i++) {
    const idx = idxs[i];
    while (di < dividers.length && dividers[di].idx < idx) { curDate = dividers[di].date; di++; }
    const end = i + 1 < idxs.length ? idxs[i + 1] : Math.min(html.length, idx + 12000);
    let slice = html.slice(idx, end);
    // متن از درون attribute کلاس شروع شده؛ از اولین '>' بعد از idx شروع کن
    const gt = slice.indexOf(">");
    if (gt >= 0) slice = slice.slice(gt + 1);
    const tm = slice.match(/Info_date__[^>]*>([^<]+)</);
    const c = blockToContent(slice);
    if (!c.text && !c.imgs.length) continue;
    const h = hashStr(`${curDate}|${tm ? tm[1] : ""}|${c.text}`);
    msgs.push({ date: curDate, time: tm ? tm[1].trim() : "", text: c.text, imgs: c.imgs, links: c.links, hash: h });
  }
  return msgs; // chronological: oldest -> newest
}

function formatMsg(label, username, m) {
  let t = `📨 ${label} | ${m.date ? m.date + " " : ""}${m.time ? "ساعت " + m.time : ""}\n\n${m.text}`;
  for (const l of m.links || []) {
    if (l.href && !t.includes(l.href)) t += `\n🔗 ${l.href}`;
  }
  if (!t.includes("ble.ir/")) t += `\n\nble.ir/${username}`;
  return t;
}

async function sendChannelMsg(env, chatId, label, username, m) {
  await tgSendText(env, chatId, formatMsg(label, username, m));
  for (const img of (m.imgs || []).slice(0, 2)) {
    try { await telegramSend(env, "sendPhoto", { chat_id: chatId, photo: img }); }
    catch (e) { console.warn("photo send failed", e && e.message); }
  }
}

function isJunk(m) {
  if (!m.text && !(m.imgs || []).length) return true;
  if (m.text && m.text.length < 5 && !(m.imgs || []).length) return true;
  if (/MessageItem_|ChatWrapper|BaseBubble_|__[A-Za-z0-9]{4,}/.test(m.text || "")) return true; // بقایای کلاس‌های HTML
  return false;
}

async function sendBatchText(env, chatId, texts) {
  const SEP = "\n\n----\n\n";
  let cur = "";
  for (const t of texts) {
    const piece = t.slice(0, 4000);
    if (!cur) { cur = piece; continue; }
    if (cur.length + SEP.length + piece.length <= 4000) { cur += SEP + piece; continue; }
    await tgSendText(env, chatId, cur);
    await sleep(400);
    cur = piece;
  }
  if (cur) await tgSendText(env, chatId, cur);
}

async function sendMessagesBatched(env, chatId, label, username, msgs) {
  // متن‌های بدون عکس با ---- در یک پیام ترکیب می‌شوند؛ پیام‌های عکس‌دار تکی ارسال می‌شوند
  let buf = [];
  const flush = async () => { if (buf.length) { await sendBatchText(env, chatId, buf); buf = []; } };
  for (const m of msgs) {
    if (m.imgs && m.imgs.length) {
      await flush();
      await sendChannelMsg(env, chatId, label, username, m);
      await sleep(400);
    } else buf.push(formatMsg(label, username, m));
  }
  await flush();
}

// مقاصد ارسال: گروه + همهٔ کاربران ثبت‌شدهٔ پیوی (اگر pm_forward روشن باشد)
function resolveTargets(env, cfg, ch) {
  const out = [];
  const g = (ch && ch.target) || envValue(env, "TELEGRAM_CHAT_ID");
  if (g) out.push({ chat: String(g), kind: "group" });
  if (cfg.pm_forward !== false) {
    for (const u of cfg.pm_users || []) out.push({ chat: String(u.id), kind: "pm" });
  }
  return out;
}

async function sendToTargets(env, targets, label, username, msgs) {
  const sent = [], failed = [];
  for (const t of targets) {
    try {
      await sendMessagesBatched(env, t.chat, label, username, msgs);
      sent.push(t.kind + ":" + t.chat);
    } catch (e) {
      failed.push({ to: t.chat, kind: t.kind, error: String((e && e.message) || e).slice(0, 160) });
      await sleep(500);
    }
  }
  return { sent, failed };
}

// ---------- poll job ----------
async function pollJob(env, force) {
  const cfg = await getCfg(env);
  const now = Date.now();
  if (!force) {
    let last = 0;
    try { last = parseInt((await env.OFFSET_KV?.get("last_check")) || "0", 10) || 0; } catch {}
    if (last && now - last < cfg.poll_minutes * 60_000) {
      return { skipped: true, reason: "interval", next_in_sec: Math.round((cfg.poll_minutes * 60_000 - (now - last)) / 1000) };
    }
  }
  try { await env.OFFSET_KV?.put("last_check", String(now)); } catch {}
  const out = { channels: [] };
  for (const ch of cfg.channels) {
    const targets = resolveTargets(env, cfg, ch);
    const res = { username: ch.username, targets: targets.length };
    if (!ch.username) {
      res.error = "کانالی تنظیم نشده — BALE_CHANNEL را ست کنید یا با /addchannel اضافه کنید.";
      out.channels.push(res);
      continue;
    }
    try {
      const html = await fetchChannelPage(ch.username);
      const msgs = parseChannelPage(html);
      res.found = msgs.length;
      let seen = await getSeen(env, ch.username);
      if (!seen.length) {
        // first run: seed silently, no flood. Use /lastmessages to view history.
        await setSeen(env, ch.username, msgs.map((m) => m.hash));
        res.seeded = msgs.length;
        res.forwarded = 0;
      } else {
        const fresh = msgs.filter((m) => !seen.includes(m.hash)).slice(-MAX_NEW_PER_RUN);
        const toSend = fresh.filter((m) => !isJunk(m));
        for (const m of fresh) seen.push(m.hash);
        await setSeen(env, ch.username, seen);
        res.forwarded = 0;
        res.junk_skipped = fresh.length - toSend.length;
        if (toSend.length) {
          const r = await sendToTargets(env, targets, ch.label || ch.username, ch.username, toSend);
          res.forwarded = toSend.length;
          res.sent_to = r.sent;
          if (r.failed.length) res.failed = r.failed;
        }
      }
    } catch (e) {
      res.error = String(e && e.message || e).slice(0, 200);
    }
    out.channels.push(res);
  }
  return { ok: true, ...out };
}

// ---------- morning reminder ----------
function tehranNow() {
  return new Date(Date.now() + 3.5 * 3600_000);
}
function tehranDateStr() {
  const d = tehranNow();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function morningText(cfg, wd) {
  const tpl = (cfg.morning && cfg.morning.message) || DEFAULT_MORNING_MESSAGE;
  return String(tpl).replace(/\{weekday\}/g, FA_WEEKDAYS[wd]);
}

async function morningJob(env) {
  const cfg = await getCfg(env);
  if (!cfg.morning?.enabled) return { sent: false, reason: "disabled" };
  const d = tehranNow();
  const wd = d.getUTCDay();
  const days = cfg.morning.days || DEFAULT_MORNING_DAYS;
  if (!days.includes(wd)) return { sent: false, reason: "not-scheduled-day", weekday: FA_WEEKDAYS[wd] };
  const key = "morning_sent:" + tehranDateStr();
  try { if (await env.OFFSET_KV?.get(key)) return { sent: false, reason: "already-sent" }; } catch {}
  const targets = resolveTargets(env, cfg, { target: envValue(env, "TELEGRAM_CHAT_ID") });
  const text = morningText(cfg, wd);
  const done = [];
  for (const t of targets) {
    try { await tgSendText(env, t.chat, text); done.push(t.kind + ":" + t.chat); }
    catch (e) { console.warn("morning send failed", t.chat, e && e.message); }
    await sleep(300);
  }
  if (done.length) { try { await env.OFFSET_KV?.put(key, "1", { expirationTtl: 86400 * 2 }); } catch {} }
  return { sent: done.length > 0, weekday: FA_WEEKDAYS[wd], to: done };
}

// ---------- panel ----------
function panelText(cfg) {
  const chs = cfg.channels.map((c, i) => `${i + 1}. ${c.label || c.username} (ble.ir/s/${c.username || "—"})`).join("\n") || "—";
  const list = cfg.pm_users || [];
  const rows = list.length
    ? list.map((u) => `   • ${u.id}${u.name ? " — " + u.name : ""}`).join("\n")
    : "   (ثبت: کاربر در خصوصی ‎/start‎ بزند یا ادمین ‎/addpm <id>‎)";
  return `⚙️ پنل مدیریت فورواردر

⏱ فاصله بررسی: هر ${cfg.poll_minutes} دقیقه
📢 کانال‌ها:
${chs}

👥 گیرندگان پیوی: ${list.length} نفر ${cfg.pm_forward !== false ? "(ارسال روشن ✅)" : "(ارسال خاموش ❌)"}
${rows}

☀️ یادآور صبح: ${cfg.morning?.enabled ? "روشن ✅" : "خاموش ❌"}

مصرف تقریبی پلن رایگان: روزانه ~۱۵۰۰ درخواست از ۱۰۰٬۰۰۰ ✅`;
}

function panelKeyboard(cfg) {
  const pmN = (cfg.pm_users || []).length;
  return {
    inline_keyboard: [
      [5, 7, 10].map((v) => ({ text: `${v} دقیقه${cfg.poll_minutes === v ? " ✅" : ""}`, callback_data: `int:${v}` })),
      [{ text: "📩 ۵ پیام اخیر", callback_data: "last:5" }, { text: "📊 وضعیت", callback_data: "status" }],
      [{ text: "🔄 بررسی فوری", callback_data: "poll" }],
      [{ text: cfg.morning?.enabled ? "☀️ یادآور: خاموش کن" : "☀️ یادآور: روشن کن", callback_data: "morning:toggle" }],
      [{ text: `👥 پیوی: ${cfg.pm_forward !== false ? "روشن ✅" : "خاموش ❌"} (${pmN})`, callback_data: "pm:toggle" }],
      ...(pmN ? [[{ text: "👥 مدیریت گیرندگان پیوی", callback_data: "users" }]] : []),
      ...(cfg.channels.length > 1 ? cfg.channels.map((c) => [{ text: `🗑 حذف ${c.username}`, callback_data: "del:" + c.username }]) : []),
    ],
  };
}

function usersText(cfg) {
  const list = cfg.pm_users || [];
  if (!list.length) {
    return "👥 هنوز کاربری برای دریافت پیوی ثبت نشده.\n\nثبت‌نام: کاربر در چت خصوصی به ربات ‎/start‎ بزند،\nیا ادمین با ‎/addpm 123456789‎ اضافه کند.";
  }
  const rows = list.map((u, i) => `${i + 1}. \`${u.id}\`${u.name ? " — " + u.name : ""}`).join("\n");
  return `👥 گیرندگان پیوی (${list.length} نفر):\n\n${rows}\n\nحذف: ‎/delpm <id>‎ یا دکمه زیر.\nروشن/خاموش کلیِ ارسال پیوی از پنل.`;
}

function usersKeyboard(cfg) {
  const list = (cfg.pm_users || []).slice(0, 20);
  if (!list.length) return undefined;
  return { inline_keyboard: list.map((u) => [{ text: `🗑 حذف ${u.name || u.id}`, callback_data: `pmdel:${u.id}` }]) };
}

// ---------- commands ----------
async function handleCommand(env, chatId, userId, text, meta) {
  meta = meta || {};
  const isPrivate = !!meta.isPrivate;
  const m = text.trim().match(/^\/(\w+)(?:@\S+)?\s*([\s\S]*)$/);
  if (!m) return;
  const cmd = m[1].toLowerCase();
  const arg = (m[2] || "").trim();
  const cfg = await getCfg(env);

  // ---- چت خصوصی: عضویت / لغو عضویت ----
  if (isPrivate && (cmd === "start" || cmd === "subscribe")) {
    const added = addPmUser(cfg, chatId, meta.fromName || "");
    await setCfg(env, cfg);
    const manage = await canManage(env, chatId, userId);
    const head = added
      ? "✅ ثبت شدی؛ از این به بعد پیام‌های جدید کانال‌ها برایت اینجا هم ارسال می‌شود.\nبرای توقف: ‎/unsubscribe‎"
      : "✅ قبلاً ثبت بودی و پیام‌ها را دریافت می‌کنی.\nبرای توقف: ‎/unsubscribe‎";
    await tgSendText(env, chatId, head + "\n\n" + (manage ? panelText(cfg) : "دستورات: ‎/status‎ · ‎/lastmessages 5‎ · ‎/help‎"),
      manage ? panelKeyboard(cfg) : undefined);
    return;
  }

  if (isPrivate && (cmd === "unsubscribe" || cmd === "stop")) {
    const removed = removePmUser(cfg, chatId);
    await setCfg(env, cfg);
    await tgSendText(env, chatId, removed
      ? "🛑 عضویتت لغو شد؛ دیگر پیامی به این چت ارسال نمی‌شود.\nبرای شروع دوباره: ‎/start‎"
      : "از قبل عضو نبودی.");
    return;
  }

  if (cmd === "panel" || cmd === "start") {
    if (!(await canManage(env, chatId, userId))) { await tgSendText(env, chatId, "⛔ فقط ادمین‌های گروه می‌توانند پنل را ببینند."); return; }
    await tgSendText(env, chatId, panelText(cfg), panelKeyboard(cfg));
    return;
  }

  if (cmd === "help" || cmd === "راهنما") {
    await tgSendText(env, chatId,
      `📖 راهنما

عضویت پیوی (هر کسی):
/start — دریافت پیام‌های کانال در چت خصوصی
/unsubscribe — لغو دریافت

مشاهده:
/lastmessages N [کانال] — ارسال N پیام اخیر (مثلاً /lastmessages 4)
/status — وضعیت ربات
/panel — پنل مدیریت (ادمین)

➕ افزودن کانال (ادمین):
/addchannel username [نام]
مثال: /addchannel mychannel نام کانال
/delchannel username — حذف کانال

👥 گیرندگان پیوی (ادمین):
/addpm <id عددی> [نام] — افزودن با آیدی عددی
/delpm <id> — حذف
/users — فهرست گیرندگان

☀️ یادآور صبح از پنل روشن/خاموش می‌شود.`);
    return;
  }

  if (cmd === "status" || cmd === "وضعیت") {
    let last = 0;
    try { last = parseInt((await env.OFFSET_KV?.get("last_check")) || "0", 10) || 0; } catch {}
    const ago = last ? Math.round((Date.now() - last) / 60000) + " دقیقه پیش" : "هنوز انجام نشده";
    await tgSendText(env, chatId,
      `📊 وضعیت

⏱ فاصله بررسی: هر ${cfg.poll_minutes} دقیقه
🔍 آخرین بررسی: ${ago}
📢 کانال‌ها: ${cfg.channels.map((c) => c.username).join("، ")}
👥 پیوی: ${(cfg.pm_users || []).length} نفر ${cfg.pm_forward !== false ? "(روشن)" : "(خاموش)"}
☀️ یادآور صبح: ${cfg.morning?.enabled ? "روشن" : "خاموش"}
مقصد گروه: ${envValue(env, "TELEGRAM_CHAT_ID") || "—"}`);
    return;
  }

  if (cmd === "lastmessages") {
    const parts = arg.split(/\s+/).filter(Boolean);
    let n = parseInt(parts[0], 10);
    if (!n || n < 1) n = 5;
    n = Math.min(n, 10);
    const chName = (parts[1] || "").toLowerCase();
    const ch = (chName && cfg.channels.find((c) => (c.username || "").toLowerCase() === chName)) || cfg.channels[0];
    if (!ch || !ch.username) { await tgSendText(env, chatId, "کانالی تنظیم نشده است."); return; }
    try {
      const html = await fetchChannelPage(ch.username);
      const msgs = parseChannelPage(html).slice(-n).filter((m) => !isJunk(m));
      if (!msgs.length) { await tgSendText(env, chatId, "پیامی در کانال پیدا نشد."); return; }
      await tgSendText(env, chatId, `📩 ${msgs.length} پیام اخیر «${ch.label || ch.username}» (با ---- از هم جدا شده‌اند):`);
      await sendMessagesBatched(env, chatId, ch.label || ch.username, ch.username, msgs);
    } catch (e) { await tgSendText(env, chatId, "❌ خطا: " + String(e.message || e).slice(0, 200)); }
    return;
  }

  if (cmd === "users") {
    if (!(await canManage(env, chatId, userId))) { await tgSendText(env, chatId, "⛔ فقط ادمین‌ها."); return; }
    await tgSendText(env, chatId, usersText(cfg), usersKeyboard(cfg));
    return;
  }

  if (cmd === "addpm") {
    if (!(await canManage(env, chatId, userId))) { await tgSendText(env, chatId, "⛔ فقط ادمین‌ها."); return; }
    const parts = arg.split(/\s+/).filter(Boolean);
    const id = (parts[0] || "").replace(/^@/, "");
    if (!/^\d{5,20}$/.test(id)) {
      await tgSendText(env, chatId, "مثال: ‎/addpm 123456789 نام‎\nآیدی باید عددی باشد (آیدی عددی را از @userinfobot بگیرید).");
      return;
    }
    const added = addPmUser(cfg, id, parts.slice(1).join(" "));
    await setCfg(env, cfg);
    await tgSendText(env, chatId, added
      ? `✅ ${id} به گیرندگان پیوی اضافه شد (${(cfg.pm_users || []).length} نفر).\nبرای فهرست: /users`
      : "این آیدی قبلاً ثبت شده بود.");
    return;
  }

  if (cmd === "delpm") {
    if (!(await canManage(env, chatId, userId))) { await tgSendText(env, chatId, "⛔ فقط ادمین‌ها."); return; }
    const id = (arg.split(/\s+/)[0] || "").replace(/^@/, "");
    if (!id) { await tgSendText(env, chatId, "مثال: ‎/delpm 123456789‎"); return; }
    const removed = removePmUser(cfg, id);
    await setCfg(env, cfg);
    await tgSendText(env, chatId, removed ? `🗑 ${id} حذف شد.` : "این آیدی در فهرست نیست.");
    return;
  }

  if (cmd === "addchannel") {
    if (!(await canManage(env, chatId, userId))) { await tgSendText(env, chatId, "⛔ فقط ادمین‌ها می‌توانند کانال اضافه کنند."); return; }
    const parts = arg.split(/\s+/).filter(Boolean);
    const u = (parts[0] || "").replace(/^@/, "").replace(/^https?:\/\/ble\.ir\/s\//, "").replace(/\/$/, "");
    if (!u) { await tgSendText(env, chatId, "مثال: /addchannel username نام کانال"); return; }
    if (cfg.channels.some((c) => c.username.toLowerCase() === u.toLowerCase())) { await tgSendText(env, chatId, "این کانال قبلاً اضافه شده است."); return; }
    try {
      const html = await fetchChannelPage(u);
      const msgs = parseChannelPage(html);
      cfg.channels.push({ username: u, label: parts.slice(1).join(" ") || u, target: "" });
      await setCfg(env, cfg);
      await setSeen(env, u, msgs.map((m) => m.hash)); // seed: no flood
      await tgSendText(env, chatId, `✅ کانال «${u}» اضافه شد. از این به بعد پیام‌های جدیدش هر ${cfg.poll_minutes} دقیقه برای ${resolveTargets(env, cfg, {}).length} مقصد ارسال می‌شود.\n(برای دیدن پیام‌های قبلی: /lastmessages 5)`);
    } catch (e) { await tgSendText(env, chatId, "❌ کانال یافت نشد: " + String(e.message || e).slice(0, 200)); }
    return;
  }

  if (cmd === "delchannel") {
    if (!(await canManage(env, chatId, userId))) { await tgSendText(env, chatId, "⛔ فقط ادمین‌ها."); return; }
    const u = arg.replace(/^@/, "").toLowerCase();
    const i = cfg.channels.findIndex((c) => c.username.toLowerCase() === u);
    if (i < 0) { await tgSendText(env, chatId, "این کانال در لیست نیست."); return; }
    cfg.channels.splice(i, 1);
    if (!cfg.channels.length) { await tgSendText(env, chatId, "⛔ نمی‌شود همه کانال‌ها را حذف کرد؛ حداقل یکی باید بماند."); return; }
    await setCfg(env, cfg);
    await tgSendText(env, chatId, `🗑 کانال «${u}» حذف شد.`);
    return;
  }
}

// ---------- callbacks ----------
async function handleCallback(env, cb) {
  const chatId = cb.message?.chat?.id;
  const msgId = cb.message?.message_id;
  const userId = cb.from?.id;
  const data = cb.data || "";
  const token = envValue(env, "TELEGRAM_BOT_TOKEN");
  const answer = (text) => telegramSend(env, "answerCallbackQuery", { callback_query_id: cb.id, text }).catch(() => {});
  if (!chatId || !msgId) { await answer(""); return; }

  const mutate = data.startsWith("int:") || data.startsWith("del:") || data === "poll" ||
    data.startsWith("morning:") || data.startsWith("pm:") || data.startsWith("pmdel:");
  if (mutate && !(await canManage(env, chatId, userId))) { await answer("⛔ فقط ادمین‌ها"); return; }

  const cfg = await getCfg(env);

  if (data.startsWith("int:")) {
    const v = parseInt(data.slice(4), 10);
    if ([5, 7, 10].includes(v)) {
      cfg.poll_minutes = v;
      await setCfg(env, cfg);
      await answer(`فاصله بررسی: هر ${v} دقیقه`);
    }
  } else if (data.startsWith("last:")) {
    const n = Math.min(Math.max(parseInt(data.slice(5), 10) || 5, 1), 10);
    await answer("در حال ارسال...");
    const ch = cfg.channels[0];
    try {
      const html = await fetchChannelPage(ch.username);
      const msgs = parseChannelPage(html).slice(-n).filter((m) => !isJunk(m));
      await sendMessagesBatched(env, chatId, ch.label || ch.username, ch.username, msgs);
    } catch (e) { await tgSendText(env, chatId, "❌ خطا: " + String(e.message || e).slice(0, 200)); }
    return; // don't redraw panel
  } else if (data === "status") {
    await answer("");
    await handleCommand(env, chatId, userId, "/status", { isPrivate: false });
    return;
  } else if (data === "poll") {
    await answer("در حال بررسی...");
    const res = await pollJob(env, true);
    const fwd = (res.channels || []).map((c) => `${c.username}: ${c.error ? "❌" : (c.forwarded ?? 0) + " جدید"}`).join("\n");
    await tgSendText(env, chatId, `🔄 بررسی انجام شد:\n${fwd}`);
    return;
  } else if (data === "morning:toggle") {
    cfg.morning.enabled = !cfg.morning.enabled;
    await setCfg(env, cfg);
    await answer(cfg.morning.enabled ? "یادآور روشن شد" : "یادآور خاموش شد");
  } else if (data === "pm:toggle") {
    cfg.pm_forward = cfg.pm_forward === false;
    await setCfg(env, cfg);
    await answer(cfg.pm_forward ? "ارسال به پیوی روشن شد" : "ارسال به پیوی خاموش شد");
  } else if (data === "users") {
    await answer("");
    await tgSendText(env, chatId, usersText(cfg), usersKeyboard(cfg));
    return; // don't redraw panel
  } else if (data.startsWith("pmdel:")) {
    const id = data.slice(6);
    const removed = removePmUser(cfg, id);
    await setCfg(env, cfg);
    await answer(removed ? `${id} حذف شد` : "در فهرست نبود");
    await tgSendText(env, chatId, usersText(cfg), usersKeyboard(cfg));
    return;
  } else if (data.startsWith("del:")) {
    const u = data.slice(4).toLowerCase();
    const i = cfg.channels.findIndex((c) => c.username.toLowerCase() === u);
    if (i >= 0 && cfg.channels.length > 1) { cfg.channels.splice(i, 1); await setCfg(env, cfg); await answer("حذف شد"); }
    else { await answer("نمی‌شود حذف کرد"); return; }
  } else { await answer(""); return; }

  // redraw panel
  const fresh = await getCfg(env);
  await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: msgId, text: panelText(fresh), reply_markup: panelKeyboard(fresh) }),
  }).catch(() => {});
}

// ---------- webhook secret ----------
async function getWebhookSecret(env) {
  try {
    let s = await env.OFFSET_KV?.get("wh_secret");
    if (!s) { s = randomHex(24); await env.OFFSET_KV?.put("wh_secret", s); }
    return s;
  } catch { return randomHex(24); }
}

// ---------- export ----------
export { parseChannelPage, blockToContent, isJunk, formatMsg, hashStr, splitText, resolveTargets };

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        if (event.cron && event.cron.includes("30 3")) {
          console.log("[morning]", JSON.stringify(await morningJob(env)));
        } else {
          console.log("[cron]", JSON.stringify(await pollJob(env, false)));
        }
      } catch (e) { console.error("[cron] error", e && (e.stack || e.message)); }
    })());
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const mainChat = envValue(env, "TELEGRAM_CHAT_ID");

    // Telegram webhook receiver (با secret_token؛ با /setup-tg نصب می‌شود)
    if (url.pathname === "/tg-webhook" && request.method === "POST") {
      try {
        let stored = null;
        try { stored = await env.OFFSET_KV?.get("wh_secret"); } catch {}
        const got = request.headers.get("x-telegram-bot-api-secret-token") || "";
        if (stored && !safeEqual(got, stored)) return new Response("forbidden", { status: 403 });

        const upd = await request.json().catch(() => null);
        if (upd?.callback_query) {
          ctx.waitUntil(handleCallback(env, upd.callback_query).catch((e) => console.error("cb error", e)));
        } else if (upd?.message?.text) {
          const chatId = upd.message.chat.id;
          const isPrivate = upd.message.chat.type === "private";
          const cfg = await getCfg(env);
          const targets = new Set([String(mainChat), ...cfg.channels.map((c) => String(c.target || mainChat))]);
          const allowed = isPrivate || targets.has(String(chatId));
          const txt = upd.message.text.trim();
          if (allowed && txt.startsWith("/")) {
            const from = upd.message.from || {};
            const fromName = `${from.first_name || ""} ${from.last_name || ""}`.trim() || from.username || "";
            ctx.waitUntil(handleCommand(env, chatId, from.id, txt, { isPrivate, fromName }).catch((e) => console.error("cmd error", e)));
          }
        }
        return Response.json({ ok: true });
      } catch (e) { return Response.json({ ok: false, error: String(e) }, { status: 500 }); }
    }

    // محافظت endpoint های ادمین با ADMIN_KEY
    if (PROTECTED.includes(url.pathname)) {
      const auth = requireKey(request, url, env);
      if (!auth.ok) return Response.json({ ok: false, error: auth.error }, { status: 403 });
    }

    // One-time setup: point Telegram webhook here + install bot command menu
    if (url.pathname === "/setup-tg") {
      try {
        const base = new URL(request.url).origin;
        const secret = await getWebhookSecret(env);
        const wh = await telegramSend(env, "setWebhook", {
          url: base + "/tg-webhook",
          allowed_updates: ["message", "callback_query"],
          secret_token: secret,
          drop_pending_updates: false,
        });
        const cmds = await telegramSend(env, "setMyCommands", { commands: [
          { command: "panel", description: "پنل مدیریت (ادمین)" },
          { command: "lastmessages", description: "ارسال N پیام اخیر (مثال: /lastmessages 4)" },
          { command: "status", description: "وضعیت ربات" },
          { command: "help", description: "راهنما" },
        ]});
        return Response.json({ ok: true, webhook: wh, webhook_secret: "set", commands: cmds });
      } catch (e) { return Response.json({ ok: false, error: String(e.message || e) }, { status: 500 }); }
    }
    if (url.pathname === "/run" || url.pathname === "/poll") {
      const force = url.searchParams.get("force") !== "0";
      try { return Response.json({ ok: true, ...(await pollJob(env, force)) }); }
      catch (e) { return Response.json({ ok: false, error: String(e.message || e) }, { status: 500 }); }
    }

    if (url.pathname === "/morning-test") {
      try {
        const cfg = await getCfg(env);
        const d = tehranNow();
        const targets = resolveTargets(env, cfg, { target: mainChat });
        const text = morningText(cfg, d.getUTCDay()) + "\n(تست)";
        const done = [];
        for (const t of targets) {
          try { await tgSendText(env, t.chat, text); done.push(t.kind + ":" + t.chat); }
          catch (e) { console.warn(e && e.message); }
        }
        return Response.json({ ok: true, to: done });
      } catch (e) { return Response.json({ ok: false, error: String(e.message || e) }, { status: 500 }); }
    }

    if (url.pathname === "/diag") {
      const cfg = await getCfg(env);
      const out = { poll_minutes: cfg.poll_minutes, channels: cfg.channels, morning: cfg.morning, pm_users: (cfg.pm_users || []).length, pm_forward: cfg.pm_forward, checks: {} };
      try {
        const r = await fetch(`https://api.telegram.org/bot${envValue(env, "TELEGRAM_BOT_TOKEN")}/getMe`);
        out.checks.telegram_getMe = await r.json();
      } catch (e) { out.checks.telegram_getMe = { error: String(e) }; }
      try { out.checks.webhook_secret = (await env.OFFSET_KV?.get("wh_secret")) ? "set" : "missing — run /setup-tg"; } catch {}
      for (const ch of cfg.channels) {
        if (!ch.username) { out.checks["(no channel)"] = { page_ok: false, error: "کانال تنظیم نشده" }; continue; }
        try {
          const html = await fetchChannelPage(ch.username);
          const msgs = parseChannelPage(html);
          const seen = await getSeen(env, ch.username);
          out.checks[ch.username] = { page_ok: true, page_messages: msgs.length, seen_count: seen.length, newest: msgs.length ? { date: msgs[msgs.length - 1].date, time: msgs[msgs.length - 1].time, preview: msgs[msgs.length - 1].text.slice(0, 80) } : null };
        } catch (e) { out.checks[ch.username] = { page_ok: false, error: String(e && e.message || e).slice(0, 200) }; }
      }
      try { out.last_check_ago_min = Math.round((Date.now() - (parseInt((await env.OFFSET_KV?.get("last_check")) || "0", 10) || 0)) / 60000); } catch {}
      return Response.json(out);
    }

    if (url.pathname === "/send") {
      try {
        const t = url.searchParams.get("text") || "";
        if (!t) return Response.json({ ok: false, error: "missing ?text=" }, { status: 400 });
        const res = await tgSendText(env, mainChat, t.slice(0, 4096));
        return Response.json({ ok: true, telegram: res });
      } catch (e) { return Response.json({ ok: false, error: String(e.message || e) }, { status: 500 }); }
    }

    if (url.pathname === "/del") {
      try {
        const ids = (url.searchParams.get("ids") || "").split(",").map((s) => parseInt(s.trim(), 10)).filter(Boolean).slice(0, 60);
        if (!ids.length) return Response.json({ ok: false, error: "missing ?ids=1,2,3" }, { status: 400 });
        const results = [];
        for (const id of ids) {
          try { await telegramSend(env, "deleteMessage", { chat_id: mainChat, message_id: id }); results.push({ id, deleted: true }); }
          catch (e) { results.push({ id, deleted: false, error: String(e.message || e).slice(0, 150) }); }
          await sleep(200);
        }
        return Response.json({ ok: true, results });
      } catch (e) { return Response.json({ ok: false, error: String(e.message || e) }, { status: 500 }); }
    }

    if (url.pathname === "/test-tg") {
      try {
        const res = await tgSendText(env, mainChat, "✅ تست فورواردر: ارتباط ورکر با تلگرام برقرار است.");
        return Response.json({ ok: true, telegram: res });
      } catch (e) { return Response.json({ ok: false, error: String(e.message || e) }, { status: 500 }); }
    }

    if (url.pathname === "/health") {
      return Response.json({ ok: true });
    }

    return new Response(
      `Bale(public) -> Telegram forwarder

GET /health                  - health (بدون کلید)
GET /run?key=...             - poll now
GET /diag?key=...            - status
GET /setup-tg?key=...        - install webhook + secret + commands (once)
GET /morning-test?key=...    - test morning msg
POST /tg-webhook             - Telegram webhook (با secret_token)

همه endpoint های بالا به کلید نیاز دارند: ?key=<ADMIN_KEY>
Bot commands: /panel /lastmessages N /status /help /addpm /users
`,
      { headers: { "content-type": "text/plain; charset=utf-8" } }
    );
  },
};
