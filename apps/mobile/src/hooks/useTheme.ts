import { useMemo } from 'react';
import { buildTheme, type Theme } from '../theme/index.js';
import { useApp } from '../state/app-store.js';
import { useI18n } from '../i18n/index.js';

/** The single place a screen gets its sizing, colour and direction from. */
export function useTheme(): Theme {
  const { preferences } = useApp();
  const { isRtl } = useI18n();
  return useMemo(
    () => buildTheme({
      elderlyMode: preferences.elderlyMode,
      highContrast: preferences.highContrast,
      textScale: preferences.textScale,
      isRtl,
    }),
    [preferences.elderlyMode, preferences.highContrast, preferences.textScale, isRtl],
  );
}
