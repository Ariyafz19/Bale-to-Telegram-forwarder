// تست محلی پارسر بلِه — بدون نیاز به Cloudflare یا توکن تلگرام
// اجرا: node scripts/test-local.js [آیدی_کانال]
// (آیدی کانال پیش‌فرض: BALE_CHANNEL از .dev.vars یا your_bale_channel)

import { readFile } from "node:fs/promises";
import { parseChannelPage, isJunk, formatMsg } from "../src/index.js";

async function channelFromDevVars() {
  try {
    const txt = await readFile(new URL("../.dev.vars", import.meta.url), "utf8");
    const m = txt.match(/^\s*BALE_CHANNEL\s*=\s*"?([^"\r\n]+)"?/m);
    return m ? m[1].trim() : "";
  } catch { return ""; }
}

const arg = (process.argv[2] || "").trim().replace(/^@/, "");
const channel = arg || (await channelFromDevVars()) || "your_bale_channel";
console.log(`در حال خواندن صفحهٔ عمومی ble.ir/s/${channel} ...`);

const r = await fetch(`https://ble.ir/s/${encodeURIComponent(channel)}`, {
  headers: {
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    "accept-language": "fa,en;q=0.8",
  },
});
console.log("HTTP", r.status);
const html = await r.text();
const msgs = parseChannelPage(html);
console.log(`پیام‌های پارس‌شده: ${msgs.length}\n`);

let shown = 0;
for (const m of msgs) {
  if (isJunk(m)) continue;
  console.log("=".repeat(60));
  console.log(formatMsg(channel, channel, m).slice(0, 500));
  if (++shown >= 5) break;
}
console.log("\n" + "=".repeat(60));
const junk = msgs.filter(isJunk).length;
console.log(`✅ پارسر سالم است — ${msgs.length} پیام، ${junk} ردیف زائد (پیام‌های واقعی فوروارد می‌شوند)`);
if (!msgs.length) {
  console.log("⚠️ پیامی پیدا نشد: آیدی کانال را بررسی کنید (باید عمومی باشد و از ble.ir/s/ قابل مشاهده).");
  process.exit(1);
}
