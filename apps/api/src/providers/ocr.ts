import type {
  MedicationOcrResult, OcrProvider, PrescriptionOcrLine, PrescriptionOcrResult,
} from './types.js';
import type { Config } from '../config.js';

/**
 * Medication label and prescription OCR.
 *
 * Hard product rule enforced by everything downstream of this file: OCR output
 * is a SUGGESTION. It never creates a medication, never activates a schedule,
 * and is stored separately from confirmed data until a human accepts it. The
 * parser below therefore aims to be conservative — it would rather return no
 * value than a confidently wrong strength.
 */

const STRENGTH_RE = /(\d+(?:[.,]\d+)?)\s*(mg|mcg|µg|g|ml|iu|%)\b/i;
const BARCODE_RE = /\b(\d{8}|\d{12,14})\b/;
const EXPIRY_RE =
  /\b(?:exp(?:iry|\.|ires)?|صلاحية|ينتهي|انتهاء)\s*[:.]?\s*(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|\d{4}[-/]\d{2})/i;
const FORM_KEYWORDS: Array<[RegExp, string]> = [
  [/\b(tablet|tablets|tab|caplet)\b|أقراص|قرص|حبوب|حبة/i, 'tablet'],
  [/\b(capsule|caps)\b|كبسول/i, 'capsule'],
  [/\b(syrup|suspension|solution|elixir)\b|شراب|معلق/i, 'syrup'],
  [/\b(drops?)\b|قطرة|قطرات/i, 'drops'],
  [/\b(injection|ampoule|vial)\b|حقن|أمبول/i, 'injection'],
  [/\b(cream|ointment|gel)\b|كريم|مرهم/i, 'cream'],
  [/\b(inhaler|puff)\b|بخاخ|استنشاق/i, 'inhaler'],
  [/\b(patch)\b|لاصقة/i, 'patch'],
  [/\b(suppositor)/i, 'suppository'],
  [/\b(spray)\b|رذاذ/i, 'spray'],
];

export function detectLanguage(text: string): 'ar' | 'en' | 'mixed' | 'unknown' {
  const arabic = (text.match(/[؀-ۿ]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  if (arabic === 0 && latin === 0) return 'unknown';
  if (arabic > 0 && latin > 0 && Math.min(arabic, latin) / Math.max(arabic, latin) > 0.2) return 'mixed';
  return arabic > latin ? 'ar' : 'en';
}

/**
 * Turn raw OCR text into candidate fields. Shared by every provider so the
 * confirmation screen behaves identically whichever vision backend is wired up.
 */
export function parseMedicationText(rawText: string, providerName: string): MedicationOcrResult {
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const fields: MedicationOcrResult['fields'] = {};

  // The medication name is usually the largest / first substantial line. We
  // take the first line that is not purely numeric or a known boilerplate word,
  // and mark it with modest confidence because this heuristic is genuinely
  // uncertain — the user must confirm it.
  const nameLine = lines.find(
    (l) => l.length >= 3 && !/^\d+$/.test(l) && !/^(rx|otc|batch|lot|mfg|exp)\b/i.test(l),
  );
  if (nameLine) {
    fields.name = { value: nameLine.replace(STRENGTH_RE, '').trim() || nameLine, confidence: 0.62 };
  }

  const strengthMatch = rawText.match(STRENGTH_RE);
  if (strengthMatch) {
    const value = Number(strengthMatch[1]!.replace(',', '.'));
    let unit = strengthMatch[2]!.toLowerCase();
    if (unit === 'µg') unit = 'mcg';
    if (unit === '%') unit = 'percent';
    if (Number.isFinite(value) && value > 0) {
      fields.strengthValue = { value, confidence: 0.8 };
      fields.strengthUnit = { value: unit, confidence: 0.8 };
    }
  }

  for (const [re, form] of FORM_KEYWORDS) {
    if (re.test(rawText)) {
      fields.form = { value: form, confidence: 0.7 };
      break;
    }
  }

  const barcode = rawText.match(BARCODE_RE);
  if (barcode) fields.barcode = { value: barcode[1]!, confidence: 0.85 };

  const expiry = rawText.match(EXPIRY_RE);
  if (expiry) fields.expiryDate = { value: expiry[1]!, confidence: 0.55 };

  const instructionLine = lines.find((l) =>
    /(take|daily|twice|once|every|before|after|meal|food)|(?:يؤخذ|مرة|مرتين|يوميا|يومياً|قبل|بعد|الأكل|الطعام)/i.test(l),
  );
  if (instructionLine) fields.instructions = { value: instructionLine, confidence: 0.5 };

  return { provider: providerName, rawText, fields, language: detectLanguage(rawText) };
}

export function parsePrescriptionText(rawText: string, providerName: string): PrescriptionOcrResult {
  const rawLines = rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const lines: PrescriptionOcrLine[] = [];

  for (const line of rawLines) {
    const strength = line.match(STRENGTH_RE);
    const frequency = line.match(
      /(\d+\s*(?:x|times?)\s*(?:a\s*)?day|once daily|twice daily|three times daily|every\s*\d+\s*hours?|مرة يوميا|مرتين يوميا|ثلاث مرات|كل\s*\d+\s*ساعات?)/i,
    );
    const duration = line.match(/(?:for\s*)?(\d+)\s*(days?|weeks?|months?|يوم|أيام|أسبوع|أسابيع|شهر|أشهر)/i);
    // A line is only treated as a medication line when it carries at least one
    // prescription-shaped signal. Everything else stays raw text.
    if (!strength && !frequency && !duration) continue;

    lines.push({
      rawLine: line,
      medicationName: { value: line.replace(STRENGTH_RE, '').split(/[,;]/)[0]!.trim(), confidence: 0.5 },
      ...(strength ? { dosage: { value: strength[0], confidence: 0.7 } } : {}),
      ...(frequency ? { frequency: { value: frequency[0], confidence: 0.65 } } : {}),
      ...(duration ? { duration: { value: duration[0], confidence: 0.6 } } : {}),
    });
  }

  const prescriber = rawText.match(/(?:dr\.?|doctor|د\.|الدكتور|طبيب)\s*([^\n,]{2,60})/i);
  const issued = rawText.match(/\b(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})\b/);

  return {
    provider: providerName,
    rawText,
    ...(prescriber ? { prescriber: { value: prescriber[1]!.trim(), confidence: 0.55 } } : {}),
    ...(issued ? { issuedDate: { value: issued[1]!, confidence: 0.5 } } : {}),
    lines,
    language: detectLanguage(rawText),
  };
}

/** Google Cloud Vision DOCUMENT_TEXT_DETECTION. */
export class GoogleVisionOcrProvider implements OcrProvider {
  readonly name = 'google_vision';
  constructor(private readonly cfg: Config) {
    if (!cfg.GOOGLE_VISION_API_KEY) throw new Error('OCR_PROVIDER=google_vision requires GOOGLE_VISION_API_KEY');
  }

  private async detect(image: Buffer): Promise<string> {
    const res = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${this.cfg.GOOGLE_VISION_API_KEY}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requests: [
          {
            image: { content: image.toString('base64') },
            features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
            // Arabic first: Saudi packaging is predominantly bilingual.
            imageContext: { languageHints: ['ar', 'en'] },
          },
        ],
      }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) throw new Error(`Vision API returned ${res.status}`);
    const json = (await res.json()) as {
      responses?: Array<{ fullTextAnnotation?: { text?: string }; error?: { message?: string } }>;
    };
    const first = json.responses?.[0];
    if (first?.error?.message) throw new Error(first.error.message);
    return first?.fullTextAnnotation?.text ?? '';
  }

  async readMedicationLabel(image: Buffer): Promise<MedicationOcrResult> {
    return parseMedicationText(await this.detect(image), this.name);
  }
  async readPrescription(image: Buffer): Promise<PrescriptionOcrResult> {
    return parsePrescriptionText(await this.detect(image), this.name);
  }
}

/** Azure AI Document Intelligence, prebuilt-read model. */
export class AzureDocumentIntelligenceOcrProvider implements OcrProvider {
  readonly name = 'azure_document_intelligence';
  constructor(private readonly cfg: Config) {
    if (!cfg.AZURE_DI_ENDPOINT || !cfg.AZURE_DI_KEY) {
      throw new Error('OCR_PROVIDER=azure_document_intelligence requires AZURE_DI_ENDPOINT and AZURE_DI_KEY');
    }
  }

  private async detect(image: Buffer, contentType: string): Promise<string> {
    const base = this.cfg.AZURE_DI_ENDPOINT!.replace(/\/$/, '');
    const submit = await fetch(`${base}/documentintelligence/documentModels/prebuilt-read:analyze?api-version=2024-11-30`, {
      method: 'POST',
      headers: { 'Ocp-Apim-Subscription-Key': this.cfg.AZURE_DI_KEY!, 'content-type': contentType },
      body: new Uint8Array(image),
      signal: AbortSignal.timeout(25_000),
    });
    if (submit.status !== 202) throw new Error(`Document Intelligence returned ${submit.status}`);
    const operation = submit.headers.get('operation-location');
    if (!operation) throw new Error('Document Intelligence did not return an operation-location');

    // Poll with a hard ceiling so a stuck analysis cannot hang a request.
    for (let attempt = 0; attempt < 15; attempt++) {
      await new Promise((r) => setTimeout(r, 1200));
      const poll = await fetch(operation, {
        headers: { 'Ocp-Apim-Subscription-Key': this.cfg.AZURE_DI_KEY! },
        signal: AbortSignal.timeout(15_000),
      });
      const json = (await poll.json()) as { status?: string; analyzeResult?: { content?: string } };
      if (json.status === 'succeeded') return json.analyzeResult?.content ?? '';
      if (json.status === 'failed') throw new Error('Document Intelligence analysis failed');
    }
    throw new Error('Document Intelligence analysis timed out');
  }

  async readMedicationLabel(image: Buffer, contentType: string): Promise<MedicationOcrResult> {
    return parseMedicationText(await this.detect(image, contentType), this.name);
  }
  async readPrescription(image: Buffer, contentType: string): Promise<PrescriptionOcrResult> {
    return parsePrescriptionText(await this.detect(image, contentType), this.name);
  }
}

/**
 * Deterministic mock. Returns a realistic bilingual label so the whole
 * photograph → review → confirm flow can be exercised end to end without a
 * vision API key, and so tests assert on the *review* step rather than on the
 * accuracy of a third party.
 */
export class MockOcrProvider implements OcrProvider {
  readonly name = 'mock';
  medicationText = ['PANADOL', 'بنادول', 'Paracetamol 500 mg', 'Film-coated tablets  أقراص مغلفة', 'GSK', 'EXP: 08/2028', '6281000123456'].join('\n');
  prescriptionText = ['Dr. Ahmed Al-Salem', 'King Fahad Hospital', '01/09/2026', 'Metformin 850 mg - twice daily for 30 days', 'Atorvastatin 20 mg - once daily for 30 days'].join('\n');

  async readMedicationLabel(): Promise<MedicationOcrResult> {
    return parseMedicationText(this.medicationText, this.name);
  }
  async readPrescription(): Promise<PrescriptionOcrResult> {
    return parsePrescriptionText(this.prescriptionText, this.name);
  }
}
