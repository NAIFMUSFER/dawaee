import React, { useEffect, useState } from 'react';
import { Linking, Platform, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { PALETTE } from '@dawaee/shared';
import { api } from '@/api/client';

interface Contact { name?: string; phoneE164?: string; relation?: string }
interface Medication { name?: string; strength?: string | null; form?: string }

interface ScanResult {
  patientName: string;
  bloodType: string | null;
  allergies: string[];
  conditionsNote: string | null;
  emergencyContacts: Contact[];
  medications: Medication[];
  notice: string;
}

type State =
  | { kind: 'loading' }
  | { kind: 'ok'; card: ScanResult }
  | { kind: 'inactive' }
  | { kind: 'offline' };

const C = {
  ink: '#10221F', muted: '#4A5A57', line: '#D6E2DF', ground: '#FFFFFF',
  alert: '#B3261E', alertBg: '#FDECEA', brand: PALETTE.primary600,
};

function Label({ ar, en }: { ar: string; en: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
      <Txt size={13} color={C.muted} weight="600">{en}</Txt>
      <Txt size={13} color={C.muted} weight="600">{ar}</Txt>
    </View>
  );
}

function Txt({ children, size = 16, color = C.ink, weight = '400', align, style }: {
  children: React.ReactNode; size?: number; color?: string;
  weight?: '400' | '600' | '700'; align?: 'center'; style?: object;
}) {
  const { Text } = require('react-native') as typeof import('react-native');
  return <Text style={[{ fontSize: size, color, fontWeight: weight, textAlign: align }, style]}>{children}</Text>;
}

function Section({ ar, en, children }: { ar: string; en: string; children: React.ReactNode }) {
  return (
    <View style={{
      borderWidth: 1, borderColor: C.line, borderRadius: 14,
      padding: 16, marginBottom: 12, backgroundColor: C.ground,
    }}>
      <Label ar={ar} en={en} />
      {children}
    </View>
  );
}

/**
 * Read the capability from a URL fragment, then remove it from browser history
 * before making the API request. Fragments are never sent to the origin, CDN or
 * Render edge, unlike the old `/e/<token>` path.
 */
async function consumeCapability(): Promise<string | null> {
  let fragment = '';
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    fragment = window.location.hash.slice(1);
    if (fragment && typeof window.history?.replaceState === 'function') {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    }
  } else {
    const initial = await Linking.getInitialURL();
    fragment = initial?.split('#')[1] ?? '';
  }

  let token = fragment;
  try { token = decodeURIComponent(fragment); } catch { return null; }
  return /^[A-Za-z0-9_-]{32}$/.test(token) ? token : null;
}

export default function EmergencyScan() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const token = await consumeCapability();
      if (!token) { if (!cancelled) setState({ kind: 'inactive' }); return; }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const res = await fetch(`${api.baseUrl}/v1/emergency/scan/card`, {
          method: 'GET',
          headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
          cache: 'no-store',
          signal: controller.signal,
        });
        if (cancelled) return;
        if (!res.ok) { setState({ kind: 'inactive' }); return; }
        const card = await res.json() as ScanResult;
        setState({ kind: 'ok', card });
      } catch {
        if (!cancelled) setState({ kind: 'offline' });
      } finally {
        clearTimeout(timer);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const shell = (children: React.ReactNode) => (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#F4F7F6' }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>{children}</ScrollView>
    </SafeAreaView>
  );

  if (state.kind === 'loading') return shell(<Txt align="center" color={C.muted}>…</Txt>);

  if (state.kind === 'offline' || state.kind === 'inactive') {
    const en = state.kind === 'offline'
      ? 'No connection. This card cannot be read right now.'
      : 'This emergency code is not active.';
    const ar = state.kind === 'offline'
      ? 'لا يوجد اتصال. تعذّر قراءة البطاقة الآن.'
      : 'رمز الطوارئ هذا غير مُفعّل.';
    return shell(
      <View style={{ paddingVertical: 40, gap: 10 }}>
        <Txt size={19} weight="700" align="center">{en}</Txt>
        <Txt size={19} weight="700" align="center">{ar}</Txt>
      </View>,
    );
  }

  const { card } = state;
  return shell(
    <>
      <View style={{ marginBottom: 14 }}>
        <Txt size={12} weight="600" color={C.brand}>EMERGENCY CARD · بطاقة طوارئ</Txt>
        <Txt size={28} weight="700" style={{ marginTop: 4 }}>{card.patientName}</Txt>
      </View>

      <View style={{
        borderRadius: 14, padding: 16, marginBottom: 12,
        backgroundColor: card.allergies.length ? C.alertBg : C.ground,
        borderWidth: 1, borderColor: card.allergies.length ? C.alert : C.line,
      }}>
        <Label ar="الحساسية" en="Allergies" />
        {card.allergies.length ? (
          card.allergies.map((a) => <Txt key={a} size={24} weight="700" color={C.alert}>{a}</Txt>)
        ) : (
          <Txt size={17} color={C.muted}>None recorded · لا شيء مُسجَّل</Txt>
        )}
      </View>

      <Section ar="فصيلة الدم" en="Blood type">
        <Txt size={card.bloodType ? 26 : 17} weight={card.bloodType ? '700' : '400'}
          color={card.bloodType ? C.ink : C.muted}>
          {card.bloodType ?? 'Not stated · غير محددة'}
        </Txt>
      </Section>

      {card.conditionsNote ? (
        <Section ar="حالات صحية أو ملاحظات" en="Conditions / notes">
          <Txt size={17}>{card.conditionsNote}</Txt>
        </Section>
      ) : null}

      {card.medications.length ? (
        <Section ar="الأدوية الحالية" en="Current medications">
          {card.medications.map((m, i) => (
            <Txt key={`${m.name}-${i}`} size={17} style={{ marginBottom: 4 }}>
              {m.name}{m.strength ? ` — ${m.strength}` : ''}
            </Txt>
          ))}
        </Section>
      ) : null}

      {card.emergencyContacts.length ? (
        <Section ar="جهات الاتصال" en="Emergency contacts">
          {card.emergencyContacts.map((c, i) => (
            <View key={`${c.phoneE164}-${i}`} style={{ marginBottom: 8 }}>
              <Txt size={17} weight="600">{c.name}{c.relation ? ` · ${c.relation}` : ''}</Txt>
              <Txt size={22} weight="700" color={C.brand} style={{ writingDirection: 'ltr' }}>
                {c.phoneE164}
              </Txt>
            </View>
          ))}
        </Section>
      ) : null}

      <View style={{ marginTop: 8, padding: 14, borderRadius: 12, backgroundColor: '#EEF3F2' }}>
        <Txt size={13} color={C.muted}>Information provided by the user. Not a medical record.</Txt>
        <Txt size={13} color={C.muted} style={{ marginTop: 4 }}>
          المعلومات مُدخلة من المستخدم. ليست سجلاً طبياً.
        </Txt>
      </View>
    </>,
  );
}
