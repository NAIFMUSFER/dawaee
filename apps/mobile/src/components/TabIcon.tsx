import React from 'react';
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';

export type TabIconName = 'today' | 'medications' | 'history' | 'family' | 'settings';

export function TabIcon({ name, color, focused, size = 24 }: {
  name: TabIconName;
  color: string;
  focused: boolean;
  size?: number;
}) {
  const strokeWidth = focused ? 2.4 : 2;
  const opacity = focused ? 1 : 0.72;
  const common = { stroke: color, strokeWidth, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ opacity }}>
      {name === 'today' ? (
        <>
          <Circle cx="12" cy="12" r="4" {...common} />
          <Line x1="12" y1="2" x2="12" y2="5" {...common} />
          <Line x1="12" y1="19" x2="12" y2="22" {...common} />
          <Line x1="2" y1="12" x2="5" y2="12" {...common} />
          <Line x1="19" y1="12" x2="22" y2="12" {...common} />
          <Line x1="4.9" y1="4.9" x2="7" y2="7" {...common} />
          <Line x1="17" y1="17" x2="19.1" y2="19.1" {...common} />
          <Line x1="17" y1="7" x2="19.1" y2="4.9" {...common} />
          <Line x1="4.9" y1="19.1" x2="7" y2="17" {...common} />
        </>
      ) : null}
      {name === 'medications' ? (
        <>
          <Path d="M8.2 4.2a4 4 0 0 1 5.6 0l6 6a4 4 0 0 1-5.6 5.6l-6-6a4 4 0 0 1 0-5.6Z" {...common} />
          <Line x1="10.2" y1="12" x2="16" y2="6.2" {...common} />
        </>
      ) : null}
      {name === 'history' ? (
        <>
          <Rect x="3" y="5" width="18" height="16" rx="2" {...common} />
          <Line x1="7" y1="2.5" x2="7" y2="7" {...common} />
          <Line x1="17" y1="2.5" x2="17" y2="7" {...common} />
          <Line x1="3" y1="9" x2="21" y2="9" {...common} />
          <Path d="m8.5 15 2.2 2.2 4.8-5" {...common} />
        </>
      ) : null}
      {name === 'family' ? (
        <>
          <Circle cx="8" cy="8" r="3" {...common} />
          <Circle cx="16.5" cy="9" r="2.5" {...common} />
          <Path d="M2.8 20c.5-4 2.4-6 5.2-6s4.7 2 5.2 6" {...common} />
          <Path d="M13.3 15.2c.8-.8 1.9-1.2 3.2-1.2 2.5 0 4 1.7 4.5 5" {...common} />
        </>
      ) : null}
      {name === 'settings' ? (
        <>
          <Circle cx="12" cy="12" r="3" {...common} />
          <Path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9A1.7 1.7 0 0 0 21 10h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" {...common} />
        </>
      ) : null}
    </Svg>
  );
}
