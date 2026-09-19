import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Alert, Platform, ScrollView, View, type AlertButton, type AlertOptions } from 'react-native';
import { usePathname } from 'expo-router';
import { PrivacyModal } from '@/security/PrivacyModal';
import { useAppLock } from '@/security/AppLockContext';
import { useI18n } from '@/i18n';
import { useTheme } from '@/hooks/useTheme';
import { Button, Txt } from '@/components/ui';

interface Request {
  title: string;
  message?: string;
  buttons: AlertButton[];
  options?: AlertOptions;
}

/** The web confirmation stays in the app, with the actual action labels.
 * Scope/route changes discard it rather than retaining an old patient's action.
 * Native platforms continue to use their original Alert implementation. */
export default function WebAlertHost({ scope }: { scope: string }) {
  const pathname = usePathname();
  return Platform.OS === 'web' ? <WebAlertSurface key={`${scope}:${pathname}`} /> : null;
}

function WebAlertSurface() {
  const { t } = useI18n();
  const theme = useTheme();
  const { contentBlocked } = useAppLock();
  const blocked = useRef(contentBlocked);
  blocked.current = contentBlocked;
  const active = useRef<Request | null>(null);
  const [request, setRequest] = useState<Request | null>(null);

  useEffect(() => {
    let mounted = true;
    const previous = Alert.alert;
    const show: typeof Alert.alert = (title, message, buttons, options) => {
      if (!mounted || blocked.current) return;
      const next: Request = { title, message, options,
        buttons: buttons?.length ? buttons.map(button => ({ ...button })) : [{}] };
      active.current = next;
      setRequest(next);
    };
    Alert.alert = show;
    return () => {
      mounted = false;
      active.current = null;
      if (Alert.alert === show) Alert.alert = previous;
    };
  }, []);

  // A confirmation is not a draft: do not resurrect its callback after unlock.
  useLayoutEffect(() => {
    if (contentBlocked) { active.current = null; setRequest(null); }
  }, [contentBlocked]);

  if (!request || contentBlocked) return null;

  const close = () => {
    if (blocked.current || active.current !== request) return false;
    active.current = null;
    setRequest(null);
    return true;
  };
  const choose = (button: AlertButton) => {
    if (close()) button.onPress?.();
  };
  const dismiss = () => {
    if (request.options?.cancelable === false) return;
    const cancel = request.buttons.find(button => button.style === 'cancel');
    if (cancel) choose(cancel);
    else if (close()) request.options?.onDismiss?.();
  };

  return (
    <PrivacyModal visible transparent animationType="none" onRequestClose={dismiss}>
      <View style={{ flex: 1, backgroundColor: theme.colors.overlay, justifyContent: 'center',
        alignItems: 'center', padding: theme.spacing.lg }}>
        <View role="alertdialog" accessibilityViewIsModal accessibilityLabel={request.title}
          style={{ width: '100%', maxWidth: 520, maxHeight: '90%', backgroundColor: theme.colors.surface,
            borderRadius: theme.radius.lg }}>
          <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.md }}>
            <Txt variant="h3" weight="bold" accessibilityRole="header">{request.title}</Txt>
            {request.message ? <Txt>{request.message}</Txt> : null}
            {request.buttons.map((button, index) => (
              <Button key={index} label={button.text ?? t('common.ok')}
                tone={button.style === 'destructive' ? 'danger' : button.style === 'cancel' ? 'secondary' : 'primary'}
                onPress={() => choose(button)} />
            ))}
          </ScrollView>
        </View>
      </View>
    </PrivacyModal>
  );
}
