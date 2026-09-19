import React, { useCallback, useState } from 'react';
import { AppState, Image } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { api } from '@/api/client';
import { useApp } from '@/state/app-store';
import { profileScopeKey, useRequestScope } from '@/hooks/useRequestScope';
import { useI18n } from '@/i18n';

/** Resolve private photos for the current account/profile only. Never persist
 * bearer URLs or reuse a previous medication's picture while a request loads. */
export function MedicationPhoto({ imageKey, name, prominent = false }: {
  imageKey: string | null; name: string; prominent?: boolean;
}) {
  const { user, activeProfile } = useApp();
  const { t } = useI18n();
  const scope = `${profileScopeKey(user?.id, activeProfile)}:${imageKey ?? ''}`;
  const requests = useRequestScope(scope);
  const [image, setImage] = useState<{ scope: string; url: string } | null>(null);
  useFocusEffect(useCallback(() => {
    let focused = true;
    const load = async () => {
      if (!user || !activeProfile || !imageKey) return;
      const current = requests.begin();
      try {
        const result = await api.get<{ url: string }>('/v1/uploads/url', { objectKey: imageKey });
        if (focused && current()) setImage({ scope, url: result.url });
      } catch {
        if (focused && current()) setImage(null);
      }
    };
    void load();
    const listener = AppState.addEventListener('change', state => {
      if (state === 'active') void load();
    });
    return () => { focused = false; listener.remove(); };
  }, [user?.id, activeProfile?.id, imageKey, scope, requests]));
  if (!imageKey || !image || image.scope !== scope) return null;
  return <Image
    key={image.url}
    source={{ uri: image.url }}
    accessibilityLabel={t('medication.imageAlt', { name })}
    resizeMode="contain"
    onError={() => setImage(current => current?.url === image.url ? null : current)}
    style={prominent
      ? { width: '100%', maxWidth: 360, height: 200, alignSelf: 'center', borderRadius: 12 }
      : { width: 80, height: 80, borderRadius: 8 }}
  />;
}
