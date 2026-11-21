// عامل الجسر السحابي — يعمل داخل GitHub Actions بلا حاسوب المستخدم.
// يقرأ رسائل مجموعة «momo cod» عبر FCA، ويولّد رداً بـ Gemini المجاني، ويرسله.
// لا ينفّذ أوامر محلية: الحاسوب قد يكون مطفأً.
import { readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

const require = createRequire(import.meta.url)
const FCA_PATH = path.resolve(process.cwd(), "node_modules", "@dongdev", "fca-unofficial", "dist", "cjs.cjs")
const fca = require(FCA_PATH)

const APPSTATE = JSON.parse(process.env.FB_APPSTATE || "null")
const GEMINI_KEY = (process.env.GEMINI_KEY || "").trim()
const THREAD_ID = (process.env.TARGET_THREAD_ID || "1618729240054631").trim()
const CHECKPOINT = process.env.CHECKPOINT_FILE || "checkpoint.json"
const MAX_MESSAGES = Number(process.env.MAX_MESSAGES || 3)
const MODEL = process.env.GEMINI_MODEL || "gemini-flash-lite-latest"

if (!Array.isArray(APPSTATE) || !APPSTATE.length) throw new Error("FB_APPSTATE مفقود أو فارغ")
if (!GEMINI_KEY) throw new Error("GEMINI_KEY مفقود")

const SYSTEM = [
  "أنت جسر سحابي يعمل في السحابة ولا يملك حاسوب المستخدم؛ قد يكون حاسوبه مطفأً.",
  "أنت متصل بمجموعة فيسبوك «momo cod». أجب بالعربية وباختصار شديد.",
  "لا تدّعِ أبداً أنك فتحت برنامجاً أو أنشأت ملفاً أو نفّذت أمراً على حاسوب المستخدم.",
  "إن طلب المستخدم تنفيذ شيء محلي، قل بوضوح إن التنفيذ المحلي يحتاج تشغيل الجسر المحلي على حاسوبه.",
  "ابدأ ردك بكلمة «تم» فقط عند نجاح ما تستطيع فعله فعلاً (الرد/التلخيص/الإجابة).",
].join("\n")

function login(appState) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout login")), 90000)
    fca({ appState, logging: false }, (err, api) => {
      clearTimeout(timer)
      if (err) reject(err)
      else resolve(api)
    })
  })
}
function history(api, threadID, limit) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout history")), 60000)
    api.getThreadHistory(threadID, limit, undefined, (err, msgs) => {
      clearTimeout(timer)
      if (err) reject(err)
      else resolve(Array.isArray(msgs) ? msgs : [])
    })
  })
}
function send(api, threadID, body) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout send")), 60000)
    api.sendMessage(body, threadID, (err) => {
      clearTimeout(timer)
      if (err) reject(err)
      else resolve()
    })
  })
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

let checkpoint = { lastTimestamp: 0 }
try {
  checkpoint = JSON.parse(readFileSync(CHECKPOINT, "utf8"))
} catch {}
const last = Number(checkpoint.lastTimestamp || 0)

const api = await login(APPSTATE)
const ownID = String(api.getCurrentUserID() || "")
const msgs = await history(api, THREAD_ID, 30)
const fresh = msgs
  .filter((m) => Number(m.timestamp || 0) > last)
  .filter((m) => String(m.senderID || "") !== ownID)
  .filter((m) => String(m.body || "").trim())
  .filter((m) => !/^⏳|^تم تشغيل الجسر|^\✅/.test(String(m.body || "").trim()))
  .sort((a, b) => Number(a.timestamp) - Number(b.timestamp))
  .slice(-MAX_MESSAGES)

console.log(`thread=${THREAD_ID} own=${ownID} history=${msgs.length} new=${fresh.length} since=${last}`)

let newest = last
for (const m of fresh) {
  newest = Math.max(newest, Number(m.timestamp || 0))
  try {
    const reply = await askGemini(m.body)
    if (!reply) continue
    await send(api, THREAD_ID, reply.slice(0, 1800))
    console.log(`replied to ${m.senderID} ts=${m.timestamp}: ${reply.slice(0, 80).replace(/\n/g, " ")}`)
  } catch (e) {
    console.log(`reply error ts=${m.timestamp}: ${String(e?.message || e).slice(0, 160)}`)
  }
}

writeFileSync(CHECKPOINT, JSON.stringify({ lastTimestamp: newest, updatedAt: new Date().toISOString() }, null, 2))
console.log(`checkpoint=${newest}`)
