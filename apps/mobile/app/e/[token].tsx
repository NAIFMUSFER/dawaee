import React, { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { PALETTE } from '@dawaee/shared';
import { api, NetworkError } from '@/api/client';

/**
 * What a paramedic sees when they scan the emergency QR.
 *
 * The server has always encoded `${PUBLIC_APP_URL}/e/<token>` into the code,
 * and nothing served that path — so scanning an unconscious patient's card
 * produced a 404 where their blood type and allergies should have been. This
 * is the screen behind it.
 *
 * It is written differently from every other screen in the app, on purpose:
 *
 *  - Bilingual, always, both labels shown together. The reader did not choose
 *    this app's language; the patient did. A paramedic must not have to guess
 *    which of two words means "allergies".
 *  - No app chrome, no navigation, no sign-in. Whoever holds this phone is not
 *    a user of the product and has seconds, not minutes.
 *  - Allergies first and largest. It is the field most likely to change what
 *    someone does in the next sixty seconds.
 *  - Provenance stated plainly at the top and the bottom. This is a card the
 *    patient wrote about themselves, not a medical record, and presenting it
 *    as more than that would be the most dangerous thing this screen could do.
 *
 * It deliberately shows only what the API returns. The card's owner chose
 * per-section what a scan may reveal, and this renders that decision rather
 * than reaching for anything else.
 */

/**
 * As the card is actually stored. The field is `phoneE164`, not `phone` — the
 * first draft of this screen guessed `phone`, rendered the contact's name with
 * no number under it, and would have handed a paramedic somebody to call and
 * no way to call them. Caught by scanning a real card rather than by reading
 * the code.
 */
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
  ink: '#10221F',
  muted: '#4A5A57',
  line: '#D6E2DF',
  ground: '#FFFFFF',
  alert: '#B3261E',
  alertBg: '#FDECEA',
  brand: PALETTE.primary600,
};

function Label({ ar, en }: { ar: string; en: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
      <Txt size={13} color={C.muted} weight="600">{en}</Txt>
      <Txt size={13} color={C.muted} weight="600">{ar}</Txt>
    </View>
  );
}

/** A deliberately local text primitive: this screen shares no theme with the app. */
function Txt({ children, size = 16, color = C.ink, weight = '400', align, style }: {
  children: React.ReactNode; size?: number; color?: string;
  weight?: '400' | '600' | '700'; align?: 'center'; style?: object;
}) {
  const { Text } = require('react-native') as typeof import('react-native');
  return (
    <Text style={[{ fontSize: size, color, fontWeight: weight, textAlign: align }, style]}>
      {children}
    </Text>
  );
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

export default function EmergencyScan() {
  const { token } = useLocalSearchParams<{ token?: string }>();
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!token) { setState({ kind: 'inactive' }); return; }
      try {
        const card = await api.anonymous.get<ScanResult>(`/v1/emergency/scan/${token}`);
        if (!cancelled) setState({ kind: 'ok', card });
      } catch (err) {
        if (cancelled) return;
        setState({ kind: err instanceof NetworkError ? 'offline' : 'inactive' });
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  const shell = (children: React.ReactNode) => (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#F4F7F6' }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
        {children}
      </ScrollView>
    </SafeAreaView>
  );

  if (state.kind === 'loading') {
    return shell(<Txt align="center" color={C.muted}>…</Txt>);
  }

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

      {/* First, because it is the field most likely to change the next action. */}
      <View style={{
        borderRadius: 14, padding: 16, marginBottom: 12,
        backgroundColor: card.allergies.length ? C.alertBg : C.ground,
        borderWidth: 1, borderColor: card.allergies.length ? C.alert : C.line,
      }}>
        <Label ar="الحساسية" en="Allergies" />
        {card.allergies.length ? (
          card.allergies.map((a) => (
            <Txt key={a} size={24} weight="700" color={C.alert}>{a}</Txt>
          ))
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
        <Txt size={13} color={C.muted}>
          Information provided by the user. Not a medical record.
        </Txt>
        <Txt size={13} color={C.muted} style={{ marginTop: 4 }}>
          المعلومات مُدخلة من المستخدم. ليست سجلاً طبياً.
        </Txt>
      </View>
    </>,
  );
}
