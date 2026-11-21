# MoMoLink Cloud Bridge

جسر فيسبوك سحابي يعمل داخل GitHub Actions، أي **بلا حاسوب المستخدم**.

## ما يفعله
- كل 5 دقائق يفتح مجموعة «momo cod» عبر جلسة فيسبوك مخزّنة كسرّ.
- يقرأ الرسائل الجديدة فقط (يتتبّع `checkpoint.json`).
- يولّد رداً عربياً مختصراً عبر Gemini المجاني ويرسله إلى المجموعة.

## ما لا يفعله (مهم)
- **لا ينفّذ أوامر على حاسوبك.** لا يمكن لأي خادم أن يفتح برنامجاً أو ملفاً على جهاز مطفأ.
- التنفيذ المحلي يبقى عبر الجسر المحلي `OCBridge` عندما يكون الحاسوب شغّالاً.

## الأسرار (Secrets)
- `FB_APPSTATE`: مصفوفة كوكيز فيسبوك من `fb-auth.json` (تُرفع كسرّ ولا تُطبع).
- `GEMINI_KEY`: مفتاح Gemini المجاني من `~/.config/opencode/secrets/google.key`.

## التحديث
عند انتهاء جلسة فيسبوك، حدّث سر `FB_APPSTATE` من الحاسوب (عند تشغيله) بتشغيل:
`python refresh_secret.py`

## التشغيل اليدوي
من تبويب Actions اضغط «Run workflow»، أو عبر API:
`POST /repos/{owner}/{repo}/actions/workflows/bridge.yml/dispatches`
