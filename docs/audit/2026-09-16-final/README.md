# تداوي | TADAWEE — التدقيق النهائي وفرع الإصلاح

**حالة الإصدار: BLOCKED.** توجد إصلاحات فعلية واختبارات PostgreSQL حقيقية، لكن توافق الإنتاج واختبار الهاتف الأساسي لم يُعتمدا. لا يعني نجاح CI جاهزية الهاتف أو المتجر. لم يُنفَّذ دمج أو نشر أو ترحيل إنتاجي أو إجراء على جرعة مريض أو إرسال تنبيه لشخص حقيقي.

الفرع `audit/final-tadawee-20260916` و[PR #30](https://github.com/NAIFMUSFER/dawaee/pull/30). بدأ العمل من PR #29 عند `ac44deb05b083520e7bd66d171849a611c2e424e` ، بما فيه إصلاحات PR26/27 اللاحقة وربط المرافق برقم موثّق. روجع PR #28 منفصلًا؛ لا يُستبدل المشروع الحديث بالـ legacy hotfix. كل تغييرات PR29 محفوظة في تاريخ هذا الفرع. لم توجد تعليمات AGENTS إضافية في المستودع المفحوص.

- [مصفوفة الرحلات والأجهزة وصورة قبل الإصلاح](MATRIX.md)
- [عقود الطلبات: 83 موضع استدعاء مستخرجًا من الكود](REQUESTS.md)
- [الكتالوج المقروء فعليًا](catalog-readonly.json) و[استعلامات فحص غير معدِّلة](preflight-readonly.sql)
- [ترتيب النشر والتوافق والتراجع وقبول الهاتف](ROLLOUT.md)

## الحالة الفعلية — 16 سبتمبر 2026 UTC

| المكوّن | الدليل المحدد | النتيجة |
| --- | --- | --- |
| main وقت البدء | `07bf101c8a4720dc74d55de37b0dcb825c7841e5` | PASS تحديد المصدر؛ لا يطابق الإنتاج |
| API المنشور | `/version` و Render deploy `dep-dal7m1tg1s2s73egvnf0` ، اكتمال 11:19:29 ، SHA `60b474ea81105529c16f88d5b878c5c274c7b03b` | PASS تحديد النسخة؛ schema المُعلن 0033 ليس وصفًا للكتالوج الكامل |
| readiness API |13:04:37: ready ، production ، database ok ، Google Vision/R2/Expo configured ، no mocked integrations | PASS جاهزية الفحص المحدود؛ لا يثبت وصول R2/Vision أو نجاح معاملة جرعة |
| العامل المنشور | deploy `dep-dai8atfqj5pc739j2vu0` ، SHA `0338ddefc475d23cccecf13d5ede0f32d2007fb0` | FAIL عدم توحيد النسخ؛ آخر محاولة main انتهت `pre_deploy_failed` |
| سجل العامل |11:52:28 و 12:52:29: housekeeping/uploads ، SQLSTATE42501 ، permission denied for stored_objects | FAIL مثبت بسجل؛ العامل القديم يستعمل الجدول مباشرة بعد سحب الصلاحية. المرشح يستعمل وظائف محدودة الغرض من 0039 ، دون توسيع الصلاحيات |
| Supabase باسم dawaee | مشروع `knkuxdfnfokqxbgnxzpe` ، PostgreSQL17.6 ، database postgres ؛ 77 migration rows حتى 0077 وآخرها 03:13:52 | PASS فحص catalog بالقراءة فقط؛ ربط اتصال Render بهذه القاعدة تحديدًا NOT VERIFIED لعدم قراءة أسرار الاتصال |
| فهارس المخزون والأحداث | `stock_tx_dose_event_idx` UNIQUE(dose_event_id) WHERE NOT NULL ؛ غياب الفهرس القديم `stock_tx_dose_idx` ؛ event/client key partial unique per-profile | PASS ؛ الأعمدة والقيود تمت مراجعتها مباشرة. الفحص اللاحق يجب أن يشمل `indisvalid/indisready` وتعريف القيد، لا الاسم فقط |
| Render PostgreSQL المرئي | PG16 وخدمة معاينة PG17 موجودان أيضًا؛ استعلام الموصل رفض اتصال TLS | BLOCKED لهذا المسار؛ لا تُدمج هويتهما مع Supabase افتراضيًا |
| APK المذكور في PR29 | EAS `52047e47-114f-4257-a942-edee319379fc` من ac44deb ، versionCode4 | NOT VERIFIED أنه التطبيق المثبت لدى المستخدم. المرشح يُعد versionCode5 ؛ لم يُثبت على جهاز |
| صور المستخدم | IMG_0413: التطبيق؛ IMG_0414/0415: تعليقات تجمّد/قصّ؛ IMG_0416: انقطاع بث Codex | PASS قراءة الأدلة؛ commit الصور NOT VERIFIED ؛ لا تُنشر هوية الطرف الثالث في صور المحادثة |

## المشاكل حسب الأثر والإصلاحات

P0 خطر تضارب/فقد بيانات؛ P1 تعطّل رحلة أو إدخال ملتبس؛ P2 وضوح/أداء. النتائج أدناه تفصل إصلاح الكود عن تحقق الإنتاج.

| المشكلة / الدليل | الأولوية | السبب | الإصلاح وملفاته | الاختبار / النتيجة والمتبقي |
| --- | --- | --- | --- | --- |
| DATA-01:404 للتأكيد ثم 42P10 للمخزون | P0 | التطبيق يستعمل مسارًا ثابتًا غائبًا من النسخ القديمة؛ `ON CONFLICT` القديم لا يطابق الفهرس الجزئي الجديد | PR28 المنشور يضيف المسار ويلغي target القديم؛ المرشح يحتفظ بالمسار الحديث و ledger مرتبط بكل event ، ولا يبتلع SQL errors | PASS انحدار PostgreSQL ؛ اختبار runtime يعيد بناء 60b474 بجانب 4cf2353 السلبي. نجاح جرعة tracked في الإنتاج NOT VERIFIED |
| DATA-02:تزامن التأكيد/التأجيل/التخطي وإعادة undo | P0 | البحث عن replay قبل قفل الجرعة يسبق commit المتزامن؛ undo بلا هوية قد يُعاد بعد retake | `dose-service.ts`: قفل الجرعة أولًا؛ undo clientEventId محفوظ؛حركة التراجع تخص آخر take ؛لا نعكس حركة قديمة عند تعطيل المخزون | `final-audit-dose-stock.test.ts` و `stock-ledger-repeat-cycle.test.ts`: PASS في PostgreSQL16/17 على الإصلاح الأول؛ آخر HEAD موثق في PR |
| DATA-03:إنشاء مكرر عند ضياع الاستجابة | P0 | double tap و retry دون هوية عملية محفوظة بالمعاملة | قفل سريع بالواجهة وهوية ثابتة لنفس payload ؛ API profile advisory lock و request hash ؛ migration0083 additive بقيد زوجية و unique index | إنشاء متزامن/إعادة الطلب تعيد ID نفسه؛تغيير payload بالهوية نفسها 409 ؛قيد SQL يرفض نصف هوية. إعادة فتح العملية بعد قتل التطبيق تتطلب تحقق القائمة/تحذير duplicate ولا يعاد اختراع draft من URL |
| DATA-04:نجاح متفائل يخالف الحالة المحفوظة | P0 | تبديل البطاقة قبل إجابة الخادم، وعدم مسح override بعد القراءة | `today.tsx`: لا نجاح قبل الاستجابة؛الـ offline override بعد نجاح حفظ الطابور فقط؛ readback يلغي override ؛خطأ عربي وإعادة محاولة | `today-final-audit.test.ts`: PASS للنقر المزدوج والخادم الفاشل وقراءة مخالفة. إعادة فتح native NOT VERIFIED |
| DEPLOY-01:رحلات المرافق لا تطابق API | P1 | PR29 يستعمل phone-verification و caregiver fixed paths غير الموجودة في 60b474 | الحفاظ على handlers الحديثة و PR29 ؛توحيد API/worker ثم التطبيق وفق خطة النشر | FAIL توافق المصادر الحالية للإنتاج؛إصلاح المصدر جاهز للمراجعة، لم ينشر |
| UI-01:نافذة الوقت مقصوصة والتعليق يفيد بتوقف اللمس/الرجوع | P1 | الكود السابق Card وسطية غير محدودة الارتفاع وتداخل Pressable ؛الصور تثبت القصّ، أثر dispatch الأصلي على الجهاز لم يُقَس | `TimeField.tsx`: modal ملء الشاشة، Safe Area ،منطقتا ScrollView محدودتان 24 ساعة/60 دقيقة، footer مستقل،إلغاء و onRequestClose يحفظان الوقت السابق،إغلاق keyboard | `time-field-final-audit.test.ts`: PASS لحالة confirm/cancel/back callback والتكرار؛الإيماءة والـ Back الفعلي والوصول المرئي BLOCKED |
| UI-02:«كم تأخذ؟» والكمية 6 فُهمت كحد 3 مرات | P1 | خلط تسمية كمية الجرعة بعدد المواعيد؛الأزرار 0.5/1/1.5/2/3 اختصارات كمية | `quick-create.tsx`: تسمية مستقلة لكل كمية/وحدة/أوقات/أيام؛الاختصارات ليست توصيات؛ custom لا يُستبدل؛حد 12 موعدًا تقنيًّا موحدًا ومنع التكرار وإضافة/تعديل/حذف | PASS:6 عربية مع 4 مواعيد و 7 أيام، 12 موعدًا في العقد؛اختبار DB12 في آخر HEAD. الصورة وحدها لم تثبت حد 3 مرات |
| UI-03:وحدات كثيرة مقصوصة أفقيًا | P1 | كل الوحدات في شريط أفقي؛تغيير الشكل لا يوضّح توافقها | `DoseUnitPicker.tsx`,`Picker.tsx`: وحدات مناسبة ملتفة وخيار المزيد والوحدة الحالية ظاهرة؛قرار صريح عند تغيير الشكل؛لا تحويل mg/ml أو قرص/كتلة | PASS حالة/payload و stock-unit integrity ؛التخطيط عند تكبير الخط BLOCKED |
| UI-04:نهاية النموذج/أيام الأسبوع/الكيبورد | P1 | محتوى طويل،عرض وحدات أفقي،نافذة وقت تلتقط الشاشة | المحافظة على ScrollView للنموذج مع handled taps ؛إزالة nested ScrollView في خيارات wrap ؛أيام الأسبوع تلتف؛تأكيد الوقت خارج منطقة التمرير | حالة المكوّن PASS ؛جميع 7 أيام والزر الأخير والـ focus و TalkBack وإيماءات Android ضمن مصفوفة BLOCKED |
| INPUT-01:parseFloat والأرقام/الكسور | P1 | parsing جزئي قد يقبل نصًا زائدًا أو يفقد الرقم العربي؛ DB يخزن 4 خانات | parser مشترك عربي/فارسي/إنجليزي،٫ أوفاصلةعشرية،كسور قابلة للتمثيل؛منع الفارغ/الصفر/السالب للجرعة ورفض التقريب الصامت؛كمية المخزون بوحدتها نفسها | `medication-input.test.ts`:PASS ؛ 1/3 والخانةالخامسة يرفضان بدل التقريب. الصفر مسموح للمخزون، وليس الجرعة |
| OCR-01:نسب ثقة ثابتة | P1 | parser قاعدي يعطي 0.62/0.8… ولا يأخذ ثقة الحقول من Vision | source=`heuristic` ؛الواجهة الجديدة تعرض نسبة فقط مع source=`provider` وقيمة صالحة؛كل حقل قابل للتعديل | `final-audit-ocr.test.ts`:PASS ؛ثقة OCR النص ليست ثقة اسم الدواء/الوصفة. العملاء القديمة تحتاج تحديث العرض |
| OCR-02:انتهاء مهلة مبكر ورسائل غامضة/سجل مزود خام | P1 | مهلة التطبيق 15s أقصر من Vision25s ؛ PUT بلا deadline ؛رسالة المزود تُطبع | مهلة OCR/رفع 45s ؛تمييز upload/billing/configuration/timeout/no-text ؛تصنيف structured reason دون كشف رسالة/مشروع/سر؛لا حفظ قبل المراجعة | PASS تصنيف HTTP401/403/429 وأخطاء داخل 200 و timeout/no-text ،وعزل capture/finalize ؛المزود الحقيقي وتنوع الصور NOT VERIFIED |
| PERF-01:استعلام جداول لكل دواء | P2 | N+1 في قائمة الأدوية | تجميع loadSchedules باستعلام ANY واحد ضمن قائمة IDs المرئية و RLS نفسه | إعادة اختبارات القراءة/الصلاحيات في CI ؛زمن الاستجابة تحت حمل وذاكرة/بطارية NOT VERIFIED |
| BRAND-01:الاسم الإنجليزي والعربي | P2 | بعض النصوص واسم التطبيق بالهوية القديمة | TADAWEE بالضبط و«تداوي»،أخضر/أبيض؛ package IDs مستقرة؛ Android versionCode5 | PASS typecheck/build ؛فحص بصري على جهاز BLOCKED |

## العقود بين التطبيق والخادم

[REQUESTS.md](REQUESTS.md) يستخرج 83 موضع استدعاء. جميع أشكال المسارات المباشرة المستخرجة لها handler في المرشح؛سبعة مواضع تشير إلى ستة عقود غائبة في مصدر API60b474. ذلك تحقق مصدر، وليس استدعاء إنتاجي مصادقًا.

| طلب الهاتف النهائي | البيانات خارج URL | handler/إثبات المصدر |
| --- | --- | --- |
| POST `/v1/dose/action` | JSON doseId/action/clientEventId ؛ undo key اختياري للتوافق | `routes/dose-private.ts` ،خدمة مشتركة مع legacy |
| `/v1/medication[/stock/refill/schedules]` | `x-dawaee-medication-id` | `private-resource-routing.ts` يعيد التوجيه داخليًا إلى medications/:id |
| `/v1/schedule`, `/v1/dose`, `/v1/profile` | رؤوس schedule/dose/profile IDs | rewrite قبل route matching ؛الـ legacy محفوظ |
| GET القوائم | profileId/medicationId ينقلان إلى رؤوس خاصة | `profile-routing.ts`, `promoteMedicationIdHeader` ؛لا تسريب معرفات صحية إلى access logs |
| POST `/v1/uploads/finalize` | JSON objectKey | موجود في 60b474 والمرشح؛الاعتماد الفعلي يتحقق من الحجم والنوع والملكية قبل OCR |
| GET/POST `/v1/auth/phone-verification` | body إثبات المصادقة عند POST | موجود بالمرشح،غائب من 60b474 |
| POST caregivers/revoke و notification/resolve ؛ PATCH permissions ؛ PUT notification-rules | علاقة/إعداد داخل body | موجود بالمرشح،غائب من 60b474 ؛لا يُحلّ بإرجاع المعرف إلى URL |

## الاختبارات والحدود

الـ commit الأول `b965a8e29e0aa8e72a55ba5af1c51db065463d98` اجتاز [CI بما فيه PG16/17](https://github.com/NAIFMUSFER/dawaee/actions/runs/35102120861)،[Security](https://github.com/NAIFMUSFER/dawaee/actions/runs/35102120897)،[Android native](https://github.com/NAIFMUSFER/dawaee/actions/runs/35102120983). 2396 اختبارًا/320 ملفًا لكل نسخة PostgreSQL. أضيفت بعده حالات OCR و 12 موعدًا وفحص 60b474 ؛**نتيجة آخر HEAD ورقمه وروابطه تُثبت في وصف PR30 بعد اكتمالها،ولا تُورث نتائج b965a8e إليه**.

الفحص المحلي الأخير للحزم/التطبيق واختبارات OCR المحددة:1123PASS/145 ملفًا، Node22.22.2 ؛ build/typecheck/lint PASS. بيانات الاختبارات تركيبية والمزودون controlled ؛ SQL في CI فعلي بمالك غير superuser وغير BYPASSRLS. فشل تشغيل PG محليًا بقيود عمليات/إدارة المستخدمين؛لم تُتجاوز القيود ولم تُستخدم قاعدة إنتاج للاختبار.

استُخدمت مهارات Expo و Render و Supabase والمتصفح للوصول والفحص؛سياسة المتصفح رفضت local URL و file URL. لهذا صور «بعد» وفيديو/تفاعل الواجهة BLOCKED ،وليس PASS تخمينيًا. الشاشةقبل الإصلاح محفوظة في MATRIX ؛صور المحادثة التي تتضمن طرفًا ثالثًا لم تُنشر. فحص الكود لا يثبت هندسة العرض native أو Android Back أو camera أو lock/reboot أووصول Push.

نقاط الاعتماد المتبقية: تحديد APK المثبت،مطابقة اتصال DB ،إثبات backup إنتاجي قابل للاستعادة،توحيد API/worker بعد اعتماد النشر،وقبول الهاتف علىحسابات اختبار وفق ROLLOUT. لا توجد دعوة لمرافق حقيقي أو إعادة تشغيل تذكيرات قديمة في هذا العمل.

مراجع سلوك المنصة: [React Native Modal/onRequestClose](https://reactnative.dev/docs/modal)،[Google Vision response](https://docs.cloud.google.com/vision/docs/reference/rest/v1/AnnotateImageResponse). تمت مطابقة أنواع Modal المثبتة في RN0.83 ؛المصدر العام يشرح العقد ولا يثبت تفاعل الجهاز.
