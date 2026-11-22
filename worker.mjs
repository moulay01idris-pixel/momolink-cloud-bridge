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
    const norm = (s) => String(s || "").replace(/\r/g, "").trim()
    const NOISE = /^(Aa|press enter to send|write a message|loading messages|announcement:|end-to-end encrypted messages restored|compose|message requests|active now|chat history is missing|enter your pin|forgot pin|messages and calls are secured)/i
    const senders = new Set()
    for (const el of document.querySelectorAll('[aria-label*="Message sent"]')) {
      const mm = norm(el.getAttribute("aria-label") || "").match(/\bby\s+(You|[^:]+?)\s*:/i)
      if (mm) senders.add(norm(mm[1]))
    }
    const labelOf = (el) => {
      let label = norm(el.getAttribute("aria-label") || "")
      if (!/\bmessage sent\b/i.test(label)) {
        const child = el.querySelector('[aria-label*="Message sent"], [aria-label*="by You"]')
        if (child) label = norm(child.getAttribute("aria-label") || "")
      }
      return label
    }
    const isOwn = (el) => /\bby\s+You\b(?=\s*:|$)/i.test(labelOf(el))
    const textOf = (el) => {
      const m = labelOf(el).match(/\bby\s+(You|[^:]+?)\s*:\s*([\s\S]+)$/i)
      if (m) {
        const body = norm(m[2])
        if (!body || NOISE.test(body) || senders.has(body)) return ""
        return body
      }
      const lines = norm(el.innerText || el.textContent || "").split("\n").map((s) => s.trim()).filter(Boolean)
      const META = /you sent|message sent|by you|loading|announcement|enter,|\bAM\b|\bPM\b|\d{1,2}:\d{2}|october|november|december/i
      const usable = lines.filter((s) => s.length > 2 && !META.test(s) && !NOISE.test(s) && !senders.has(s))
      if (usable.length !== 1) return ""
      return norm(usable[0])
    }
    const out = []
    const seen = new Set()
    for (const el of document.querySelectorAll('[role="article"]')) {
      if (isOwn(el)) continue
      const label = labelOf(el)
      const key = label || "txt:" + norm(el.innerText || el.textContent || "")
      if (seen.has(key)) continue
      let text = textOf(el)
      if (!text) {
        const inner = el.querySelector('[aria-label*="Message sent"], [aria-label*="by You"]')
        if (inner) text = textOf(inner)
      }
      if (!text || text.length > 3000 || senders.has(text)) continue
      if (/^(chats|marketplace|requests|archive|active now|messenger|skip to|compose|write a message)/i.test(text)) continue
      if (/^end-to-end encrypted messages restored|^message not restored|^you (deleted|sent) a message/i.test(text)) continue
      const sm = label.match(/\bby\s+(You|[^:]+?)\s*(?::|$)/i)
      seen.add(key)
      out.push({ key: key.slice(0, 500), text, sender: sm ? norm(sm[1]) : "" })
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
      const composerSel = '[role="textbox"][contenteditable="true"][aria-label^="Write to"], [role="textbox"][contenteditable="true"], [contenteditable="true"]'
      const countYou = () => page.evaluate(() =>
        Array.from(document.querySelectorAll('[role="article"]'))
          .filter((el) => /by\s+You\b/i.test(el.getAttribute("aria-label") || "")).length)
      const beforeCount = await countYou()
      await page.evaluate((sel) => { const el = document.querySelector(sel); if (el) el.focus() }, composerSel).catch(() => {})
      await page.keyboard.down("Control"); await page.keyboard.press("KeyA"); await page.keyboard.up("Control"); await page.keyboard.press("Backspace")
      const lines = String(reply).replace(/\r\n/g, "\n").split("\n").slice(0, 20)
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) { await page.keyboard.down("Shift"); await page.keyboard.press("Enter"); await page.keyboard.up("Shift") }
        if (lines[i]) await page.keyboard.type(lines[i].slice(0, 1800), { delay: 1 })
      }
      const handle = await page.evaluateHandle(() => {
        for (const s of ['[aria-label*="Send"]', '[aria-label*="إرسال"]']) {
          const el = document.querySelector(s); if (el) return el
        }
        return null
      })
      const sendBtn = handle.asElement?.()
      if (sendBtn) await sendBtn.click().catch(() => {})
      await sleep(600)
      for (let attempt = 0; attempt < 3; attempt++) {
        const left = await page.evaluate((sel) => String(document.querySelector(sel)?.innerText || "").trim(), composerSel).catch(() => "")
        if (!left) break
        await page.keyboard.press("Enter")
        await sleep(700)
      }
      await sleep(1500)
      const delivered = (await countYou()) > beforeCount
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
