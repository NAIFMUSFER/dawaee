import { useState } from 'react';
import { Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { getAuth, getIdToken, signInWithPhoneNumber, signOut } from '@react-native-firebase/auth';
import { api, ApiError } from '../../src/api/client';
import { Button, Card, Field, Screen, Txt } from '../../src/components/ui';

type Step = 'phone' | 'code' | 'password';
type Confirmation = Awaited<ReturnType<typeof signInWithPhoneNumber>>;

function toE164Saudi(input: string): string | null {
  const compact = input.trim().replace(/[\s()-]/g, '');
  if (/^\+9665\d{8}$/.test(compact)) return compact;
  if (/^009665\d{8}$/.test(compact)) return `+${compact.slice(2)}`;
  if (/^9665\d{8}$/.test(compact)) return `+${compact}`;
  if (/^05\d{8}$/.test(compact)) return `+966${compact.slice(1)}`;
  if (/^5\d{8}$/.test(compact)) return `+966${compact}`;
  return null;
}

function firebaseMessage(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '') : '';
  if (code.includes('invalid-phone-number')) return 'رقم الجوال غير صحيح.';
  if (code.includes('invalid-verification-code')) return 'رمز التحقق غير صحيح.';
  if (code.includes('session-expired') || code.includes('code-expired')) return 'انتهت صلاحية الرمز. اطلب رمزًا جديدًا.';
  if (code.includes('too-many-requests') || code.includes('quota-exceeded')) return 'تم تجاوز عدد المحاولات مؤقتًا. حاول لاحقًا.';
  return 'تعذر إكمال التحقق من رقم الجوال. حاول مرة أخرى.';
}

export default function ForgotPasswordScreen() {
  const router = useRouter();
  const auth = getAuth();
  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [verifiedPhone, setVerifiedPhone] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [idToken, setIdToken] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendCode = async () => {
    const normalized = toE164Saudi(phone);
    if (!normalized) { setError('أدخل رقم جوال سعودي صحيح مثل 05XXXXXXXX.'); return; }
    setBusy(true); setError(null);
    try {
      await signOut(auth).catch(() => undefined);
      const result = await signInWithPhoneNumber(auth, normalized);
      setConfirmation(result);
      setVerifiedPhone(normalized);
      setStep('code');
    } catch (err) { setError(firebaseMessage(err)); }
    finally { setBusy(false); }
  };

  const verifyCode = async () => {
    if (!confirmation || !/^\d{4,8}$/.test(code.trim())) {
      setError('أدخل رمز التحقق المرسل إلى جوالك.'); return;
    }
    setBusy(true); setError(null);
    try {
      const credential = await confirmation.confirm(code.trim());
      if (!credential?.user) throw new Error('phone verification did not return a user');
      setIdToken(await getIdToken(credential.user, true));
      setStep('password');
    } catch (err) { setError(firebaseMessage(err)); }
    finally { setBusy(false); }
  };

  const resetPassword = async () => {
    if (!idToken) { setError('انتهت جلسة التحقق. اطلب رمزًا جديدًا.'); setStep('phone'); return; }
    if (password.length < 10) { setError('كلمة المرور الجديدة يجب أن تكون 10 أحرف على الأقل.'); return; }
    if (password !== confirmPassword) { setError('كلمتا المرور غير متطابقتين.'); return; }
    setBusy(true); setError(null);
    try {
      await api.anonymous.post<{ ok: true }>('/v1/auth/firebase-phone/reset-password', {
        idToken, newPassword: password,
      });
      await signOut(auth).catch(() => undefined);
      Alert.alert('تم تغيير كلمة المرور', 'سجّل الدخول الآن بكلمة المرور الجديدة.');
      router.replace('/(auth)/sign-in');
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setError('لا يوجد حساب تداوي مرتبط بهذا الرقم.');
      } else if (err instanceof ApiError && err.status === 401) {
        setError('انتهت صلاحية التحقق. اطلب رمزًا جديدًا.');
        setStep('phone'); setIdToken(null);
      } else {
        setError('تعذر تغيير كلمة المرور الآن. حاول مرة أخرى.');
      }
    } finally { setBusy(false); }
  };

  return (
    <Screen style={{ flexGrow: 1, justifyContent: 'center' }}>
      <Txt variant="h1" weight="bold" align="center">استعادة كلمة المرور</Txt>
      <Txt variant="body" align="center">نتحقق من رقم جوالك أولًا، ثم نسمح بتعيين كلمة مرور جديدة.</Txt>
      <Card>
        {step === 'phone' ? <>
          <Field label="رقم الجوال" value={phone} onChangeText={setPhone} placeholder="05XXXXXXXX" keyboardType="phone-pad" autoCapitalize="none" autoCorrect={false} />
          <Txt variant="caption">عند المتابعة سيُرسل رقم الجوال إلى Google/Firebase ويُخزّن لديهم لأغراض التحقق ومنع إساءة الاستخدام، وقد تصلك رسالة SMS للتحقق.</Txt>
          {error ? <Txt>{error}</Txt> : null}
          <Button label="إرسال رمز التحقق" onPress={() => void sendCode()} loading={busy} />
        </> : null}

        {step === 'code' ? <>
          <Txt variant="bodySmall">أرسلنا رمز التحقق إلى {verifiedPhone ?? phone}</Txt>
          <Field label="رمز التحقق" value={code} onChangeText={setCode} placeholder="000000" keyboardType="number-pad" maxLength={8} autoFocus />
          {error ? <Txt>{error}</Txt> : null}
          <Button label="تحقق" onPress={() => void verifyCode()} loading={busy} />
          <Button label="تغيير الرقم" tone="ghost" onPress={() => { setStep('phone'); setCode(''); setConfirmation(null); setError(null); }} disabled={busy} />
        </> : null}

        {step === 'password' ? <>
          <Field label="كلمة المرور الجديدة" value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" autoCorrect={false} hint="10 أحرف على الأقل" />
          <Field label="تأكيد كلمة المرور" value={confirmPassword} onChangeText={setConfirmPassword} secureTextEntry autoCapitalize="none" autoCorrect={false} />
          {error ? <Txt>{error}</Txt> : null}
          <Button label="تغيير كلمة المرور" onPress={() => void resetPassword()} loading={busy} />
        </> : null}
      </Card>
      <Button label="العودة لتسجيل الدخول" tone="ghost" onPress={() => router.replace('/(auth)/sign-in')} disabled={busy} />
    </Screen>
  );
}
