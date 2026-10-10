# HANDOVER — AL-IRAQI Internal Business App (offline-first PWA)
Last updated: 2026-10-10 (بعد الجلسة اللي فيها: الكاميرا اشتغلت + زرار المساعدة + شاشة الفواتير + محرك A4).
Owner's language: Egyptian Arabic (الرد بالعربي المصري؛ تعليقات الكود عربي مسموح، identifiers إنجليزي).
مهم للشات الجديد: الملفات الأصلية `app.js` و`auth.js` و`ui.js` و`products.js` و`css/app.css` **ماوصلتش في الجلسة الأخيرة** — لازم المالك يرفعها قبل ما نوصّل الفواتير بالشاشة الرئيسية (الخطوة 1 في الجزء 6).

## 1. السياق (بلسان المالك كريم)
- الشركة: AL-IRAQI HOME APPLIANCES / العراقي للاستيراد وتجارة الأدوات المنزلية. تليفون/واتساب 01105236152. العنوان: 5 شارع سيد مازن، النزهة الجديدة، الهايكستب.
- جملة لتجار بيشتروا كراتين (والقطع ممكن). سعر الشيت افتراضي بس، والأسعار بتتعدل يدوي في الفاتورة.
- المخازن: مخزن فايز (WH-FAYEZ) ومخزن عزبة عمرو (WH-EZBET-AMR)، وعايز يضيف غيرهم.
- المستخدمين (Rank 1 أعلى): كريم OWNER / الحاج MANAGER / أحمد STAFF / نور STAFF. المالك يضيف/يشيل مستخدمين ويعدّل صلاحيات كل واحد. الدخول PIN (بصمة بعدين لو خفيفة).
- عايز: مرتجع (مرتجع فاتورة) + تعديل كميات فاتورة موجودة (زيادة/نقص) + فواتير بالمسح أو يدوي.
- الفاتورة: صفحات A4 زي المرجع `ALR-20261008-0002.pdf` (5 صفحات / 63 سطر). آخر صفحة: الإجماليات + بيانات الشركة. مش صورة طويلة واحدة.
- الموقع (منتج منفصل): https://shadow-aetherx.github.io/AIRAQI-STORE/ — التطبيق ليه ملف منتجات خاص بيه. المالك بيحدّث الأسعار والصور في Google Sheet بنفسه، والمنتجات الجديدة من غير سعر عن قصد.
- قواعد الداتا: الأكواد اللي إكسل حوّلها تواريخ كانت بأصفار (02-02, 09-08A)؛ "OO93" = 0093؛ الأكواد الغريبة (حرف صيني، مسافات، كلمات زي خلاط/باسكت) مقصودة؛ الأكواد المكررة مشروعة؛ 99-6/99-7/99-8 أصناف مختلفة؛ أصناف المقابض/المسامير (42-x) الـ11 اتشالت. **ماتغيّرش داتا تجارية بصمت، واحتفظ بالأصل.**
- **قرار سعر القطعة السايبة (اتحسم):** سعر القطعة = عمود `carton_unit_price` من الشيت (من غير زيادة). عمود `Base Price` (فيه +15% للقطاعي) **مش بنستخدمه** في التطبيق. سعر الكرتونة = سعر القطعة × عدد القطع (نفس معادلة الشيت). تأكدنا: `PricePiece` في products.json = carton_unit_price لكل الـ239 صنف المسعّرين. (الفاتورة المرجعية كانت 35 للقطعة = Base Price — الفواتير الجديدة هتنزل 30.)

## 2. الأولويات والمواصفات
أولوية القرار: سلامة البيانات > الأوفلاين > دقة المخزون > الأمان > موثوقية المزامنة > عدم تكرار/ضياع العمليات > الموبايل > الأداء > جودة الفاتورة > الشكل > الصيانة. البرومبت الأصلي للمالك (52 قسم) هو المواصفة الحاكمة (offline-first، دفتر حركات مش CurrentStock، multi-warehouse، أدوار وصلاحيات، audit، ترقيم A4، Google Sheets+Apps Script، بدون خدمات مدفوعة...).

## 3. الوضع الحالي — اللي اتعمل واتختبر
### مختبر على أجهزة حقيقية (قال المالك)
- مسح الكاميرا/QR اشتغل 100% على الموبايل واللابتوب (بعد فك حظر الأذونات من إعدادات النظام). jsQR محلي في `js/jsQR.js`.
- سبب أعطال الكاميرا اللي اتشافت: الإذن متحجب للموقع (مفيش نافذة طلب إذن) + ملف قديم في الكاش. اتعالج بـ`scanner.js v6` (تشخيص ظاهر على الشاشة) و`sw.js v6` (`no-cache` للملفات).
### مختبر في Chromium headless (Playwright، سيرفر python http.server على localhost، كاميرا وهمية)
- الكاميرا: مسار الموافقة (فيديو 1280×720) ومسار الرفض بالتشخيص. (قبل كده: login، 368 منتج، بحث عربي، استلام/صرف، منع الصرف الزيادة، atomic abort، أوفلاين، Tab بين الخانات.)
- الفواتير (اختبار الجلسة دي): اختيار عميل → مخزن → إضافة صنف بالكود/Enter (تجميع المسح المتكرر) → تعديل السعر → حفظ. اتأكد: رقم الفاتورة `ALR-YYYYMMDD-<DEVICE>-NNNN`، حركات STOCK_OUT سالبة بـReferenceID=InvoiceID، `OriginalUnitPrice` و`PriceChanged` بيتسجلوا، الإجمالي صح، صفحة العرض بتولّد PDF + صور. صفحة A4 اتعاينت بالعين: العربي والـBiDi ("براد 2.5 لتر") سليم، تفاف أسماء طويلة، الأعمدة الفاضية بتختفي، سعر الكرتونة بيحل محل سعر القطعة لو الفاتورة كراتين بس.
- ترقيم الصفحات (3 / 12 / 22 / 26 / 27 / 28 / 45 / 63 صف): الصف ما بيتقسمش، العنوان بيتكرر، آخر صفحة ≥3 صفوف + الإجماليات + بيانات الشركة. PDF صحيح (A4، pdf-lib، الصفحات JPEG).
- زرار المساعدة (؟): مخفي في أول تحميل، بيظهر بعد ما الشاشة تبقى مش شاشة دخول، والنافذة فيها 3 أقسام.
### لسه ما اتختبرش
- **الفواتير على أجهزة حقيقية** (الطباعة/المشاركة على واتساب: `navigator.share` بملفات؛ على الأجهزة اللي مش بتدعمه بيتحمّل الملف).
- زرار المساعدة بالـapp.js الحقيقي (ظهوره/اختفاؤه بيعتمد على إن شاشة الدخول فيها class `login`).
- تحديث الـSW على الموبايلات، كاش الصور أوفلاين، الصلاحيات الحقيقية (`can`) — الاختبار استخدم stubs.
- الاتصال الفعلي بين `showInvoices`/`showCustomers` والشاشة الرئيسية (مش موصّل لسه — الجزء 6).

## 4. ملفات المشروع ومساراتها على GitHub (جذر الموقع = `aliraqi-app/`)
**ارفع/استبدل (جديد أو متغيّر في الجلسة دي):**
| المسار | الحالة |
|---|---|
| `index.html` | معدّل (ربط `css/invoice.css` و`js/help.js`) |
| `sw.js` | معدّل (VER v6، `no-cache`، ملفات الفواتير في الكاش، pdf-lib والخطوط اختيارية) |
| `css/invoice.css` | **جديد** |
| `js/scanner.js` | معدّل (v6) |
| `js/invoices.js` | **جديد** — إنشاء/قائمة/عرض فاتورة + `postInvoice` |
| `js/invoice-pdf.js` | **جديد** — محرك A4 (canvas + pdf-lib) |
| `js/help.js` | **جديد** — زرار ؟ والدليل |
| `HANDOVER.md` | الوثيقة دي (ممكن تتحط في الجذر) |

**لازم تكون موجودة بالأسماء دي بالظبط (المالك رفعها):**
- `js/jsQR.js` · `js/pdf-lib.min.js` (مش `pdf-lib_min.js`) · `pdf-lib.LICENSE.md` · `README.txt` · `fonts/invoice-regular.ttf` · `fonts/invoice-bold.ttf`
- خطوط/مكتبات اتذكرت ومش مطلوبة دلوقتي (محرك الفواتير بيرسم بـcanvas مش بيحتاجها): `jspdf.umd.min.js`, `fontawesome-free.js`, `cairo-regular.js`, `amiri-regular.js`, `arabic-font.js`.
**ملفات سابقة ما اتغيّرتش:** `manifest.json`, `icon.svg`, `products.json`, `css/app.css`, `js/db.js`, `js/auth.js`, `js/ui.js`, `js/products.js`, `js/stock.js`, `js/customers.js` (موجود فعلاً ومكتمل: بحث/إضافة/تعديل/إيقاف + `pickCustomer`)، `js/app.js` (**ينقصه التوصيل**).
⚠ `sw.js` بيثبّت الملفات الأساسية بـ`cache.addAll` — لو أي ملف من CORE ناقص على GitHub (مثلاً `js/jsQR.js` أو `js/invoices.js`) التثبيت بيفشل. CORE: `./, index.html, manifest.json, icon.svg, products.json, css/app.css, css/invoice.css, js/{db,auth,ui,products,stock,scanner,customers,invoices,invoice-pdf,help,app,jsQR}.js`.

## 5. تفاصيل التنفيذ (للشات الجديد)
- **db.js** (DB_VER=2): stores: products, customers, warehouses, invoices(idx CustomerID, DateTime), invoice_lines(idx InvoiceID, ProductID), movements(idx ProductID, WarehouseID, ReferenceID), users, roles, audit, syncq(idx Status), settings(keyPath `key`). Helpers: get/all/byIndex/put, uuid, nowISO, deviceId (`alr_device`, شكل `D-XXXXXX`), `postStockDoc`, `stockMap`, `toPieces`, `txRun(stores,fn(t,fail,setOut))`, `ymd`.
- **الفاتورة (invoices.js)**: `postInvoice({customer,warehouseId,items,user,notes,allowNegative})` معاملة واحدة تكتب: invoices + invoice_lines + movements (STOCK_OUT، سالب) + syncq + audit (`INVOICE_CREATE`) + عدّاد الترقيم في settings (`invseq:<dev>:<ymd>`). فحص الرصيد جوه المعاملة؛ لو صنف ناقص → `INSUFFICIENT` وماينكتبش حاجة (إلا لو `OverrideStock` + checkbox التجاوز).
  - Invoice: InvoiceID(uuid), Number, DateTime, CustomerID/Name/Phone/Address (snapshot), WarehouseID, Status='POSTED', Version=1, Total, ItemsCount, TotalPieces, Notes (داخلية، ما بتظهرش في PDF), UserID/UserName, DeviceID, SyncStatus.
  - Line: LineID, InvoiceID, LineNo, ProductID, Code, Name (snapshot), Cartons, Pieces, PcsPerCarton, TotalPieces, **OriginalUnitPrice** (PricePiece وقت البيع), **UnitPrice** (المستخدم، لكل قطعة), PriceChanged, LineTotal. السعر الأصلي للمنتج ما بيتغيرش أبداً.
  - صلاحيات مستخدمة (من auth.js): `CreateInvoice`, `EditCustomers`, `OverridePrice` (تعديل السعر + بيع صنف من غير سعر)، `OverrideStock`. الصنف من غير سعر ومفيش `OverridePrice` → ما بيتضافش.
  - الشاشات: `showInvoiceNew(user,onBack,{customer})`، `showInvoices(user,onBack)`، `showInvoiceView(user,invoiceId,onBack,{fresh})`. المسح: `scanner.js` (BarcodeDetector لو موجود، وإلا jsQR) — QR = كود الصنف بس (بادئة اختيارية `ALIRAQI-PRODUCT-`).
- **invoice-pdf.js**: `renderInvoicePages`, `buildInvoiceFiles(inv,lines)` → `{pdf:Blob, images:[JPEG Blob], pages}`، `paginate`, `layoutInvoice`, `columnsFor`, `COMPANY` (بيانات الشركة ثابتة في أعلى الملف). بيرسم بـcanvas 200DPI (1654×2339) لأن pdf-lib مفيهوش تشكيل عربي وfontkit مش موجود؛ المتصفح بيعمل الـshaping والـBiDi. الخط من `fonts/invoice-*.ttf` (DejaVu، عربي+لاتيني) بيتحمّل بـFontFace من الـfetch (يتكاش أوفلاين). الفاتورة للعميل ما فيهاش: الموظف، السعر الأصلي، التكلفة، الهامش، الـaudit.
- **scanner.js v6**: `scannerSupport()` ('native' | 'jsqr' | null)، `openScanner(onCode)` (onCode يرجّع `{status:'ok'|'unknown'|'multi',label}`)، بيطلب الكاميرا أول حاجة، والشاشة بتفضل مفتوحة عند الفشل مع سطر تشخيص (`scanner v6 · mode · ErrorName · permission=…`) وزرار إعادة المحاولة. بيحتاج HTTPS.
- **help.js**: بيشتغل لوحده من index.html (`<script type="module" src="js/help.js">`). الزرار fixed أعلى-شمال. ظهور تلقائي بمراقبة `#app` (مخفي لو فيه `.login` غير `.done`). تحكم يدوي: `setHelpVisible(bool)`, `openHelp()`.
- **sw.js v6**: same-origin = network-first بـ`fetch(req,{cache:'no-cache'})` + مهلة 3 ثواني ثم الكاش؛ صور من origin تاني تتكاش عند أول عرض لو CORS سمح؛ **ما بيلمسش IndexedDB**.

## 6. الخطوات المتبقية بالترتيب
1. **توصيل الشاشات بالـdashboard (محتاج `app.js`)**: المالك يرفع `app.js` (+`auth.js`, `ui.js`, `products.js`, `css/app.css`). التوصيل المتوقع:
   ```js
   import {showInvoices,showInvoiceNew} from './invoices.js';
   import {showCustomers} from './customers.js';
   // تايل «الفواتير»  → showInvoices(user, home)
   // تايل «العملاء»   → showCustomers(user, home, c => showInvoiceNew(user, home, {customer:c}))
   // الزرار الكبير «فاتورة جديدة» → showInvoiceNew(user, home)
   ```
   (`home` = دالة الرجوع للرئيسية.) وتأكد إن الصلاحيات `CreateInvoice/EditCustomers/OverridePrice` موجودة في PERMS وفي الأدوار.
2. اختبار الفواتير على أجهزة حقيقية (أيفون + أندرويد + لابتوب) بما فيها المشاركة على واتساب والطباعة والأوفلاين.
3. **مرتجع + تعديل كميات**: الفاتورة الأصلية ثابتة (immutable)؛ مستندات مرتبطة (Return/Adjustment) بـ`ParentInvoiceID` + حركات دفتر (`RETURN` أو `STOCK_OUT/IN` للفرق)؛ عرض آخر نسخة وسجل التاريخ في audit؛ `Version` موجود بالفعل.
4. تحويلات بين المخازن (TRANSFER_OUT + TRANSFER_IN بنفس TransferID)، تسويات، واجهة إضافة مخزن.
5. واجهة المستخدمين/الأدوار/الصلاحيات (قاعدة الـrank؛ المالك فقط يعدّل المالك). صلاحيات STAFF الحالية فيها OverrideStock/OverridePrice — المالك يقرر؛ ولازم role-version migration قبل تغيير الافتراضيات.
6. المزامنة: Google Apps Script + Google Sheet **خاص** (قالب `AlIraqi_Master_Sheet_Template.xlsx`: Products, Customers, Warehouses, InventoryMovements, Invoices, Users, Roles, Permissions, AuditLog, Devices, SyncLog, Settings)، idempotent بالـUUID، فحص صلاحيات في السيرفر، التكلفة/الهامش ما تتبعتش لأجهزة المخزن، حدود/كوتة Apps Script بصراحة، رفع PDF لـDrive.
7. **أمان**: GitHub Pages عام → `products.json` (والأسعار) قابلة للقراءة. الأفضل مزامنة الأسعار من الشيت الخاص عبر Apps Script. (الفحص المحلي للصلاحيات UI فقط، الإنفاذ الحقيقي في السيرفر.)
8. متفرقات: حفظ مسودة الفاتورة/الاستلام أثناء الكتابة، خصم/ملاحظة على الفاتورة (مش مطلوب لسه)، تعديل المنتجات من التطبيق، حد كاش الصور وخيار «تنزيل كل الصور»، توحيد تهجئة البحث (ترمس/تورمس)، حفظ بيانات الشركة في settings بدل الثابت.

## 7. حدود معروفة
- ترقيم الفاتورة `ALR-YYYYMMDD-<DEVICE>-NNNN`: العدّاد محلي لكل جهاز/يوم (مش بيتصفّر لو اتمسحت بيانات المتصفح؛ الـDeviceID ساعتها بيتغيّر فمفيش تعارض).
- الفاتورة بعد الحفظ بتتولّد صورها/PDF عند الفتح (مش متخزنة)؛ لو الخط ناقص من `fonts/` التوليد بيفشل برسالة واضحة.
- كل الفواتير ظاهرة لأي مستخدم مسجّل (مفيش صلاحية عرض منفصلة لسه).
- التواريخ بتتعرض بتوقيت الجهاز.

## 8. قواعد العمل للمساعد
حلّل قبل ما تغيّر داتا، اشرح التحويلات أولاً، ماتمسحش الأصول، مفيش أسرار في الـfrontend، مفيش `innerHTML` (استخدم `el()`)، مفيش CurrentStock كحقيقة وحيدة، الموثوقية > الشكل، اختبر في Chromium headless قبل ما تقول إن حاجة شغالة، وادّي المالك قايمة الملفات بالمسارات (بيرفعها يدوي على GitHub Pages من واجهة الويب). الرد بالعربي المصري.
