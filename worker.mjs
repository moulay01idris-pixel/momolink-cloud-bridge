// عامل الجسر السحابي — يعمل داخل GitHub Actions بلا حاسوب المستخدم.
// يقرأ رسائل «momo cod» من متصفح حقيقي بالكوكيز، ويولّد رداً بـ Gemini، ويرسله.
// لا ينفّذ أوامر محلية: الحاسوب قد يكون مطفأً.
import { readFileSync, writeFileSync } from "node:fs"
import puppeteer from "puppeteer-core"

const APPSTATE = JSON.parse(process.env.FB_APPSTATE || "null")
const GEMINI_KEY = (process.env.GEMINI_KEY || "").trim()
const THREAD_ID = (process.env.TARGET_THREAD_ID || "1618729240054631").trim()
const CHECKPOINT = process.env.CHECKPOINT_FILE || "checkpoint.json"
const MAX_MESSAGES = Number(process.env.MAX_MESSAGES || 3)
const MODEL = process.env.GEMINI_MODEL || "gemini-flash-lite-latest"
const CHROME_PATH = process.env.CHROME_PATH || "/usr/bin/google-chrome"
const PRIME_ONLY = process.env.PRIME_ONLY === "1"
const HEADLESS = process.env.HEADLESS !== "false"

if (!Array.isArray(APPSTATE) || !APPSTATE.length) throw new Error("FB_APPSTATE مفقود أو فارغ")
if (!GEMINI_KEY && !PRIME_ONLY) throw new Error("GEMINI_KEY مفقود")

const SYSTEM = [
  "أنت جسر سحابي يعمل في السحابة ولا يملك حاسوب المستخدم؛ قد يكون حاسوبه مطفأً.",
  "أنت متصل بمجموعة فيسبوك «momo cod». أجب بالعربية وباختصار شديد.",
  "لا تدّعِ أبداً أنك فتحت برنامجاً أو أنشأت ملفاً أو نفّذت أمراً على حاسوب المستخدم.",
  "إن طلب المستخدم تنفيذ شيء محلي، قل بوضوح إن التنفيذ المحلي يحتاج تشغيل الجسر المحلي على حاسوبه.",
  "ابدأ ردك بكلمة «تم» فقط عند نجاح ما تستطيع فعله فعلاً (الرد/التلخيص/الإجابة).",
].join("\n")

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function loadCheckpoint() {
  try {
    const d = JSON.parse(readFileSync(CHECKPOINT, "utf8"))
    return { primed: !!d.primed, seenKeys: Array.isArray(d.seenKeys) ? d.seenKeys.map(String) : [] }
  } catch {
    return { primed: false, seenKeys: [] }
  }
}
function saveCheckpoint(cp) {
  writeFileSync(CHECKPOINT, JSON.stringify({ ...cp, updatedAt: new Date().toISOString() }, null, 2))
}

async function askGemini(text) {
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${GEMINI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: String(text).slice(0, 4000) }],
      max_tokens: 500,
    }),
  })
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = await res.json()
  return String(data?.choices?.[0]?.message?.content || "").trim()
}

const browser = await puppeteer.launch({
  executablePath: CHROME_PATH,
  headless: HEADLESS,
  args: [
    "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
    "--no-first-run", "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
  ],
  defaultViewport: { width: 1366, height: 768 },
})

try {
  const page = await browser.newPage()
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36")
  const cookies = APPSTATE.filter((c) => /facebook\.com/.test(c.domain || "")).map((c) => ({
    name: c.name, value: c.value, domain: c.domain, path: c.path || "/",
    secure: c.secure !== false, httpOnly: !!c.httpOnly,
    ...(c.expires && c.expires > 0 ? { expires: c.expires } : {}),
  }))
  await page.setCookie(...cookies)
  await page.goto(`https://www.facebook.com/t/${THREAD_ID}/`, { waitUntil: "domcontentloaded", timeout: 90000 })
  await sleep(9000)

  const state = await page.evaluate(() => ({
    url: location.href,
    loginForm: !!document.querySelector('input[name="email"], input[name="pass"]'),
    title: String(document.title || "").slice(0, 80),
    articles: document.querySelectorAll('[role="article"]').length,
    composer: !!document.querySelector('[role="textbox"][contenteditable="true"]'),
  }))
  console.log("browser-state=" + JSON.stringify(state))
  if (state.loginForm || /login|checkpoint|two_step/i.test(state.url)) throw new Error("FACEBOOK_NOT_LOGGED_IN")
  if (!state.articles) throw new Error("NO_MESSAGES_FOUND")

  const messages = await page.evaluate(() => {
    const norm = (s) => String(s || "").replace(/\s+/g, " ").trim()
    const out = []
    for (const el of document.querySelectorAll('[role="article"]')) {
      let label = norm(el.getAttribute("aria-label") || "")
      const inner = el.querySelector('[aria-label*="Message sent"]')
      if (!label && inner) label = norm(inner.getAttribute("aria-label") || "")
      const m = label.match(/\bMessage sent\b[^:]*\bby\s+(You|[^:]+?)\s*:\s*([\s\S]+)$/i)
      if (!m) continue
      const sender = norm(m[1])
      if (/^you$/i.test(sender)) continue
      const text = norm(m[2])
      if (!text || text.length > 3000) continue
      out.push({ key: label.slice(0, 400), text, sender })
    }
    return out
  })
  const unique = [...new Map(messages.map((m) => [m.key, m])).values()]
  console.log("messages=" + unique.length)

  const cp = loadCheckpoint()
  if (PRIME_ONLY || !cp.primed) {
    cp.primed = true
    cp.seenKeys = unique.map((m) => m.key).slice(-300)
    saveCheckpoint(cp)
    console.log("primed=" + cp.seenKeys.length)
    if (PRIME_ONLY) process.exit(0)
  }

  const fresh = unique.filter((m) => !cp.seenKeys.includes(m.key)).slice(-MAX_MESSAGES)
  console.log("fresh=" + fresh.length)

  let sent = 0
  for (const m of fresh) {
    try {
      const reply = await askGemini(m.text)
      if (!reply) continue
      const ok = await page.evaluate((t) => {
        const el =
          document.querySelector('[role="textbox"][contenteditable="true"][aria-label^="Write to"]') ||
          document.querySelector('[role="textbox"][contenteditable="true"]') ||
          document.querySelector('[contenteditable="true"]')
        if (!el) return false
        el.focus()
        document.execCommand("insertText", false, t)
        return String(el.innerText || "").trim().length > 0
      }, reply.slice(0, 1800))
      if (!ok) throw new Error("composer-fill-failed")
      await sleep(300)
      await page.keyboard.press("Enter")
      await sleep(2500)
      const delivered = await page.evaluate((t) => {
        const needle = String(t || "").replace(/\s+/g, " ").trim().slice(0, 40)
        return Array.from(document.querySelectorAll('[role="article"]'))
          .some((el) => /by You/i.test(el.getAttribute("aria-label") || "") && (el.getAttribute("aria-label") || "").includes(needle))
      }, reply.slice(0, 1800))
      if (!delivered) throw new Error("delivery-not-confirmed")
      cp.seenKeys.push(m.key)
      cp.seenKeys = cp.seenKeys.slice(-300)
      saveCheckpoint(cp)
      sent++
      console.log("replied=" + m.sender + " text=" + m.text.slice(0, 60).replace(/\n/g, " "))
    } catch (e) {
      console.log("reply-error=" + String(e?.message || e).slice(0, 160))
    }
  }
  saveCheckpoint(cp)
  console.log(`done sent=${sent} pending=${fresh.length - sent}`)
} finally {
  try { await browser.close() } catch {}
  if (!PRIME_ONLY) process.exit(0)
}
