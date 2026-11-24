// عامل الجسر السحابي — يعمل في GitHub Actions بلا حاسوب المستخدم.
// الافتراضي: السحابة ترد أولاً. بأمر من المستخدم يتحول الرد للمحلي،
// وإن تعذّر المحلي (حاسوب مطفأ/متوقف) يرجع السحابة تلقائياً.
import { readFileSync, writeFileSync } from "node:fs"
import puppeteer from "puppeteer-core"

const APPSTATE = JSON.parse(process.env.FB_APPSTATE || "null")
const GEMINI_KEY = (process.env.GEMINI_KEY || "").trim()
const THREAD_ID = (process.env.TARGET_THREAD_ID || "1618729240054631").trim()
const CHECKPOINT = process.env.CHECKPOINT_FILE || "checkpoint.json"
const MODE_FILE = process.env.MODE_FILE || "mode.json"
const MAX_MESSAGES = Number(process.env.MAX_MESSAGES || 3)
const MODEL = process.env.GEMINI_MODEL || "gemini-flash-lite-latest"
const CHROME_PATH = process.env.CHROME_PATH || "/usr/bin/google-chrome"
const PRIME_ONLY = process.env.PRIME_ONLY === "1"
const FAILOVER_AFTER_MS = Number(process.env.FAILOVER_AFTER_MS || 120000)

if (!Array.isArray(APPSTATE) || !APPSTATE.length) throw new Error("FB_APPSTATE مفقود أو فارغ")
if (!GEMINI_KEY && !PRIME_ONLY) throw new Error("GEMINI_KEY مفقود")

// فحص مبكر: لا داعي لإقلاع متصفح بجلسة منتهية.
function writeHealth(status, detail = "", articles = 0) {
  try {
    writeFileSync("health.json", JSON.stringify({
      at: new Date().toISOString(), status, articles, detail: String(detail).slice(0, 240),
    }, null, 2))
  } catch {}
}
function cookieFault(list) {
  const now = Date.now() / 1000
  for (const k of ["xs", "c_user"]) {
    const c = list.find((x) => (x.name || x.key) === k)
    if (!c) return "COOKIE_MISSING:" + k
    const exp = Number(c.expirationDate || c.expires || 0)
    if (exp && exp < now) return "COOKIE_EXPIRED:" + k
  }
  return ""
}
const fault = cookieFault(APPSTATE)
if (fault) {
  console.log(fault + " — يجب تحديث FB_APPSTATE")
  writeHealth(fault)
  process.exit(78)
}

// أوامر التحويل: صيغة قصيرة صارمة لتفادي تحويل الوضع بكلام عابر.
const CMD_LOCAL = /^\s*\/?\s*(محلي|local|تحول\s+للمحلي|انتقل\s+للمحلي|حول\s+للمحلي|شغل\s+المحلي|شغّل\s+المحلي|فعّل\s+المحلي|تفعيل\s+المحلي|فع[ّ]?ل\s+الجسر\s+محلي|فع[ّ]?ل\s+الجسر\s+المحلي|شغ[ّ]?ل\s+الجسر\s+محلي|شغ[ّ]?ل\s+الجسر\s+المحلي|الجسر\s+المحلي|فع[ّ]?ل\s+الجسر\s+فيسبوك|شغ[ّ]?ل\s+الجسر\s+فيسبوك|الجسر\s+الفيسبوكي)\s*[.!؟]?\s*$/i
const CMD_CLOUD = /^\s*\/?\s*(سحابي|cloud|تحول\s+للسحابي|انتقل\s+للسحابي|حول\s+للسحابي|شغل\s+السحابي|شغّل\s+السحابي|فعّل\s+السحابي|تفعيل\s+السحابي|ارجع\s+للسحابي|السحابة|فع[ّ]?ل\s+الجسر\s+سحابي|فع[ّ]?ل\s+الجسر\s+السحابي|شغ[ّ]?ل\s+الجسر\s+سحابي|شغ[ّ]?ل\s+الجسر\s+السحابي|الجسر\s+السحابي)\s*[.!؟]?\s*$/i

const SYSTEM = [
  "أنت جسر سحابي يعمل في السحابة ولا يملك حاسوب المستخدم؛ قد يكون حاسوبه مطفأً.",
  "أنت متصل بمجموعة فيسبوك «momo cod». أجب بالعربية وباختصار شديد.",
  "لا تدّعِ أبداً أنك فتحت برنامجاً أو أنشأت ملفاً أو نفّذت أمراً على حاسوب المستخدم.",
  "إن طلب المستخدم تنفيذ شيء محلي، قل بوضوح إن التنفيذ المحلي يحتاج تشغيل الجسر المحلي على حاسوبه.",
  "إن سُئلت عن أوامر التحويل: أرسل «محلي» لتحويل الرد للجسر المحلي، أو «سحابي» للعودة للسحابة.",
  "ابدأ ردك بكلمة «تم» فقط عند نجاح ما تستطيع فعله فعلاً (الرد/التلخيص/الإجابة).",
].join("\n")

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function loadJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")) } catch { return fallback }
}
function loadCheckpoint() {
  const d = loadJson(CHECKPOINT, {})
  return { primed: !!d.primed, seenKeys: Array.isArray(d.seenKeys) ? d.seenKeys.map(String) : [] }
}
function saveCheckpoint(cp) {
  writeFileSync(CHECKPOINT, JSON.stringify({ ...cp, updatedAt: new Date().toISOString() }, null, 2))
}
function loadMode() {
  const d = loadJson(MODE_FILE, {})
  return { mode: d.mode === "local" ? "local" : "cloud", since: Number(d.since || 0) }
}
function saveMode(mode) {
  writeFileSync(MODE_FILE, JSON.stringify({ mode, since: mode === "local" ? Date.now() : 0, updatedAt: new Date().toISOString() }, null, 2))
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
  headless: true,
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
  // فيسبوك أوقف عرض المسار المباشر /t/<id>/ — نبدأ من /messages/t/<id>/.
  const navigate = (path) =>
    page.goto(`https://www.facebook.com${path}`, { waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {})
  const snapshot = () => page.evaluate(() => ({
    url: location.href,
    loginForm: !!document.querySelector('input[name="email"], input[name="pass"]'),
    checkpoint: /checkpoint|two_step|help\/contact/i.test(location.href),
    title: String(document.title || "").slice(0, 80),
    articles: document.querySelectorAll('[role="article"]').length,
    composer: !!document.querySelector('[role="textbox"][contenteditable="true"]'),
    body: String(document.body?.innerText || "").slice(0, 160).replace(/\s+/g, " "),
  }))

  let state = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    await navigate(attempt === 3 ? `/t/${THREAD_ID}/` : `/messages/t/${THREAD_ID}/`)
    // انتظار ذكي: نخرج فور ظهور الرسائل بدل نوم ثابت.
    for (let i = 0; i < 90; i++) {
      state = await snapshot().catch(() => null)
      if (state?.articles || state?.loginForm || state?.checkpoint) break
      await sleep(500)
    }
    if (state?.articles) break
    console.log(`nav-retry=${attempt} articles=${state?.articles || 0} title=${state?.title || ""}`)
    await sleep(1500)
  }
  state = state || { url: "", articles: 0, body: "" }
  console.log("browser-state=" + JSON.stringify(state))
  if (state.loginForm) {
    writeHealth("SESSION_EXPIRED", state.body)
    throw new Error("SESSION_EXPIRED — " + state.body)
  }
  if (state.checkpoint || /login|checkpoint|two_step/i.test(state.url)) {
    writeHealth("CHECKPOINT_REQUIRED", state.body)
    throw new Error("CHECKPOINT_REQUIRED — " + state.body)
  }
  if (!state.articles) {
    const why = /isn't available|not available/i.test(state.body) ? "THREAD_UNREACHABLE" : "NO_MESSAGES_FOUND"
    writeHealth(why, state.body, 0)
    throw new Error(why + " — " + state.body)
  }

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
    const all = Array.from(document.querySelectorAll('[role="article"]')).map((el) => ({
      el, label: labelOf(el), own: isOwn(el),
    }))
    const out = []
    const seen = new Set()
    for (let idx = 0; idx < all.length; idx++) {
      const { el, label, own } = all[idx]
      if (own) continue
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
      const answered = all.slice(idx + 1).some((x) => x.own)
      seen.add(key)
      out.push({ key: key.slice(0, 500), text, sender: sm ? norm(sm[1]) : "", answered })
    }
    return out
  })
  const unique = [...new Map(messages.map((m) => [m.key, m])).values()]
  console.log("messages=" + unique.length)

  const composerSel = '[role="textbox"][contenteditable="true"][aria-label^="Write to"], [role="textbox"][contenteditable="true"], [contenteditable="true"]'
  async function sendReply(text) {
    await page.evaluate((sel) => { const el = document.querySelector(sel); if (el) el.focus() }, composerSel).catch(() => {})
    await page.keyboard.down("Control"); await page.keyboard.press("KeyA"); await page.keyboard.up("Control"); await page.keyboard.press("Backspace")
    const lines = String(text).replace(/\r\n/g, "\n").split("\n").slice(0, 20)
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
    const needle = String(text).split("\n")[0].replace(/\s+/g, " ").trim().slice(0, 20)
    for (let k = 0; k < 12; k++) {
      const ok = await page.evaluate((n) =>
        Array.from(document.querySelectorAll('[role="article"]')).some((el) => {
          const label = String(el.getAttribute("aria-label") || "").replace(/\s+/g, " ")
          return /by\s+You\b/i.test(label) && label.includes(n)
        }), needle).catch(() => false)
      if (ok) return true
      await sleep(900)
    }
    const empty = await page.evaluate((sel) => !String(document.querySelector(sel)?.innerText || "").trim(), composerSel).catch(() => false)
    if (empty) { console.log("delivery-assumed-by-empty-composer"); return true }
    return false
  }

  const cp = loadCheckpoint()
  let modeState = loadMode()
  let mode = modeState.mode
  console.log(`mode=${mode}`)

  // أوامر التحويل تُعالج من أي رسالة حديثة (حت لو ردّ المحلي عليها قبلاً).
  const toLocal = unique.find((m) => CMD_LOCAL.test(m.text))
  const toCloud = unique.find((m) => CMD_CLOUD.test(m.text))
  if (toLocal && mode !== "local") {
    saveMode("local")
    cp.seenKeys.push(toLocal.key); cp.seenKeys = cp.seenKeys.slice(-300); saveCheckpoint(cp)
    await sendReply("تم. تحوّل الرد إلى الجسر المحلي. تأكد من تشغيل الحاسوب؛ إن لم يرد خلال دقيقتين سأعود للسحابة تلقائياً.")
    console.log("mode=local by-command")
    process.exit(0)
  }
  if (toCloud && mode !== "cloud") {
    saveMode("cloud")
    cp.seenKeys.push(toCloud.key); cp.seenKeys = cp.seenKeys.slice(-300); saveCheckpoint(cp)
    await sendReply("تم. عدنا إلى الجسر السحابي.")
    console.log("mode=cloud by-command")
    process.exit(0)
  }

  if (PRIME_ONLY || !cp.primed) {
    cp.primed = true
    cp.seenKeys = unique.map((m) => m.key).slice(-300)
    saveCheckpoint(cp)
    console.log("primed=" + cp.seenKeys.length)
    if (PRIME_ONLY) process.exit(0)
  }

  let fresh = unique.filter((m) => !m.answered && !cp.seenKeys.includes(m.key))
  const skippedAnswered = unique.filter((m) => m.answered && !cp.seenKeys.includes(m.key)).length
  console.log(`fresh=${fresh.length} skipped_already_answered=${skippedAnswered}`)

  if (mode === "local") {
    const since = Number(modeState.since || 0)
    if (!fresh.length || (since && Date.now() - since < FAILOVER_AFTER_MS)) {
      console.log("standby-cloud: local active")
      writeHealth("STANDBY_LOCAL_ACTIVE", "", state.articles)
      process.exit(0)
    }
    // المحلي هو الردّ الأساس؛ السحابة ترد كاحتياط فقط دون تغيير الوضع.
    console.log("backup-cloud-reply reason=local-no-reply (mode stays local)")
  }

  fresh = fresh.slice(-MAX_MESSAGES)
  let sent = 0
  for (const m of fresh) {
    try {
      const reply = await askGemini(m.text)
      if (!reply) continue
      const ok = await sendReply(reply)
      if (!ok) throw new Error("delivery-not-confirmed")
      cp.seenKeys.push(m.key); cp.seenKeys = cp.seenKeys.slice(-300); saveCheckpoint(cp)
      sent++
      console.log("replied=" + m.sender + " text=" + m.text.slice(0, 60).replace(/\n/g, " "))
    } catch (e) {
      console.log("reply-error=" + String(e?.message || e).slice(0, 160))
    }
  }
  saveCheckpoint(cp)
  console.log(`done sent=${sent} pending=${fresh.length - sent}`)
  writeHealth(sent ? "REPLIED" : "HEALTHY", `sent=${sent}`, state.articles)
} finally {
  try { await browser.close() } catch {}
}
