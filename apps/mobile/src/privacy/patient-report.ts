import { MESSAGES, t, type Locale, type MessageKey } from '@dawaee/shared';

type Row = Record<string, unknown>;
const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(record) : [];
const escape = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

/** A factual patient report. No remote assets, scripts, bearer links, or raw JSON. */
export function buildPatientReport(payload: unknown, locale: Locale): { html: string; text: string } {
  const exported = record(payload);
  const data = record(exported.data);
  const ar = locale === 'ar';
  const label = (arabic: string, english: string) => ar ? arabic : english;
  const profile = rows(data.profile)[0] ?? {};
  const zone = typeof profile.timezone === 'string' ? profile.timezone : 'Asia/Riyadh';
  const meds = new Map(rows(data.medications).map((med) => [String(med.id), String(med.name ?? '')]));
  const word = (value: unknown, namespace?: string): string => {
    if (value === null || value === undefined || value === '') return '—';
    if (namespace) {
      const key = `${namespace}.${String(value)}`;
      if (key in MESSAGES.en) return t(locale, key as MessageKey);
    }
    if (typeof value === 'boolean') return value ? label('نعم', 'Yes') : label('لا', 'No');
    if (Array.isArray(value)) return value.map((item) => word(item)).join(ar ? '، ' : ', ');
    if (typeof value === 'object') return Object.values(record(value)).map((item) => word(item)).join(' · ');
    return String(value);
  };
  const date = (value: unknown): string => {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return word(value);
    try {
      return new Intl.DateTimeFormat(ar ? 'ar-SA-u-ca-gregory' : 'en-GB', {
        timeZone: zone, year: 'numeric', month: 'short', day: 'numeric',
        ...(value.includes('T') ? { hour: '2-digit' as const, minute: '2-digit' as const } : {}),
      }).format(new Date(value.includes('T') ? value : `${value}T12:00:00Z`));
    } catch { return value; }
  };
  const quantity = (r: Row) => `${word(r.dose_quantity)} ${word(r.dose_unit, 'unit')}`;
  const medication = (r: Row) => meds.get(String(r.medication_id)) || label('دواء محذوف', 'Deleted medication');
  const schedule = (value: unknown): string => {
    const rule = record(value);
    const times = Array.isArray(rule.times) ? word(rule.times) : '';
    switch (rule.kind) {
      case 'fixed_times': return times;
      case 'days_of_week': return `${Array.isArray(rule.weekdays) ? rule.weekdays.map((day) =>
        new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 7 + Number(day))))).join(ar ? '، ' : ', ') : '—'} · ${times}`;
      case 'interval': return `${label('كل', 'Every')} ${word(rule.everyHours)} ${label('ساعة، بدءًا من', 'hours, starting at')} ${word(rule.anchorTime)}${rule.activeFrom ? ` (${word(rule.activeFrom)} – ${word(rule.activeUntil)})` : ''}`;
      case 'as_needed': return `${label('عند الحاجة', 'As needed')}${rule.maxPerDay ? ` · ${label('الحد اليومي', 'Daily maximum')}: ${word(rule.maxPerDay)}` : ''}${rule.minHoursBetween ? ` · ${label('ساعات بين الجرعات', 'Hours between doses')}: ${word(rule.minHoursBetween)}` : ''}`;
      case 'cycle': return `${label('دورة', 'Cycle')}: ${word(rule.daysOn)} ${label('أيام تناول', 'days on')} / ${word(rule.daysOff)} ${label('أيام توقف', 'days off')} · ${times} · ${date(rule.cycleAnchorDate)}`;
      default: return word(value);
    }
  };
  const title = label('تداوي | ملخص بياناتي', 'TADAWEE | My health summary');
  const subtitle = `${word(profile.display_name)} · ${label('تاريخ التصدير', 'Exported')}: ${date(exported.exportedAt)} · ${zone}`;
  const note = label('هذه البيانات كما أدخلها المستخدم، للتنظيم والمتابعة وليست وصفة طبية أو توصية لتغيير العلاج.',
    'These are user-entered records for tracking. This report is not a prescription or a recommendation to change treatment.');
  const text: string[] = [title, subtitle, note];
  const html: string[] = [`<h1>${escape(title)}</h1><p>${escape(subtitle)}</p><p class="note">${escape(note)}</p>`];
  type Column = [string, (row: Row) => string];
  const section = (heading: string, values: Row[], columns: Column[]) => {
    text.push('', heading);
    html.push(`<h2>${escape(heading)}</h2>`);
    if (!values.length) {
      const empty = label('لا توجد بيانات مسجلة.', 'No records.');
      text.push(empty); html.push(`<p>${escape(empty)}</p>`); return;
    }
    html.push(`<table><thead><tr>${columns.map(([name]) => `<th>${escape(name)}</th>`).join('')}</tr></thead><tbody>`);
    for (const value of values) {
      const cells = columns.map(([name, get]) => ({ name, value: get(value) }));
      text.push(cells.map((cell) => `${cell.name}: ${cell.value}`).join(' | '));
      html.push(`<tr>${cells.map((cell) => `<td>${escape(cell.value)}</td>`).join('')}</tr>`);
    }
    html.push('</tbody></table>');
  };
  const drug: Column = [label('الدواء', 'Medication'), medication];
  section(label('الأدوية', 'Medications'), rows(data.medications), [
    [label('الاسم', 'Name'), (r) => word(r.name)],
    [label('التركيز', 'Strength'), (r) => r.strength_value == null ? '—' : `${word(r.strength_value)} ${word(r.strength_unit, 'strengthUnit')}`],
    [label('الشكل', 'Form'), (r) => word(r.form, 'form')],
    [label('الحالة', 'Status'), (r) => word(r.status, 'medication.status')],
    [label('التعليمات والملاحظات', 'Instructions and notes'), (r) => [r.instructions, r.doctor_instructions, r.notes].filter(Boolean).map((v) => word(v)).join('\n') || '—'],
  ]);
  section(label('مواعيد الدواء', 'Medication schedules'), rows(data.schedules), [
    drug, [label('الجرعة', 'Dose'), quantity], [label('المواعيد', 'Schedule'), (r) => schedule(r.rule)],
    [label('الفترة', 'Dates'), (r) => `${date(r.start_date)} – ${date(r.end_date)}`],
    [label('مفعّل', 'Active'), (r) => word(r.active)],
  ]);
  section(label('سجل الجرعات', 'Dose history'), rows(data.doses), [
    drug, [label('الموعد', 'Scheduled'), (r) => date(r.scheduled_at)],
    [label('الجرعة', 'Dose'), quantity], [label('الحالة', 'Status'), (r) => word(r.status, 'dose.status')],
    [label('وقت التأكيد', 'Confirmed'), (r) => date(r.confirmed_at)],
  ]);
  section(label('المخزون', 'Stock'), rows(data.stock), [drug,
    [label('المتبقي', 'Remaining'), (r) => `${word(r.remaining_quantity)} ${word(r.unit, 'unit')}`],
    [label('آخر تعبئة', 'Last refill'), (r) => date(r.last_refill_at)],
  ]);
  section(label('الملاحظات', 'Notes'), rows(data.notes), [
    [label('التاريخ', 'Date'), (r) => date(r.recorded_at)], [label('الملاحظة', 'Note'), (r) => word(r.text)],
    [label('الوسوم', 'Tags'), (r) => word(r.tags)],
  ]);
  section(label('القياسات', 'Measurements'), rows(data.measurements), [
    [label('التاريخ', 'Date'), (r) => date(r.measured_at)], [label('النوع', 'Type'), (r) => word(r.type, 'measurement')],
    [label('القيمة', 'Value'), (r) => `${word(r.value_primary)}${r.value_secondary == null ? '' : ` / ${word(r.value_secondary)}`} ${word(r.unit)}`],
  ]);
  section(label('بطاقة الطوارئ', 'Emergency card'), rows(data.emergencyCard), [
    [label('فصيلة الدم', 'Blood type'), (r) => word(r.blood_type)],
    [label('الحساسية', 'Allergies'), (r) => word(r.allergies)],
    [label('الحالات الصحية والملاحظات', 'Conditions and notes'), (r) => word(r.conditions_note)],
    [label('جهات الاتصال', 'Contacts'), (r) => rows(r.emergency_contacts).map((c) => `${word(c.name)} · ${word(c.phoneE164 ?? c.phone_e164)} · ${word(c.relation)}`).join('\n')],
  ]);
  section(label('المرافقون', 'Caregivers'), rows(data.caregivers), [
    [label('الاسم', 'Name'), (r) => word(r.invited_name)], [label('رقم الجوال', 'Phone'), (r) => word(r.invited_phone_e164)],
    [label('الصلة', 'Relationship'), (r) => word(r.role, 'relationship')],
    [label('الحالة', 'Status'), (r) => ar ? ({ active: 'نشط', pending: 'بانتظار القبول', declined: 'مرفوض', revoked: 'ملغى', expired: 'منتهي' } as Record<string, string>)[String(r.status)] ?? word(r.status) : word(r.status)],
  ]);
  return {
    text: text.join('\n'),
    html: `<!doctype html><html lang="${locale}" dir="${ar ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>
      @page{size:A4;margin:16mm}body{font-family:Arial,sans-serif;font-size:12px;color:#102622;line-height:1.6}
      h1{color:#086158;font-size:24px}h2{color:#086158;font-size:17px;break-after:avoid}p{overflow-wrap:anywhere}
      table{width:100%;border-collapse:collapse;table-layout:fixed;margin-bottom:18px}th,td{border:1px solid #bccdc9;padding:7px;text-align:start;overflow-wrap:anywhere;white-space:pre-wrap}th{background:#e8f4f0}thead{display:table-header-group}tr{break-inside:avoid}.note{color:#435955}
      </style></head><body>${html.join('')}</body></html>`,
  };
}
