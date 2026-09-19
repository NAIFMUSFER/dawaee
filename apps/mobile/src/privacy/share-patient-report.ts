import { File } from 'expo-file-system';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';
import { showWebPatientReport } from './web-patient-report';

/** The generated PDF exists only during the share operation. */
export async function sharePatientReport(html: string, title: string, isCurrent: () => boolean): Promise<boolean> {
  if (!isCurrent()) return false;
  if (Platform.OS === 'web') return showWebPatientReport(html, title, isCurrent);
  if (!await Sharing.isAvailableAsync()) return false;
  if (!isCurrent()) return false;
  const pdf = await Print.printToFileAsync({ html });
  try {
    // Profile/account changes during PDF generation must not open a share sheet.
    if (!isCurrent()) return false;
    await Sharing.shareAsync(pdf.uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle: title });
    return true;
  } finally {
    try { new File(pdf.uri).delete(); } catch { /* Best effort cache cleanup. */ }
  }
}
