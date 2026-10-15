/**
 * العراقي — مستقبل المزامنة (Google Apps Script) — v23: رفع + سحب + أكواد تفعيل الأجهزة + سجل الأجهزة (من متصل) + إيقاف جهاز عن بعد + حماية الشيت + كيان payments (تحصيلات العملاء)
 * الإعداد (مرة واحدة):
 *  1) افتح Google Sheet جديد (ده هيبقى النسخة السحابية) ← Extensions ← Apps Script ← الصق الكود ده.
 *  2) Project Settings ← Script properties ← Add: الاسم SYNC_TOKEN والقيمة رمز سري طويل (8+ حروف) — نفس اللي هتحطه في التطبيق.
 *  3) Deploy ← New deployment ← Web app: Execute as = Me ، Who has access = Anyone ← Deploy ← انسخ الرابط (بينتهي بـ /exec).
 *  4) في التطبيق: مركز المزامنة ← إعدادات الاتصال ← الصق الرابط والرمز ← اختبار الاتصال.
 *  5) (v22) باقي الأجهزة: من «مركز المزامنة ← الأجهزة المتصلة ← كود تفعيل جديد» على جهاز المالك، وفي الجهاز الجديد (شاشة الدخول) «ربط الجهاز بكود». شوف الشرح تحت في «الأمان».
 *     (لو فتحت الرابط في المتصفح هتشوف {"ok":true,"service":"aliraqi-sync"...} — ده معناه إن النشر سليم. «تعذر العثور على doGet» معناها إنك لسه على نسخة قديمة من الكود.)
 * تحديث من نسخة قديمة: الصق الكود ده مكان القديم ← Deploy ← Manage deployments ← Edit ← New version (الرابط بيفضل زي ما هو).
 * v23: الجديد بس إضافة payments في KEYS/POLICY/FINAL_STATUS (3 أسطر). لازم يتنشر قبل ما أجهزة v23 تبعت تحصيلات (وإلا العملية بتتسجّل «عنصر غير صالح» وبتتعاد بعد التحديث).
 *
 * إزاي بيشتغل:
 *  - كل نوع بيانات بياخد ورقة (Sheet) باسمه. الأعمدة العادية للقراءة البشرية بس (شيتس بتحوّل «0202» لرقم و«0101…» لرقم وتواريخ ISO لتاريخ).
 *  - المصدر الحقيقي لكل سجل هو الأعمدة الخاصة: _srv (رقم تسلسلي عالمي بيزيد مع كل كتابة) + _upd (UpdatedAt بالمللي ثانية) + _dev (الجهاز) + _j0.._jN (السجل كامل JSON على أجزاء).
 *    ما تعدّلش الأعمدة دي يدوي ولا تمسحها.
 *  - الرفع (sync): upsert بالمفتاح. السجلات القابلة للتعديل (lww): لو اللي في الشيت أحدث من اللي مرفوع (UpdatedAt) بيتتجاهل المرفوع — «الأحدث يكسب».
 *    السجلات اللي مبتتعدلش (once): الحركات وسجل العمليات ونسخ التعديل وسطور المرتجع — لو موجودة ما بتتكتبش تاني.
 *  - السحب (pull): الجهاز بيبعت آخر _srv وصله، والسيرفر بيرجّع السجلات اللي _srv بتاعها أكبر (على دفعات). مفيش حاجة بتتمسح أبداً.
 *  - سجلات قديمة اترفعت قبل v14.1 مالهاش _srv/_json: بتتحدّث لما أي جهاز يعمل «إعادة رفع كل البيانات» من مركز المزامنة (مرة واحدة).
 */
const KEYS = {customers:'CustomerID', invoices:'InvoiceID', invoice_lines:'LineID', invoice_revisions:'RevisionID', credit_notes:'CreditNoteID',
  credit_note_lines:'LineID', movements:'MovementID', stock_docs:'DocID', audit:'AuditID', users:'UserID', products:'ProductID', warehouses:'WarehouseID', payments:'PaymentID'};
const POLICY = {customers:'lww', products:'lww', warehouses:'lww', users:'lww', invoices:'lww', stock_docs:'lww', credit_notes:'lww', invoice_lines:'lww', payments:'lww',
  credit_note_lines:'once', invoice_revisions:'once', movements:'once', audit:'once'};
// الحالة النهائية: لما سجل (فاتورة/مستند مخزن/تحصيل) يتسجل في الشيت بالحالة دي، أي كتابة تانية عليه بتترفض — حتى لو UpdatedAt بتاعها أحدث (يمنع تعديل أوفلاين متأخر من إنه «يحيي» فاتورة ملغاة).
const FINAL_STATUS = {invoices: 'VOID', stock_docs: 'VOID', payments: 'VOID'};
const SECRET = /^(pinhash|salt|pin|password|token)$/i;   // خط دفاع تاني: عمره ما يتكتب سر في الشيت حتى لو جه بالغلط
const SYS_COLS = ['_srv', '_upd', '_dev', '_j0'];
const CHUNK = 40000, MAX_CHUNKS = 8, PULL_LIMIT = 200, PULL_BYTES = 1200000;

// ================= الأمان (v22) =================
// - SYNC_TOKEN = «الرمز الرئيسي» (للمالك بس): بيفتح عمليات الإدارة (أكواد التفعيل، قائمة الأجهزة، إيقاف/تفعيل جهاز) وبيشتغل للمزامنة كمان (للأجهزة القديمة).
// - باقي الأجهزة بتتفعّل بـ «كود تفعيل» يطلّعه المالك (8 حروف، مرة واحدة، صالح 24 ساعة بالافتراضي) وبتاخد رمز خاص بيها (متخزّن هنا مشفّر SHA-256).
//   المالك يقدر يوقف أي جهاز عن بعد: الجهاز بيتقفل عند أول اتصال وبيقف عن المزامنة لحد ما المالك يفعّله تاني.
// - سجل الأجهزة (آخر ظهور/المستخدم/النسخة) متخزّن في Script Properties بمفاتيح DEV:<id>. الأكواد في CODES.
// - بعد ما كل أجهزتك تتفعّل بالأكواد: غيّر قيمة SYNC_TOKEN في Script Properties (رمز جديد طويل) وحطه على جهاز المالك بس — كده الرمز القديم اللي كان مع الأجهزة بيبطل.
const MAX_COLS = 150, FIELD_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/, ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const DAY = 86400000, ONLINE_MS = 180000, SEEN_EVERY = 45000, MAX_OPS = 100, MAX_ITEMS_REQ = 400;

function eq_(a, b) {                                                 // مقارنة بزمن ثابت
  a = String(a); b = String(b);
  let d = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}
function sha_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8).map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}
// أي نص جاي من جهاز وبيتكتب في الشيت: بيتشال منه محارف التحكم، وبيتبدئ بـ ' لو أوله = + - @ (بيمنع تحويله لمعادلة)
function esc_(v) { const s = String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ''); return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; }
function safeId_(v) { const s = String(v == null ? '' : v).slice(0, 40); return ID_RE.test(s) ? s : ''; }
function safeTxt_(v, n) { return String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, '').slice(0, n || 40); }
function getDev_(props, id) { if (!id) return null; try { return JSON.parse(props.getProperty('DEV:' + id) || 'null'); } catch (e) { return null; } }
function putDev_(props, rec) { props.setProperty('DEV:' + rec.id, JSON.stringify(rec)); }
function randCode_() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Utilities.getUuid() + Date.now(), Utilities.Charset.UTF_8);
  let c = '';
  for (let i = 0; i < 8; i++) c += A.charAt((d[i] & 255) % 32);
  return c;
}
function normCode_(v) { return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function loadCodes_(props) {
  let c = {}; try { c = JSON.parse(props.getProperty('CODES') || '{}') || {}; } catch (e) { c = {}; }
  const now = Date.now();
  for (const h in c) if (!c[h] || c[h].exp < now) delete c[h];
  return c;
}

// فتح رابط الـ /exec من المتصفح = طلب GET. بنرجّع حالة بس (من غير أي بيانات ولا رمز ولا هل الرمز متضبط). المزامنة نفسها كلها POST.
function doGet(e) {
  return json_({ok: true, service: 'aliraqi-sync', proto: 3, note: 'الرابط ده بيستقبل طلبات المزامنة (POST) من التطبيق بس — مفيش بيانات بتتعرض هنا.'});
}
// المصادقة: الرمز الرئيسي (admin) أو رمز الجهاز (مطابق لهاش متسجّل للجهاز ده). جهاز موقوف = REVOKED حتى لو معاه الرمز الرئيسي.
function auth_(body, props, devId) {
  const master = props.getProperty('SYNC_TOKEN'), tok = String(body.token || '');
  if (!master) return {ok: false, code: 'AUTH', error: 'السيرفر لسه ما اتضبطش: ضيف SYNC_TOKEN في Script Properties'};
  if (eq_(tok, master)) {
    const rec = getDev_(props, devId);
    if (rec && rec.st === 'DISABLED') return {ok: false, code: 'REVOKED', error: 'الجهاز ده اتوقف من المالك'};
    return {ok: true, admin: true, rec: rec};
  }
  const rec = getDev_(props, devId);
  if (!rec || rec.kind !== 'device' || !eq_(sha_(tok), rec.th)) return {ok: false, code: 'AUTH', error: 'الرمز السري غير صحيح أو الجهاز مش متفعّل — اطلب كود تفعيل من المالك', };
  if (rec.st === 'DISABLED') return {ok: false, code: 'REVOKED', error: 'الجهاز ده اتوقف من المالك'};
  return {ok: true, admin: false, rec: rec};
}
// تسجيل آخر ظهور (حد أدنى 45 ث بين كتابتين) + أول تسجيل لأجهزة الرمز الرئيسي القديمة (عشان تظهر في القائمة ويتقدر توقفها)
function touch_(props, a, body, devId) {
  if (!devId) return;
  const now = Date.now(), name = safeTxt_(body.devName, 30), user = safeTxt_(body.user, 30), ver = safeTxt_(body.app, 12);
  let rec = a.rec;
  if (!rec) rec = {id: devId, name: name, kind: 'master', st: 'ACTIVE', created: now, seen: 0, user: '', ver: ''};
  if (rec.seen && now - rec.seen < SEEN_EVERY && (rec.user === user || !user) && (rec.ver === ver || !ver) && (rec.name === name || !name)) return;
  rec.seen = now; if (user) rec.user = user; if (ver) rec.ver = ver; if (name) rec.name = name;
  putDev_(props, rec);
}
function doPost(e) {
  let out, devId = '';
  try {
    const body = JSON.parse(e.postData.contents);
    devId = safeId_(body.device);
    const act = String(body.action || ''), props = PropertiesService.getScriptProperties();
    if (act === 'enroll') {
      const lk = LockService.getScriptLock();
      lk.waitLock(25000);
      try { out = handleEnroll_(body, props, devId); } finally { lk.releaseLock(); }
      return json_(out);
    }
    const a = auth_(body, props, devId);
    if (!a.ok) return json_({ok: false, error: a.error, code: a.code});
    if (act === 'ping') { touch_(props, a, body, devId); return json_({ok: true, pong: true, proto: 3, admin: a.admin}); }
    if (act === 'newcode' || act === 'devices' || act === 'disable' || act === 'enable') {
      if (!a.admin) return json_({ok: false, error: 'العملية دي للمالك بس (الرمز الرئيسي)', code: 'FORBIDDEN'});
      const lk = LockService.getScriptLock();
      lk.waitLock(25000);
      try { out = handleAdmin_(act, body, props, devId); } finally { lk.releaseLock(); }
      return json_(out);
    }
    if (act !== 'sync' && act !== 'pull') return json_({ok: false, error: 'action غير معروف'});
    touch_(props, a, body, devId);
    const lock = LockService.getScriptLock();
    lock.waitLock(25000);                      // الرفع والسحب بنفس القفل: السحب عمره ما يشوف كتابة نص منتهية فيفوّت سجلات
    try { out = act === 'sync' ? handleSync_(body, devId) : handlePull_(body); } finally { lock.releaseLock(); }
  } catch (err) {
    out = {ok: false, error: String(err && err.message || err)};
    alertAdmin_(devId, [{opId: '', entity: '', error: out.error}]);
  }
  return json_(out);
}
// تفعيل جهاز بكود: من غير رمز — الكود نفسه هو الإثبات. 8 محاولات غلط ← قفل 10 دقايق.
function handleEnroll_(body, props, devId) {
  const now = Date.now();
  let f = {}; try { f = JSON.parse(props.getProperty('ENROLL_FAIL') || '{}') || {}; } catch (e) { f = {}; }
  if (f.until && f.until > now) return {ok: false, code: 'LOCKED', error: 'محاولات غلط كتير — جرّب بعد ' + Math.ceil((f.until - now) / 60000) + ' دقيقة'};
  if (!devId) return {ok: false, error: 'معرّف الجهاز غير صالح'};
  const codes = loadCodes_(props), h = sha_(normCode_(body.code)), c = codes[h];
  if (!c) {
    f.n = (f.t && now - f.t < 600000 ? (f.n || 0) : 0) + 1; f.t = now;
    if (f.n >= 8) { f.until = now + 600000; f.n = 0; }
    props.setProperty('ENROLL_FAIL', JSON.stringify(f));
    return {ok: false, code: 'BAD_CODE', error: 'كود التفعيل غلط أو منتهي'};
  }
  const old = getDev_(props, devId);
  if (old && old.st === 'ACTIVE' && old.kind === 'device') return {ok: false, code: 'EXISTS', error: 'الجهاز ده مسجّل ومفعّل بالفعل'};
  delete codes[h]; props.setProperty('CODES', JSON.stringify(codes)); props.deleteProperty('ENROLL_FAIL');
  const token = randCode_() + Utilities.getUuid().replace(/-/g, '') + randCode_();                   // 48 حرف
  putDev_(props, {id: devId, name: safeTxt_(body.devName, 30), kind: 'device', st: 'ACTIVE', th: sha_(token), created: now, seen: now, user: '', ver: safeTxt_(body.app, 12), label: c.label || ''});
  return {ok: true, token: token, device: devId};
}
function handleAdmin_(act, body, props, caller) {
  const now = Date.now();
  if (act === 'newcode') {
    const codes = loadCodes_(props);
    if (Object.keys(codes).length >= 10) return {ok: false, error: 'فيه 10 أكواد لسه ما اتستخدمتش — استخدمها أو استنى تنتهي'};
    const hours = Math.min(Math.max(Number(body.hours) || 24, 1), 72), code = randCode_();
    codes[sha_(code)] = {exp: now + hours * 3600000, label: safeTxt_(body.label, 30)};
    props.setProperty('CODES', JSON.stringify(codes));
    return {ok: true, code: code.slice(0, 4) + '-' + code.slice(4), expires: now + hours * 3600000, hours: hours};
  }
  if (act === 'devices') {
    const all = props.getProperties(), list = [];
    for (const k in all) if (k.indexOf('DEV:') === 0) { try { const r = JSON.parse(all[k]); list.push({id: r.id, name: r.name || '', kind: r.kind, st: r.st, seen: r.seen || 0, created: r.created || 0, user: r.user || '', ver: r.ver || '', label: r.label || '', online: r.st === 'ACTIVE' && now - (r.seen || 0) < ONLINE_MS, me: r.id === caller}); } catch (e) {} }
    list.sort(function (a, b) { return b.seen - a.seen; });
    return {ok: true, now: now, devices: list, codes: Object.keys(loadCodes_(props)).length};
  }
  const target = safeId_(body.target), rec = getDev_(props, target);
  if (!rec) return {ok: false, error: 'الجهاز مش موجود'};
  if (act === 'disable') {
    if (target === caller) return {ok: false, error: 'مينفعش توقف الجهاز اللي انت شغال عليه'};
    rec.st = 'DISABLED'; rec.offAt = now;
  } else { rec.st = 'ACTIVE'; delete rec.offAt; }
  putDev_(props, rec);
  return {ok: true, id: target, st: rec.st};
}
// تنبيه المدير: كل خطأ مزامنة بيتسجّل في ورقة sync_errors (الوقت، الجهاز، النوع، الخطأ، الحل المقترح) وبيتبعت إيميل للمدير على ADMIN_EMAIL (Script property).
// إيميل واحد كل 10 دقايق بالكتير (حد جوجل 100 يومياً). لو ADMIN_EMAIL مش متحدد: التسجيل في الورقة بس. أي فشل هنا ما بيوقّفش المزامنة نفسها.
function fixHint_(err) {
  const s = String(err || '');
  if (/كبير جداً/.test(s)) return 'سجل حجمه كبير: قلّل الوصف/الصور المضمّنة في السجل ده على الجهاز وأعد المزامنة.';
  if (/غير صالح/.test(s)) return 'التطبيق على الجهاز ده نسخته قديمة أو بيانات تالفة: افتح التطبيق وانت أونلاين وأعد تحميل الصفحة (Ctrl+F5) وبعدين «مزامنة الآن».';
  if (/Lock|lock|مشغول|Exceeded/.test(s)) return 'السيرفر كان مشغول أو عدّى حد جوجل: التطبيق بيعيد المحاولة لوحده، لو استمر استنى شوية.';
  return 'افتح «مركز المزامنة» على الجهاز المذكور وشوف العملية الفاشلة، وجرّب «مزامنة الآن». لو استمرت ابعت للمطوّر نص الخطأ.';
}
function alertAdmin_(dev, errs) {
  try {
    if (!errs || !errs.length) return;
    const ss = SpreadsheetApp.getActiveSpreadsheet(), now = new Date();
    const sh = ss.getSheetByName('sync_errors') || ss.insertSheet('sync_errors');
    if (sh.getLastRow() === 0) sh.appendRow(['الوقت', 'الجهاز', 'العملية', 'النوع', 'الخطأ', 'الحل المقترح']);
    errs.forEach(function (x) { sh.appendRow([now, esc_(dev), esc_(x.opId), esc_(x.entity), esc_(x.error).slice(0, 500), fixHint_(x.error)]); });   // كل نص جاي من جهاز بيتعقّم (حقن معادلات)
    const props = PropertiesService.getScriptProperties(), to = props.getProperty('ADMIN_EMAIL');
    if (!to || now.getTime() - Number(props.getProperty('LAST_ALERT') || 0) < 600000) return;
    const lines = errs.slice(0, 10).map(function (x, i) { return (i + 1) + ') ' + (x.entity ? '[' + esc_(x.entity) + '] ' : '') + esc_(x.error).slice(0, 300) + '\n   الحل: ' + fixHint_(x.error); });
    MailApp.sendEmail(to, 'تنبيه مزامنة — العراقي', 'حصل خطأ في المزامنة من الجهاز ' + (dev || '(غير معروف)') + ':\n\n' + lines.join('\n\n') + '\n\nالتفاصيل الكاملة في ورقة sync_errors في الشيت.');
    props.setProperty('LAST_ALERT', String(now.getTime()));
  } catch (e) { /* التنبيه مش لازم يكسر المزامنة */ }
}
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

// ================= الرفع =================
function handleSync_(body, dev) {
  const ss = SpreadsheetApp.getActiveSpreadsheet(), tabs = {}, results = [], props = PropertiesService.getScriptProperties();
  const errs = [], nowMs = Date.now();
  let seq = loadSeq_(ss, props), clamped = 0, nItems = 0;
  const ops = Array.isArray(body.ops) ? body.ops : [];
  if (ops.length > MAX_OPS) return {ok: false, error: 'عدد العمليات في الطلب كبير جداً'};
  for (const op of ops) {
    let bad = '';
    const prep = [];
    for (const it of op.items || []) {
      if (++nItems > MAX_ITEMS_REQ) { bad = 'عدد السجلات في الطلب كبير جداً'; break; }
      if (!it || !KEYS[it.entity] || it.key == null || !it.data || typeof it.data !== 'object' || Array.isArray(it.data) || String(it.key).length > 120 || /[\u0000-\u001f]/.test(String(it.key)) || String(it.data[KEYS[it.entity]]) !== String(it.key)) { bad = 'عنصر غير صالح: ' + safeTxt_(it && it.entity, 30); break; }
      const ua = Date.parse(it.data.UpdatedAt);                                  // ساعة جهاز متقدمة: نثبّتها على وقت السيرفر عشان سجل بتاريخ مستقبلي ما يكسبش «الأحدث يكسب» للأبد
      if (!isNaN(ua) && ua > nowMs + 300000) { it.data.UpdatedAt = new Date(nowMs).toISOString(); clamped++; }
      const json = JSON.stringify(clean_(it.data));
      if (json.length > CHUNK * MAX_CHUNKS) { bad = 'السجل كبير جداً (' + it.entity + ')'; break; }
      prep.push({it: it, json: json});
    }
    if (bad) { results.push({opId: op.opId, ok: false, permanent: true, error: bad}); errs.push({opId: op.opId, entity: (op.items && op.items[0] && op.items[0].entity) || '', error: bad}); continue; }
    if (!prep.length) { results.push({opId: op.opId, ok: true}); continue; }
    const main = prep[0].it;
    // «الأحدث يكسب»: لو السجل الأساسي أقدم من اللي في الشيت نتجاهل العملية كلها (ومعاها توابعها) — ونرد ok عشان الجهاز يسحب النسخة الأحدث
    const incomingFinal = !!FINAL_STATUS[main.entity] && String(main.data.Status || '') === FINAL_STATUS[main.entity];   // الإلغاء بيكسب حتى لو UpdatedAt بتاعه أقدم من تعديل متأخر
    if (!incomingFinal && POLICY[main.entity] === 'lww' && curUpd_(tab_(ss, tabs, main.entity), String(main.key)) > updOf_(main.data)) {
      results.push({opId: op.opId, ok: true, stale: true, current: current_(tab_(ss, tabs, main.entity), String(main.key), main.entity)}); continue;   // current: النسخة الأحدث اللي عند السيرفر — الجهاز يطبّقها فورًا (مش مستني السحب)
    }
    // الإلغاء نهائي: عملية على سجل ملغي بالفعل (تعديل/إلغاء تاني) بتترفض هي وتوابعها (حركاتها وبنودها). locked بتخلّي الجهاز يعرف إن النسخة الملغاة هي اللي ماشية.
    if (FINAL_STATUS[main.entity] && curStatus_(tab_(ss, tabs, main.entity), String(main.key)) === FINAL_STATUS[main.entity]) {
      results.push({opId: op.opId, ok: true, stale: true, locked: FINAL_STATUS[main.entity], current: current_(tab_(ss, tabs, main.entity), String(main.key), main.entity)}); continue;
    }
    for (const p of prep) {
      const it = p.it, t = tab_(ss, tabs, it.entity), k = String(it.key), pol = POLICY[it.entity], u = updOf_(it.data);
      if (pol === 'once' && exists_(t, k)) continue;
      if (pol === 'lww' && p !== prep[0] && curUpd_(t, k) > u) continue;
      const chunks = [];
      for (let i = 0; i < p.json.length; i += CHUNK) chunks.push('J' + p.json.slice(i, i + CHUNK));   // حرف J في الأول عشان شيتس ما تحوّلش الجزء لرقم/معادلة
      t.dirty[k] = {data: it.data, seq: ++seq, upd: u, dev: dev, chunks: chunks};                       // آخر لقطة لنفس المفتاح بتكسب
    }
    results.push({opId: op.opId, ok: true});
  }
  props.setProperty('SEQ', String(seq));        // الأول نثبّت العدّاد وبعدين نكتب: لو الكتابة وقعت في النص، الأرقام اللي اتصرفت ما بتتكررش (الفجوات مش مشكلة)
  for (const name in tabs) flush_(tabs[name]);
  alertAdmin_(dev, errs);
  props.setProperty('COMMITTED', String(seq));   // Commit Marker: آخر رقم اتكتب بالكامل. السحب مبيطلّعش أي حاجة فوقه، فكتابة اتقطعت في النص ما بتظهرش للأجهزة التانية
  return {ok: true, results: results, clamped: clamped};
}
// نسخة السجل الحالية عند السيرفر (للرد على stale)
function current_(t, k, entity) {
  let data = null;
  if (t.dirty[k]) data = t.dirty[k].data;
  else {
    const r = t.rows[k];
    if (!r || !t.hadCols) return null;
    const row = t.sh.getRange(r, 1, 1, t.hadCols).getValues()[0];
    let txt = '';
    for (let i = 0; i < MAX_CHUNKS; i++) { const c = t.headers.indexOf('_j' + i); if (c < 0 || c >= t.hadCols) break; const v = row[c]; if (v === '' || v == null) break; txt += String(v).slice(1); }
    if (!txt || txt.length > 150000) return null;
    try { data = JSON.parse(txt); } catch (e) { return null; }
  }
  return data ? {entity: entity, key: k, data: clean_(data)} : null;
}
// العدّاد العالمي: لو الخاصية ضاعت أو اتمسحت، بنرجّعه لأعلى _srv موجود فعلاً في الشيتات (بدل ما يبدأ من صفر ويكرر أرقام).
function loadSeq_(ss, props) {
  const v = props.getProperty('SEQ');
  if (v !== null && v !== '' && !isNaN(Number(v))) return Number(v);
  let max = 0;
  for (const entity in KEYS) {
    const sh = ss.getSheetByName(entity);
    if (!sh) continue;
    const lr = sh.getLastRow(), lc = sh.getLastColumn();
    if (lr < 2 || !lc) continue;
    const c = sh.getRange(1, 1, 1, lc).getValues()[0].map(String).indexOf('_srv');
    if (c < 0) continue;
    sh.getRange(2, c + 1, lr - 1, 1).getValues().forEach(function (r) { const n = Number(r[0]); if (n > max) max = n; });
  }
  props.setProperty('SEQ', String(max));
  return max;
}
function loadCommitted_(ss, props) {                                 // أول مرة (قبل الترقية): COMMITTED = SEQ الحالي
  const v = props.getProperty('COMMITTED');
  if (v !== null && v !== '' && !isNaN(Number(v))) return Number(v);
  const s = loadSeq_(ss, props);
  props.setProperty('COMMITTED', String(s));
  return s;
}
function curStatus_(t, k) {                                         // Status الحالي في الشيت (أو اللي اتجهّز في نفس الدفعة). '' = مش موجود
  if (t.dirty[k]) return String(t.dirty[k].data && t.dirty[k].data.Status || '');
  const r = t.rows[k];
  if (!r) return '';
  return String(colVals_(t, 'Status')[r - 2] || '');
}
function updOf_(d) { const t = Date.parse(d && d.UpdatedAt); return isNaN(t) ? 0 : t; }
function tab_(ss, tabs, entity) {
  if (tabs[entity]) return tabs[entity];
  const sh = ss.getSheetByName(entity) || ss.insertSheet(entity), keyName = KEYS[entity];
  const lastCol = sh.getLastColumn(), lastRow = sh.getLastRow();
  const headers = lastCol ? sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String) : [];
  if (headers.indexOf(keyName) < 0) headers.unshift(keyName);       // ورقة جديدة: عمود المفتاح أول عمود
  SYS_COLS.forEach(function (c) { if (headers.indexOf(c) < 0) headers.push(c); });
  const rows = {};
  if (lastRow > 1 && lastCol) {
    const kc = headers.indexOf(keyName) + 1;
    if (kc <= lastCol) sh.getRange(2, kc, lastRow - 1, 1).getValues().forEach(function (r, i) { rows[String(r[0])] = i + 2; });
  }
  if (!lastCol) sh.getRange(1, 1, sh.getMaxRows(), 1).setNumberFormat('@');   // ورقة جديدة: عمود المفتاح نص صريح (مفاتيح زي 0012 ما تتحوّلش لرقم)
  return (tabs[entity] = {sh: sh, keyName: keyName, headers: headers, rows: rows, dirty: {}, lastRow: Math.max(lastRow, 1), hadCols: lastCol, cache: {}});
}
function colVals_(t, name) {                                         // قيم عمود نظام (مصفوفة بترتيب الصفوف من 2) — بتتقرا مرة واحدة
  if (t.cache[name]) return t.cache[name];
  const i = t.headers.indexOf(name);
  let v = [];
  if (i >= 0 && i < t.hadCols && t.lastRow > 1) v = t.sh.getRange(2, i + 1, t.lastRow - 1, 1).getValues().map(function (x) { return x[0]; });
  return (t.cache[name] = v);
}
function curUpd_(t, k) {                                             // UpdatedAt الحالي في الشيت (أو اللي اتجهّز في نفس الدفعة). -1 = مش موجود
  if (t.dirty[k]) return t.dirty[k].upd;
  const r = t.rows[k];
  if (!r) return -1;
  return Number(colVals_(t, '_upd')[r - 2]) || 0;
}
function exists_(t, k) {                                             // موجود ومتخزّن بنظام v14.1 (فيه _srv)؟ الصفوف القديمة بتتكتب تاني
  if (t.dirty[k]) return true;
  const r = t.rows[k];
  return !!r && Number(colVals_(t, '_srv')[r - 2]) > 0;
}
function flat_(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(clean_(v)).slice(0, 45000);
  if (typeof v === 'string') return esc_(v).slice(0, 45000);
  return v;
}
function clean_(v) {
  if (Array.isArray(v)) return v.map(clean_);
  if (v && typeof v === 'object') { const o = {}; for (const k in v) if (!SECRET.test(k)) o[k] = clean_(v[k]); return o; }
  return v;
}
function ensureSize_(sh, rows, cols) {
  if (sh.getMaxRows() < rows) sh.insertRowsAfter(sh.getMaxRows(), rows - sh.getMaxRows());
  if (sh.getMaxColumns() < cols) sh.insertColumnsAfter(sh.getMaxColumns(), cols - sh.getMaxColumns());
}
function flush_(t) {
  const keys = Object.keys(t.dirty);
  if (!keys.length) return;
  keys.forEach(function (k) {                                         // أعمدة جديدة (حقول اتضافت في التطبيق + أجزاء الـ JSON) بتتضاف في الآخر
    const d = t.dirty[k];
    for (const f in d.data) if (FIELD_RE.test(f) && !SECRET.test(f) && t.headers.length < MAX_COLS && t.headers.indexOf(f) < 0) t.headers.push(f);   // أسماء أعمدة آمنة وعدد محدود (الباقي محفوظ كامل في _j)
    for (let i = 0; i < d.chunks.length; i++) if (t.headers.indexOf('_j' + i) < 0) t.headers.push('_j' + i);   // أجزاء الـ JSON (حد أقصى 8) مستثناة من حد الأعمدة
  });
  const H = t.headers.length;
  const toRow = function (k) {
    const d = t.dirty[k], o = Object.assign({}, d.data); o[t.keyName] = k;
    return t.headers.map(function (h) {
      if (h === '_srv') return d.seq;
      if (h === '_upd') return d.upd;
      if (h === '_dev') return esc_(d.dev);
      if (/^_j\d+$/.test(h)) { const i = Number(h.slice(2)); return d.chunks[i] !== undefined ? d.chunks[i] : ''; }
      return flat_(o[h]);
    });
  };
  const updates = [], appends = [];
  keys.forEach(function (k) {
    if (t.rows[k]) updates.push({r: t.rows[k], v: toRow(k)}); else appends.push(toRow(k));
  });
  ensureSize_(t.sh, t.lastRow + appends.length, H);
  t.sh.getRange(1, 1, 1, H).setValues([t.headers]).setFontWeight('bold');
  updates.sort(function (a, b) { return a.r - b.r; });
  for (let i = 0; i < updates.length;) {                              // الصفوف المتتالية بتتكتب بنداء واحد (إعادة الرفع الكبيرة مش بتبطّأ)
    let j = i;
    while (j + 1 < updates.length && updates[j + 1].r === updates[j].r + 1) j++;
    t.sh.getRange(updates[i].r, 1, j - i + 1, H).setValues(updates.slice(i, j + 1).map(function (u) { return u.v; }));
    i = j + 1;
  }
  if (appends.length) t.sh.getRange(t.lastRow + 1, 1, appends.length, H).setValues(appends);
}

// ================= السحب =================
// body: {cursor, limit}. بيرجّع السجلات اللي _srv بتاعها > cursor بترتيب _srv، ومعاها cursor الجديد (آخر _srv اتبعت) و more لو لسه فيه.
function handlePull_(body) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const cursor = Number(body.cursor) || 0, limit = Math.min(Math.max(Number(body.limit) || PULL_LIMIT, 1), PULL_LIMIT);
  const top = loadCommitted_(ss, PropertiesService.getScriptProperties());
  if (cursor > top) return {ok: true, items: [], cursor: 0, more: true, reset: true, top: top};   // الجهاز عنده موضع أكبر من السيرفر (الشيت اتبدّل) → يبدأ من الأول
  if (cursor === top) return {ok: true, items: [], cursor: cursor, more: false, top: top};          // مفيش جديد — من غير ما نقرا أي ورقة
  const cands = [], metas = {};
  for (const entity in KEYS) {
    const sh = ss.getSheetByName(entity);
    if (!sh) continue;
    const lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
    if (lastRow < 2 || !lastCol) continue;
    const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
    const sc = headers.indexOf('_srv');
    if (sc < 0) continue;
    const jcols = [];
    for (let i = 0; i < MAX_CHUNKS; i++) { const c = headers.indexOf('_j' + i); if (c < 0) break; jcols.push(c + 1); }
    if (!jcols.length) continue;
    metas[entity] = {sh: sh, jcols: jcols};
    const vals = sh.getRange(2, sc + 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < vals.length; i++) { const v = Number(vals[i][0]); if (v > cursor && v <= top) cands.push({e: entity, r: i + 2, s: v}); }
  }
  cands.sort(function (a, b) { return a.s - b.s; });
  const page = cands.slice(0, limit), byE = {};
  page.forEach(function (c) { (byE[c.e] = byE[c.e] || []).push(c.r); });
  const cells = {};                                                   // entity -> chunkIndex -> row -> text
  for (const e in byE) {
    const rows = byE[e].sort(function (a, b) { return a - b; });
    cells[e] = metas[e].jcols.map(function (col) { return readCells_(metas[e].sh, col, rows); });
  }
  const items = [];
  let size = 0, last = cursor, cut = false;
  for (const c of page) {
    let txt = '';
    for (let i = 0; i < cells[c.e].length; i++) {
      const v = cells[c.e][i][c.r];
      if (v === '' || v == null) break;
      txt += String(v).slice(1);
    }
    if (size + txt.length > PULL_BYTES && items.length) { cut = true; break; }
    size += txt.length; last = c.s;
    let data = null;
    try { data = JSON.parse(txt); } catch (err) { data = null; }      // صف تالف/قديم: بنعدّي عليه (الـ cursor بيتقدّم)
    if (data && data[KEYS[c.e]] != null) items.push({entity: c.e, key: String(data[KEYS[c.e]]), seq: c.s, data: data});
  }
  const included = cut ? items.length : page.length;
  return {ok: true, items: items, cursor: last, more: cut || cands.length > page.length, top: top, n: included};
}
function readCells_(sh, col, rows) {                                  // rows مرتبة وبدون تكرار → {row: value}، بنقرا الصفوف المتتالية بنداء واحد
  const out = {};
  if (!rows.length) return out;
  const runs = [];
  let a = rows[0], b = a;
  for (let i = 1; i < rows.length; i++) { if (rows[i] === b + 1) b = rows[i]; else { runs.push([a, b]); a = b = rows[i]; } }
  runs.push([a, b]);
  if (runs.length > 20) {
    const lo = rows[0], hi = rows[rows.length - 1], v = sh.getRange(lo, col, hi - lo + 1, 1).getValues();
    rows.forEach(function (r) { out[r] = v[r - lo][0]; });
    return out;
  }
  runs.forEach(function (rn) {
    const v = sh.getRange(rn[0], col, rn[1] - rn[0] + 1, 1).getValues();
    for (let i = 0; i < v.length; i++) out[rn[0] + i] = v[i][0];
  });
  return out;
}
