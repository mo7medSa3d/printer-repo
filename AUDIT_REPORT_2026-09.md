# PRODUCTION READINESS: FAIL

**التاريخ:** 2026-09-05 · **الفرع:** main @ `646e7c8` (Merge PR #37 "close production readiness P0/P1 gaps")
**المنهج:** قراءة كاملة لكل طبقة (Gateway Next.js/TS، Agent Go، Tauri Rust، Addon Odoo 19، Docker/Caddy/CI)، تتبّع التدفق E2E، ومطابقة العقود بين الطرفين، مع تنفيذ فعلي: `npm run typecheck` ✅، `npm run lint` ✅، `npm run test:unit` (168 نجاحًا / 21 تخطٍّ بانتظار DATABASE_URL) ✅، `npm run build` ✅، واختبار HTTP حقيقي على خادم الإنتاج (NODE_ENV=production + build) — وهو ما كشف **المشكلة P0 أدناه**. غير قابل للتحقق محليًا (لا توجد أداة Go/Rust/PostgreSQL في البيئة): اختبارات Go (`go vet`/`go test -race`)، بناء Tauri، و11 اختبار تكامل PG — جميعها تُنفَّذ في CI (pg16/pg15 + odoo:19 + windows-latest).

---

## جدول المشكلات

| # | الخطورة | النطاق | الموقع | المشكلة | الأثر | السبب الجذري | الإصلاح | التحقق |
|---|---|---|---|---|---|---|---|---|
| 1 | **P0** | Gateway/Server | `server.ts` → `guardApiRequest` + `tests/production-hardening-contract.test.ts` | حارس حجم الجسم يربط `req.on("data")` على stream الطلب مباشرة قبل تمريره لـ Next.js؛ في Next 16 (production) يُصبح الـ stream "disturbed/locked" → كل طلب POST/PUT/PATCH/DELETE إلى `/api/*` يعيد **500 Internal Server Error** قبل وصوله للـ handler | **كل الواجهات الكتابية معطلة في النشر الفعلي**: إنشاء وظيف طباعة، تسجيل/heartbeat/بلاغات الحالة للـ agent، تسجيل مدير النظام، sync من Odoo. النظام لا يعمل E2E إطلاقًا على `npm start`/Docker | ربط listener `data` على `IncomingMessage` يحوّل الـ stream إلى "flowing" ويستنزفه؛ Next يبني `Request` Web من نفس الـ stream فيرمي `TypeError: Response body object should not be disturbed or locked`. السبب الجذري: غياب اختبار HTTP-level عبر الخادم المخصص — الاختبار الوحيد "سلوكي-ظاهري" يقرأ نص `server.ts` ويؤكد وجود السطر الخاطئ نفسه (`expect(server).toContain('req.on("data"')`) | (أ) للطلبات ذات Content-Length: فرض الحد من الهيدر فقط دون لمس الـ stream؛ (ب) للـ chunked: إعادة بناء الجسم عبر `PassThrough` يُمرَّر لـ Next مع العدّاد، أو الرفض، أو الاعتماد على حدّ `request_body max_size` في Caddy؛ (ج) استبدال الاختبار النصي باختبار HTTP حقيقي (تشغيل الخادم الفعلي وإرسال POST صغير + POST ضخم) | **تم التحقق بالتنفيذ:** build إنتاج + `NODE_ENV=production` → POST `/api/auth/manager/login` و`/api/print/jobs` و`/api/agent/register` جميعها 500؛ تجارب الضبط (نفس البناء دون الـ listener) → نفس الطلبات تصل الـ handlers وتعيد JSON صحيحًا (401/400/503) |
| 2 | **P1** | Security/Networking | `src/lib/auth-rate-limit.ts:68`، `src/server/ws.ts:31-40`، `docker-compose.yml:62` (`TRUST_PROXY: "1"` ثابت)، `Caddyfile` | IP العميل يُؤخذ من **أول** قيمة صالحة في `X-Forwarded-For`، وCaddy في التكوين المرفق لا يزيل/يعيد كتابة الهيدر (يُلصق فقط)، و`TRUST_PROXY=1` مفروض افتراضيًا | أي عميل خارجي يضع `X-Forwarded-For: <ip-مختار>` فيفلت من: حدود login لكل IP (10/دقيقة — التخفيف الجزئي: backoff على مستوى الحساب بعد 10 إخفاقات)، حدود مصادقة الـ agent (60/دقيقة + 1000/ساعة لكل IP)، وحدّ اتصالات WS لكل IP → brute-force موزّع عبر أسماء مستخدمين، وDoS على مقاعد WS | الثقة بالأيسار من سلسلة XFF دون وسيط يُنظّف الهيدر (sanitize) في نفس النشر | في Caddy: `header_up X-Forwarded-For {http.request.remote.host}` (استبدال لا إضافة) أو `forward_auth`؛ أو في الكود: اعتماد hop موثوق (يمين/عدد وسائط معروف)؛ إزالة `TRUST_PROXY` من default ووضعه كخيار موثّق | تشغيل: طلب مع XFF مختلف لكل محاولة → يجب أن يتصادم مع bucket واحد (IP حقيقي من Caddy) |
| 3 | **P1** | Job lifecycle/Reliability | `src/lib/job-maintenance.ts` (`STALE_PRINTING_SECONDS = 600`)، `src/lib/job-status.ts` | وظيفة في `printing` لأكثر من 10 دقائق تُفشل إجباريًا (`AGENT_EXECUTION_TIMEOUT`) بلا تمديد للـ lease؛ البلاغ المتأخر `success` يُرفض (409، الحالة terminal) | الطباعة الطويلة المشروعة (ملفات PCL/Raster كبيرة، طابعة شبكة بطيئة، spooler متأخر) → الورق يُطبع بينما النظام يسجّل `failed` → بيانات خاطئة + إعادة طباعة يدوية محتملة | لا يوجد آلية keep-alive/تمديد للـ lease أثناء الطباعة الفعلية، والحالات terminal لا تُعكس | تمديد lease عبر heartbeat/بلاغ `still-printing` من الـ agent، أو السماح بـ `printing→success` من الـ agent المالك بعد المهلة مع وسم `LATE_SUCCESS`، أو مهلة قابلة للضبط حسب الجهاز | اختبار: وظيفة printing 11 دقيقة ثم success → يجب أن تُسجّل success (بوسم) وليس 409 |
| 4 | **P2** | Security/Privacy | `src/app/api/odoo/sync/route.ts:476` | GET `/api/odoo/sync` يعيد `db.select().from(printJobs)` **بكل الأعمدة** (شمل `payload` حتى 5MB base64) × 50 وظيفة | أي Odoo key صالح في الفرع نفسه يقرأ محتوى الوثائق المطبوعة (فواتير، مستندات) من فرع يملك أي key فيه + استجابة قد تصل ~250MB | `select()` بدون تحديد أعمدة، والـ payload سري بدرجة محتوى العميل | استبعاد عمود `payload` من استجابة sync (بيانات وصفية فقط: status/error/printer/timestamps) | وحدة/تكامل: GET sync مع key فرع ≠ لا يحتوي base64 |
| 5 | **P2** | Security/Agent | `agent/internal/config/config.go` (حفظ `config.yaml` بـ 0600)، `agent/internal/storage/*` (DPAPI) | سِرّ الـ agent (`agent.secret` = هوية كاملة نحو الـ gateway: claim وظائف، بلاغ حالة، رفع طابعات عبر heartbeat) محفوظ **بصيغة نصية** في `C:\ProgramData\OdooPrintAgent\config.yaml`؛ على Windows بايتات الصلاحيات 0600 تُهمَل (ملف قابل للقراءة لأي مستخدم محلي). حزمة `storage` المخصصة (DPAPI) **كود ميت** — صفر مراجع خارجها واختباراتها | أي مستخدم/عملية محلية تقرأ السِرّ → انتحال هوية الـ agent على الـ gateway (طالب وظائف، قراءة payloads، تعديلات سجل الطابعات) | لم تُربط حزمة التخزين الآمنة المسجلة أصلًا بمسار الحفظ؛ افتراض POSIX permissions ينهار على NTFS | تفعيل `storage.SaveSecret/GetSecret` (أو Windows Credential/Registry) لسرّ الـ agent + (اختياري) icacls على مجلد ProgramData وقت التثبيت | اختبار Go: بعد pairing على Windows، نص السِرّ غير قابل للقراءة من `config.yaml` ويُفتح عبر الـ store فقط |
| 6 | **P2** | Security/Odoo | `odoo_addons/print_gateway/security/ir.model.access.csv`، `views/branch_views.xml` | `base.group_user` (أي مستخدم داخلي) يملك **قراءة** على `print_gateway.branch`؛ حقل `gateway_api_key` نصي عادي (widget `password="True"` يُخفي بصريًا فقط — القيمة تصل في حمولة read RPC وتظهر بالنقر). ir.rules تعزل بين الشركات فقط | أي مستخدم داخل شركة الفرع يسرق مفتاح Odoo→Gateway (يصل لكل بيانات الفرع على الـ gateway) | منحة قراءة عامة على نموذج يحمل سرًا + لا يوجد اختبار أمان يغطي هذا السيناريو | تقييد قراءة `branch` على مجموعة إدارية (مثل `base.group_system` أو مجموعة مخصصة) + نقل المفتاح لحقل محمي (compute-masked + storage محلي) + إضافة اختبار في `test_security_regressions.py` | اختبار Odoo: `user (group_user) read branch` → AccessError |
| 7 | **P2** | Odoo/Reliability | `models/print_job.py` → `cron_sync_print_jobs` (كل دقيقتين في `data/cron.xml`) | `search(status in (pending,queued,claimed,printing))` **بدون حد** ثم HTTP متسلسل (timeout 10ث) لكل وظيفة | تعطل الـ gateway + N وظيفة معلّقة = worker Odoo محجوز لساعات (N×10ث+)، يمسّ عمليات الشركة كلها على نفس worker | غياب `.limit()` وغياب batch/circuit-breaker | `.limit(50)` + نقطة نهاية sync دفعي (قائمة IDs) + backoff عند فشل متكرر | اختبار: 100 pending وgateway معطّل → cron يُنهي بحد زمني معلوم |
| 8 | **P2** | Supply-chain/Tauri | `src-tauri/` (لا يوجد `Cargo.lock`) | الـ lock غائب عن المستودع | `cargo audit` يفحص إصدارات عائمة (قد تختلف عن المبني فعلًا)، مفتاح cache في CI `hashFiles('src-tauri/Cargo.lock')` فارغ، وبناء MSI غير قابل للتكرار بين تشغيلات CI | عدم توليد/التزام `Cargo.lock` | توليد `cargo generate-lockfile` والتزامه + فحص CI يفشل إن غاب | وجود الملف + cache فعال + audit يقرأ الإصدارات المثبتة |
| 9 | **P2** | Reliability/Load | Claim CTE في `src/app/api/agent/jobs/route.ts` (حد in-flight ≈500/agent) مقابل `maxPendingJobs=64` في `agent/internal/agent/agent.go` | عند انشغال الـ agent المتواصل (8 موازٍ × ~20ث): الـ gateway يُ_claim دفعات (20/دورة)؛ ما يتجاوز 64 pending يُلقي به الـ agent صامتًا → تبقى `claimed` 90ث → استرجاع stale → `retries+1` → بعد ~5 دورات تُفشل الوظائف بـ `exceeded max retries` **رغم سلامة الـ agent** | تحت الحمل المرتفع تتحول وظائف سليمة إلى `failed` (خسارة وظائف + إعادة إرسال يدوية) ولا يوجد أي إشارة gateway بأن الـ agent رفض الاستلام | عدم توافق بين سقف الـ gateway (500) وسعة مخزن الـ agent (64) + عدم إبلاغ الـ gateway عند الرفض | إبلاغ الـ gateway برفض الاستلام (رفض في استجابة polling/ACK سلبي) فيُعاد الـ job دون عدّ retry، أو تخفيض سقف claim لـ ≤ (pending buffer × 1.2)، أو رفع مخزن الـ agent + تنبيه backpressure | اختبار حمل: 200 وظيفة متزامنة لطابعة بطيئة → صفر `failed` بسبب retries |
| 10 | **P3** | Functional/Odoo+Agent | `agent/internal/agent/agent.go` (recover + report `failed`)، `docs/CONFIGURATION.md:44`، `docs/AGENT.md:51`، `agent/internal/config/config.go` | `reprint_after_crash` **عطّال وظيفيًا**: الوظيفة المقطوعة تُبلَّغ `failed` (terminal) عند الإقلاع، فيستحيل إعادة تسليمها من الـ gateway → لا مسارات لإعادة الطباعة رغم `true`؛ والوثائق تتناقض: CONFIGURATION.md/AGENT.md تقولان الافتراضي `true` بينما الكود و`config.yaml.example` وDEPLOYMENT.md يقولون `false` | سلوك موثّق ("at-least-once قد يكرر الورق") غير موجود أصلًا؛ المشغّل يضبط علمًا لا يفعل شيئًا | تصميم: بلاغ المقطوع terminal يمنع إعادة التسليم | إما: عند `true` لا يُبلَّغ المقطوع كـ terminal (حالة `unknown`/إعادة ترميز) كي يعيد الـ gateway التسليم، أو حذف العلم وتصحيح الوثائق إلى "لا إعادة طباعة تلقائية" | E2E: إيقاف agent أثناء طباعة مع `true` → إعادة التسليم تحدث (أو الوثيقة تُصحح وتُختبر) |
| 11 | **P3** | Networking | `src/server/ws.ts` (مسار الـ upgrade غير `/api/agent/ws`) | عند upgrade غير مطابق يعيد الـ handler دون `socket.destroy()` | اتصالات TCP معلّقة (سطح DoS صغير/تسرب موارد) | غياب destroy في مسار الخطأ | `socket.destroy()` مع 404 | اختبار: upgrade إلى مسار خاطئ → يغلق المقباس فورًا |
| 12 | **P3** | Security/Agent lifecycle | `src/app/api/agents/[id]/route.ts` (disable/retire) | تعطيل/إنهاء الـ agent يصفّر السِرّ في القاعدة لكن الجلسات WS المفتوحة تبقى تتسلم وظائف حتى إغلاقها | نافذة قصيرة لاستلام وظائف بعد التعطيل | لا يوجد إغلاق نشط للجلسات عند تغيير الحالة | إغلاق كل مقابس الـ agent عند التعطيل (عبر `agentSockets` map) | اختبار: تعطيل agent ذو WS مفتوح → لا وظائف جديدة خلال ثانية |
| 13 | **P3** | Performance | `src/app/api/odoo/printers/route.ts` | GET بدون `LIMIT` إطلاقًا (فرع = كل طابعات الفرع، global key = كل القاعدة × 16KB config + 32KB capabilities) | استجابات ضخمة/بطيئة مع نمو السجل؛ استهلاك ذاكرة على الـ worker | غياب حد صفّ | `LIMIT` (مثل 500) + pagination | وحدة: عدد الصفوف ≤ الحد |
| 14 | **P3** | Performance/UI | `src/app/api/jobs/route.ts` (GET manager) | `db.select().from(printJobs)` كل الأعمدة بما فيها `payload` × 200 صف | قائمة لوحة القيادة قد تنقل جيجا بايت → كسل/تجمد الـ UI واستهلاك ذاكرة | غياب select محدود للأعمدة الوصفية في قائمة | select بدون `payload` في GET (مع `payload` فقط في GET `/jobs/[id]`) | وحدة: استجابة القائمة بلا payload |
| 15 | **P3** | Security/Auth | `src/app/api/auth/manager/login/route.ts`، `src/lib/manager-auth.ts` | (أ) early-return لاسم مستخدم غير موجود = oracle توقيت (يتسرب وجود الحساب)؛ (ب) علم `ALLOW_PLAINTEXT_MANAGER_PASSWORD` مسموح في الإنتاج؛ (ج) كوكي `Secure` مشروط على `NODE_ENV` (أي نشر بـ NODE_ENV مختلف يفقدها) | تسريب قائمة الحسابات، كلمة مرور نصية على الـ env، كوكي session بلا Secure خلف Caddy (HTTPS) | نمذجة أمان دفاعية جزئية | مقارنة توقيت ثابتة (hash username دائمًا) + إلزام hash (حذف العلم) + `Secure` من وجود TLS/خلف proxy لا من NODE_ENV | وحدة: توقيت متساوٍ لحساب موجود/غير موجود؛ فشل البناء/الإنذار عند plaintext |
| 16 | **P3** | Security/API | `src/app/api/print/jobs/route.ts` (GET) | key غير scoped (legacy/global) يجلب أي وظيفة بالـ id **مع payload** | كشف محتوى وثائق لأي فرع بحيازة key واسع | منطق التقييد يطبَّق على الفرع عند الوجود فقط | فرض `branchId` للمفاتيح القديمة أو رفض القراءة الواسعة | وحدة: global key + job من فرع آخر → 403 |
| 17 | **P3** | Agent/Printer | `agent/internal/printer/network.go` (ctx 20ث لكتابه الوثيقة كاملة) | RAW/ESCPOS بملف 5MB على طابعة حرارية بطيئة: الـ ctx يقطع الكتابة **منتصف الحمولة** → طباعة جزئية + فشل الوظيفة | وثيقة مقطوعة فعليًا على الورق مع `failed` في النظام | مهلة زمنية واحدة على العملية كلها دون تمييز handshake من نقل البيانات | مهلة اتصال منفصلة (5ث) + مهلة نقل تعتمد على الحجم/المعدل (أو بلا حد مع backpressure) + تأكيد EOT حيث يدعم البروتوكول | وحدة شبكية بطيئة (token bucket) 5MB → تُطبع كاملة |
| 18 | **P3** | Maintainability/Odoo | `models/ir_actions_report.py` + `models/async_report.py`، `models/__init__.py` | تعريفا `report_action` مزدوجان؛ تحميل `async_report` آخرًا يجعل الـ async هو السائد دائمًا → مسار render-in-request المتزامن كود ميت | حيرة صيانة؛ أي تعديل على المسار المتزامن لا أثر له | تجاوز method في نموذجين دون توثيق الأولوية | حذف المسار المتزامن أو توثيق الأولوية بصرامة + اختبار يثبت السلوك الفعلي | اختبار Odoo يثبت أن `report_action` العائد هو async |
| 19 | **P3** | Functional/Odoo↔Gateway parity | `models/destination.py` (`get_printer_for_doctype`) مقابل routing في `src/lib/*` | مطابقة `document_type` **حساسة لحالة الأحرف** في Odoo بينما الـ gateway غير حساسة؛ fallback في Odoo = أي binding مفعّل بينما الـ gateway يعيد NO_ROUTE | وثيقة قد تُوجَّه لخطأ في Odoo بينما الـ gateway يرفضها (أو العكس) حسب مسار الإرسال | منطق توجيه منقول جزئيًا دون مطابقة دقيقة | استنساخ قواعد الـ gateway حرفيًا (lower/trim + نفس fallback) أو إرجاع التوجيه للـ gateway حصريًا + اختبار parity | اختبار parity: حالات upper/lower/mixed → نفس النتيجة في الطرفين |
| 20 | **P3** | Odoo/Performance | `models/agent.py` (`action_sync_status`)، `models/printer.py` (`action_sync_from_gateway`) | كل نقرة "مزامنة" على agent/طابعة تطلق sync كامل للفرع (كل القوائم) → تضخيم N× للـ gateway | أحمال متكررة بلا داعٍ مع الاستخدام التفاعلي | إعادة استخدام snapshot كامل بدل delta/نطاق ضيق | نقطة حالة محدودة (agent/printer واحدة) أو debounce | قياس: sync مفرد = طلب واحد محدود |
| 21 | **P3** | Tauri/Ops | `src-tauri/src/agent.rs` | `stop()` يستخدم `taskkill /F` (بلا drainage لطابور الـ agent)؛ `setup` يفعّل autolaunch بلا شرط؛ رسالة خطأ `register_printer` تحذف أنواع `tcp`/`ipps` الصالحة | قتل مفاجئ أثناء طباعة (نتيجة مادية غير معروفة)، بدء تلقائي غير مرغوب أحيانًا، توهين مستخدم | اختصارات تنفيذية | توقف ناعم: `cli stop`/signal مع مهلة ثم /F؛ autolaunch اختيار من الإعدادات؛ تصحيح النص | يدوي: إيقاف أثناء طباعة → بلاغ `AGENT_RESTART_DURING_PRINT` بلا قطع منتصف-حزمة |
| 22 | **P3** | Data safety/Gateway | `src/app/api/odoo/sync/route.ts` (POST) | قائمة فارغة حاضرة (مثلاً `destinations: []`) تعطّل **كل** صفوف الفرع المطابقة → انقطاع NO_ROUTE كامل حتى sync تالٍ سليم؛ كما أن تحقق الاعتماديات (FKs) خارج الـ transaction (TOCTOU عند إعادة استخدام IDs) | فرع يُشغَّل بسيناريوهات شركة خاطئة (recordset فارغ) يُلغي ترويجه صامتًا | snapshot كامل بدون حارس "لا تدمير" | رفض snapshot فارغ كليًا إلا بعلم صريح `wipe=true` (مع سجل) + نقل تحقق الاعتماديات داخل الـ tx | وحدة: sync بقوائم فارغة → 400 دون تغيير الحالة |
| 23 | **P3** | Validation | `src/app/api/branches/[id]/destinations/route.ts` | `name`/`type` بلا حد طول (نموذج DB يقبل) | صفوف متضخمة محتملة | غياب حدود مدخلات | `.max(120)` على النوعين (كبقية المجالات) | وحدة |
| 24 | **P3** | Agent/Concurrency | `agent/internal/agent/discovery_manager.go` | `go a.executeDiscoverySession(...)` لكل جلسة معلقة بلا حد goroutines | انبثاق مؤقت غير محدود (كل جلسة محصورة 30ث، والجلسات تنتهي 60ث) → ذروة صغيرة | غياب worker pool للجلسات | قناة محدودة/worker 1-2 | وحدة: 50 جلسة متزامنة → ≤ N goroutines |
| 25 | **P3** | Ops/DB | كل أعمدة التوقيت `timestamp` (بدون tz) في `drizzle/*` | الفروض الضمنية: خادم وDB بنفس TZ (UTC في Docker)؛ نشر بخادم غير UTC يشوّه `expires_at`/المهلات | انحراف مهلات/تواؤم عتبات (ساعات) في نشرات غير قياسية | استخدام timestamp غير مزوّن + غياب توثيق TZ إلزامي | توثيق "TZ=UTC إلزامي" في DEPLOYMENT + health-check يقارن `now()` بتطبيق، أو تحويل لـ timestamptz في migration قادمة | فحص نشر: الفرق بين `now()` في PG و`new Date()` في الـ worker ≈ 0 |
| 26 | **P3** | CI/informational | `.github/workflows/build-windows.yml` | `npm run test` بدون خدمة Postgres → بطاقات التكامل تُتخطّى صامتًا هناك (مغطاة في `ci.yml`) | وهم تغطية أخضر في workflow منفرد | غياب service container في هذا الـ workflow | إضافة `services: postgres` أو توثيق صريح أن ci.yml هو المرجع | ظهور skip-count في logs |

---

## 1) Critical blockers (P0)

**B-1 — كل الطلبات الكتابية على الخادم الفعلي معطلة.** (مشكلة الجدول #1).
- **الدليل بالتشغيل:** `npm run build` ثم `NODE_ENV=production node_modules/.bin/tsx server.ts` → `POST /api/auth/manager/login`، `POST /api/print/jobs`، `POST /api/agent/register` = `500 Internal Server Error` (وفي dev يظهر stack: `TypeError: Response body object should not be disturbed or locked` عند بناء `NextRequest`).
- **تجربة الضبط:** خادم بنفس البناء دون `req.on("data")` → نفس الطلبات تصل handlers وتعيد `401/400/503` بصيغ JSON الصحيحة. الفرق الوحيد هو listener الحارس → السبب مؤكد.
- **لماذا لم تلتقطه CI؟** كل اختبارات الـ API تستورد الـ handlers مباشرة (in-process) فتتجاوز `server.ts`؛ و`docker-runtime-smoke` يجرّب `GET /api/health` فقط؛ واختبار "hardening" النصي **يقنّن الخلل (يفرضه كنص متوقع)** (يتوقع وجود `req.on("data"` كنص).
- **الحكم:** لا يمكن للنشر (npm start أو Docker) قبول أي كتابة: لا وظيف طباعة، لا تسجيل agent، لا login مدير → **FAIL مطلق** حتى الإصلاح.

## 2) High-risk defects (P1)

- **H-1 (#2):** تخطي حدود معدل IP عبر `X-Forwarded-For` المصنوع مع `TRUST_PROXY=1` المدمج في compose وCaddy غير المنظّف. التخفيف الوحيد: backoff على مستوى الحساب في login (يحد brute-force لاسم معروف لكنه لا يوقف التوزيع على حسابات متعددة، ولا يحمي حدود agent/WS).
- **H-2 (#3):** مهلة طباعة 10 دقائق بدون keep-alive + رفض `success` المتأخر → فشل وظائف مطبوعة فعلًا (بيانات خاطئة + إعادة طباعة يدوية).

## 3) Functional inconsistencies

- `reprint_after_crash` غير فعّال + تناقض الافتراضي بين الوثائق والكود (#10).
- عدم تطابق حساسية الأحرف وfallback في توجيه document type بين Odoo وGateway (#19).
- انقطاع NO_ROUTE كامل عند sync بقوائم فارغة (#22) — قابل للتعافي بإعادة sync.
- TOCTOU في تحقق اعتماديات sync خارج الـ tx (#22).
- Tauri: `taskkill /F` بلا drainage + autolaunch غير مشروط (#21).

## 4) Security vulnerabilities

- **معرّضة للاستغلال الفعلي في التوزيع الافتراضي:** XFF spoofing (#2, P1).
- **تسريب أسرار:** payload الوظائف عبر GET sync (#4)؛ مفتاح الفرع `gateway_api_key` قابل للقراءة لكل `group_user` في الشركة (#6)؛ سِرّ الـ agent نصي في ProgramData على Windows مع حزمة DPAPI ميتة (#5)؛ keys واسعة تجلب أي job+payload (#16)؛ oracle توقيت للحسابات + علم كلمة مرور نصية + كوكي Secure مشروط NODE_ENV (#15).
- **ما هو جيد (تم التحقق بالأكواد):** مقارنة timing-safe للأسرار؛ branch isolation في كل مسارات الـ agent/Odoo؛ provisioning بـ `FOR UPDATE`؛ rate limiting (مع عيب XFF أعلاه)؛ CSP صارم في Tauri؛ صفر shell interpolation في Tauri/agent؛ قيود صلاحيات Tauri الحد الأدنى؛ ir.rules عزل شركات في Odoo على كل النماذج.

## 5) Reliability / concurrency

- **قوي (تم التحقق):** claim ذري `FOR UPDATE SKIP LOCKED`؛ استرجاع stale claim 90ث مع budget استلام (5 محاولات → failed صريح)؛ PG NOTIFY بين النسخ مع reconnect أسّي؛ حالة terminal نهائية بـ CHECKs في القاعدة (0012-0014)؛ dedup بالـ job id على الـ agent (SQLite `IsProcessed`/inFlight) يغطي إعادة التسليم المزدوج؛ backpressure 500/1000/10000.
- **فجوات:** مهلة الطباعة (#3)؛ استنفاد re-tries تحت الحمل (#9)؛ بلاغ المقطوع terminal يعطّل `reprint_after_crash` (#10)؛ جلسات WS حيّة بعد تعطيل agent (#12).

## 6) Performance issues

- 5MB payloads داخل قوائم (sync GET #4، manager jobs GET #14، unscoped printers GET #13).
- cron Odoo غير محدود (#7).
- sync كامل متكرر من أزرار Odoo (#20).
- **جيد:** pool 20 مع `statement_timeout=30s` و`lock_timeout=5s`؛ حدود bodies (بما أنها تعمل بعد إصلاح #1)؛ حدود WS 64KB/1MB؛ تنظيف وظائف manager محدد `MAX_CLEANUP_ROWS=5000` مع `confirm=1` وcutoff إلزامي.

## 7) Testing gaps

- **الأخطر:** لا يوجد أي اختبار HTTP-level عبر `server.ts` (سبب مرور #1)؛ واختبار "hardening" الحالي نصي يثبّت الخلل. → **إلزامي:** suite تكامل يشغّل الخادم الفعلي (POST سليم + POST ضخم + upgrade مرفوض + WS).
- 11 ملف تكامل PG + 21 وحدة تتطلب `DATABASE_URL` — ❓ غير منفذة في هذه البيئة (لا PostgreSQL)؛ تُنفَّذ في CI (pg16 + odoo19/pg15).
- Go: 22 ملف اختبار (~4200 سطر) تغطي concurrency/dedup/crash/failure/E2E-mock/PDF-hardening — ❓ غير منفذة هنا (لا Go toolchain)؛ CI ينفّذ `go vet` + `test` + `-race`.
- Odoo: 3 ملفات (662 سطر) تغطي عزل الشركات وrouting — ❓ غير منفذة هنا (لا Odoo)؛ CI يثبت addon حقيقيًا على `odoo:19.0`.
- فجوة تغطية أمان: لا اختبار يمنع قراءة `group_user` لـ `branch` (#6).
- فجوة E2E دلالية: لا اختبار يثبت شرط إعادة التسليم لـ `reprint_after_crash` (#10).
- **إيجابي:** فشل-injection (PG NOTIFY)؛ invariant SQL checks؛ اختبار WS claim-before-delivery وrace claims (SKIP LOCKED)؛ اختبار status transitions المتوازي؛ MSI install + smoke على windows-latest.

## 8) Deployment / CI-CD problems

- **قوي (تم التحقق):** 7 workflows: SHA-pinned actions + gate، `npm audit` moderate + `govulncheck` + `cargo audit`، ci.yml (pg16 migrate+invariants+11 تكامل، pg15 Odoo 19 live `--test-tags=/print_gateway`)، build-windows.yml (MSI/NSIS + msiexec + smoke)، docker-build + runtime-smoke، main-governance gate.
- **عيوب:** compose يفرض `TRUST_PROXY=1` (#2)؛ Caddy بلا `request_body` limit ولا sanitize XFF؛ smoke لا يجرّب أي مسار كتابة (أفلت #1)؛ لا `Cargo.lock` (#8)؛ `npm run test` في build-windows بدون PG يتخطى صامتًا (#26)؛ migrations خارج boot path — قرار صحيح وموثق (خدمة migrate أحادية) لكن يعني **نشر يدوي مطلوب** قبل أول تشغيل (موثق في DEPLOYMENT).

## 9) Dependency / version issues

- **Node:** `.nvmrc`/`engines` = 24.20.0؛ هذه البيئة 22.22.3 (نُفّذ كل شيء بنجاح، لكن CI المرجع على 24 — فرق سلوكي محتمل ضئيل).
- **Rust:** غياب `Cargo.lock` (#8) = اعتماديات عائمة + بناء غير قابل للتكرار.
- **Go:** `go.mod` حاضنة (❓ غير قابلة للتثبيت هنا)؛ CI يتحقق منها.
- **Python/Odoo:** addon يثبّت على Odoo 19 في CI؛ لا `requirements` خارجية (سليم).
- **npm:** audit moderate gate في CI (سليم).

## 10) Documentation / configuration inconsistencies

- `reprint_after_crash`: الافتراضي `true` في CONFIGURATION.md وAGENT.md مقابل `false` في الكود + `config.yaml.example` + DEPLOYMENT.md (#10).
- "at-least-once" في JOB_LIFECYCLE/SECURITY/TROUBLESHOOTING يصف سلوك إعادة تسليم **غير ممكن** (#10).
- `TRUST_PROXY` موثّق في `auth-rate-limit` بأن يُضبط "خلف proxy يُنظّف الهيدرز" بينما النشر الافتراضي (compose+Caddy) لا ينظّف (#2).
- `docs/DEPLOYMENT.md` دقيق بشأن migrate-one-shot (مطابق للواقع) ✅.
- API/عقود WS مطابقة فعليًا بين الطرفين (envelope `{type:"print_job", job}` ↔ `extractJobFromWSMessage`) ✅.

## 11) Production readiness score

| المحور | النقاط | المبرر |
|---|---|---|
| التشغيل الفعلي للتدفق الأساسي (25) | **0** | P0: كل الكتابات 500 على الخادم الفعلي |
| الأمان (20) | **8** | تحصينات واسعة صحيحة، لكن: XFF bypass، 4 مسارات تسريب أسرار/محتوى، سِرّ agent نصي |
| الموثوقية/التوازي (20) | **12** | تصميم DB/claim ممتاز؛ فجوات lease-طباعة، overload، reprint |
| الاختبار (15) | **10** | Suites واسعة على 4 لغات؛ غياب طبقة HTTP-server + اختبار نصي يثبّت الخلل |
| النشر/CI (10) | **5** | CI قوي فعلًا؛ لكن smoke يفوّت P0 + إعدادات proxy خاطئة افتراضيًا |
| الأداء (10) | **3** | payloads في قوائم، cron غير محدود، GET بلا حدود |
| **الإجمالي** | **38/100** | **FAIL** |

---

## A→Z Production Readiness Checklist

| الحرف | المحور | الحالة | الدليل |
|---|---|---|---|
| A | Architecture & boundaries | ✅ | قراءة كل طبقة؛ فصل صلاحيات (manager/odoo/agent) متماسك؛ عقود مطابقة |
| B | Functional correctness (core flows) | ❌ | P0 #1: كل POST/PUT/PATCH/DELETE /api/* = 500 على الخادم الفعلي (تنفيذ + تجربة ضبط) |
| C | End-to-end flow (Odoo→Gateway→WS/Poll→Agent→Print) | ⚠️ | E2E in-process (WS claim→delivery→status) موثّق واختباره قوي؛ لكن لا E2E عبر HTTP فعلي (أفقدنا P0)؛ الجانب Go/طباعة ❓ (لا toolchain) |
| D | Database & migrations | ✅ | 0000→0017 مقروءة كاملة: FKs، partial unique idempotency، CHECKs على machines، recreate FKs بدون schema prefix (worker-safe)، invariant SQL في CI |
| E | Job lifecycle state machine | ✅ | تحولات مقيدة بالكود + CHECKs + اختبارات race (winning transition واحد) + terminal لا ينعكس |
| F | Networking / reverse proxy | ❌ | TRUST_PROXY=1 + XFF أيسار + Caddy بلا sanitize (#2)؛ upgrade غير مطابق يهمل destroy (#11) |
| G | Security | ⚠️ | timing-safe، isolation، least-privilege تauri ✅؛ لكن تسريبات #4/#5/#6/#15/#16 وbypass #2 |
| H | Printer layer (agent) | ⚠️ | قراءة كاملة: RAW 9100 short-write loop، 5MB cap، PDF 0600 + ShellExecuteExW بانتظار exit code، IPP بحدود فحص، discovery محصور بشبكات خاصة، spooler deferred-close ✅؛ ctx 20ث يقطع كتابة بطيئة (#17) |
| I | Go agent (build/test) | ❓ | 22 ملف اختبار (~4203 سطر)؛ غير قابلة للتنفيذ هنا (لا Go)؛ CI ينفّذ vet/test/race |
| J | Next.js/TypeScript app | ⚠️ | typecheck ✅ lint ✅ build ✅ 168 unit ✅؛ عيب واحد قاتل في custom server (#1) |
| K | Tauri desktop manager | ⚠️ | قراءة كاملة: صفر shell interpolation، capabilities `core:default` فقط، CSP صارم، تحقق إدخال قبل spawn ✅؛ `taskkill /F`، autolaunch غير مشروط (#21)؛ البناء ❓ (لا cargo) + لا Cargo.lock (#8) |
| L | Odoo 19 addon | ⚠️ | قراءة كاملة models/data/security/tests: fail-closed routing، outbox idempotent (persist قبل network + savepoint + postcommit)، ir.rules شركات ✅؛ عيوب #6/#7/#18/#19/#20؛ التشغيل الفعلي ❓ (CI: odoo:19 live) |
| M | Docker deployment | ⚠️ | Dockerfile multi-stage + `USER node` + healthcheck + migrate منفصل ✅؛ compose `TRUST_PROXY=1` وCaddy عاري (#2)؛ smoke لا يجرّب كتابة |
| N | CI/CD | ⚠️ | 7 workflows قوية (SHA pins، govulncheck، cargo audit، Odoo live، MSI+smoke، failure-injection) ✅؛ لكنها عمياء عن طبقة الـ server الفعلي (أفقدت P0) |
| O | Testing | ⚠️ | تغطية واسعة 4 لغات + failure-injection ✅؛ فجوة HTTP-server وsecurity-ACL وE2E-dl semantics؛ اختبار نصي يقنّن الخلل (يفرضه كنص متوقع) |
| P | Performance | ⚠️ | pool/limits/backpressure سليمة ✅؛ payloads في قوائم + cron بلا حد + GETs بلا LIMIT |
| Q | Reliability / ops | ⚠️ | health/metrics/log-rotation/service drain ✅؛ مهلة طباعة بلا تمديد (#3) + overload→retry exhaustion (#9) + TZ assumption (#25) |

**مجموع: ✅ 5 · ⚠️ 9 · ❌ 2 · ❓ 1**

---

## Fix Plan

### A. إلزامي قبل الإنتاج (Blocking)
1. **#1 P0 — إصلاح حارس الجسم في `server.ts`:** لا `data` listener على الطلب. Content-Length → تحقق من الهيدر فقط. Chunked → `PassThrough` (العدّاد عليه والجسم يُمرَّر لـ Next) أو رفض الـ chunked لـ `/api/*` أو `request_body max_size` في Caddy. **مع** استبدال الاختبار النصي باختبار HTTP حقيقي (تشغيل الخادم: POST صغير يصل handler، POST > 8MB → 413، upgrade مرفوض يُغلق المقباس). *تحقق: إعادة smoke الإنتاج — login/print/register/heartbeat/sync يعمل.*
2. **#2 P1 — تنظيف XFF:** `header_up X-Forwarded-For {http.request.remote.host}` في Caddy (أو منطق hop موثوق في الكود) + إخراج `TRUST_PROXY` من default إلى خيار موثّق. *تحقق: spoofing XFF لا يفلت من الـ buckets.*
3. **#3 P1 — تمديد مهلة الطباعة:** keep-alive/`still-printing` من الـ agent أو قبول `printing→success` متأخر من المالك مع وسم؛ وإلا رفع المهلة كإعداد موثق. *تحقق: طباعة > 10 دقائق تُسجّل success.*
4. **#4 P2 — إزالة `payload` من GET `/api/odoo/sync`** (وصفي فقط). *تحقق: لا base64 في الاستجابة.*
5. **#6 P2 — تقييد قراءة `print_gateway.branch`** (مجموعة إدارية) + اختبار regression. *تحقق: group_user → AccessError.*
6. **#5 P2 — تفعيل تخزين DPAPI لسِرّ الـ agent** (حزمة `storage` جاهزة ومختبرة) أو Credential/Registry + توثيق ACL. *تحقق: السِر غير نصي في config.yaml.*

### B. مؤجل (مهم، ليس حجبًا للنشر)
7. **#7** حد + batch في `cron_sync_print_jobs`.
8. **#8** توليد والتزام `src-tauri/Cargo.lock`.
9. **#9** مواءمة claim-cap مع مخزن الـ agent + إبلاغ رفض الاستلام.
10. **#10** تفعيل `reprint_after_crash` فعليًا أو حذفه + تصحيح الوثائق (الافتراضي).
11. **#13/#14/#16** حدود وselects محصورة في الـ GETs الواسعة.
12. **#17** فصل مهلة الاتصال عن مهلة النقل في RAW/ESCPOS.
13. **#15** أمان login: مقارنة توقيت ثابتة، إلزام hash، `Secure` بلا NODE_ENV.

### C. اختياري / تحسين
14. #11 destroy في مسار upgrade غير المطابق. 15. #12 إغلاق جلسات WS عند تعطيل agent. 16. #18 حذف/توثيق المسار المتزامن الميت. 17. #19 parity حساسية الأحرف + fallback. 18. #20 sync موقود/delta من أزرار Odoo. 19. #21 Tauri: stop ناعم + autolaunch اختياري + نص الأخطاء. 20. #22 حارس snapshot الفارغ + تحقق داخل tx. 21. #23 حدود name/type. 22. #24 worker pool لجلسات discovery. 23. #25 توثيق TZ=UTC + فحص. 24. #26 PG service في build-windows أو توثيق.

### D. Verified-OK (لا يتطلب إجراء)
- Claim ذري `FOR UPDATE SKIP LOCKED` + استرجاع stale + budget استلام.
- Terminal states بـ CHECKs + تحولات مقيدة + اختبارات race.
- PG NOTIFY cross-instance مع reconnect أسّي وfailure-injection test.
- Idempotency (partial unique + re-fetch)؛ outbox في Odoo (persist قبل network، savepoint، postcommit).
- Branch isolation في كل مسارات agent/Odoo/manager.
- Agent: SQLite WAL/اتصال واحد، dedup بالـ job id، discovery محصور (شبكة خاصة فقط، حدود زمن/عدد)، PDF بملفات 0600 وShellExecuteExW بانتظار exit code، IPP بحدود فحص، spooler deferred-close، pairing بدون طباعة السِر.
- Tauri: صفر shell interpolation، capabilities الحد الأدنى، CSP صارم، تحقق إدخال pre-spawn، logging بـ rotation.
- Docker: multi-stage، `USER node`، healthcheck، migrate one-shot منفصل عن boot (موثق).
- CI: SHA pins + gates، govulncheck/cargo audit/npm audit، Odoo 19 live tests، MSI install+smoke، invariant SQL، main-protection.
- `npm run typecheck` ✅، `npm run lint` ✅، `npm run test:unit` 168/168 ✅، `npm run build` ✅ (node 22؛ المرجع 24.20.0).

---

**نتيجة نهائية:** تصميم ناضج ونادر الجودة في تفاصيله (claiming، idempotency، hardening)، لكن **نسخة النشر الحالية لا تعمل إطلاقًا على الخادم الفعلي بسبب P0 في `server.ts`** — وهو خرق دخل عبر "إصلاح P0/P1" سابق (PR #37) وأُخفيت عن CI باختبار نصي يثبّط نفس الأسطر الخاطئة. **PRODUCTION READINESS: FAIL** — بعد إصلاحات قسم A أعلاه (خاصة #1 مع اختبار HTTP حقيقي) يمكن إعادة التقييم المتوقع أن يرفع الدرجة إلى نطاق 80+.
