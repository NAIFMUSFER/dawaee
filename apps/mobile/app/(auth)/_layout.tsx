import { Stack, Link } from 'expo-router';
import { PALETTE } from '@dawaee/shared';

export default function AuthLayout() {
  return (
    <Stack screenOptions={{ contentStyle: { backgroundColor: PALETTE.background } }}>
      <Stack.Screen
        name="sign-in"
        options={{
          title: '',
          headerShadowVisible: false,
          headerRight: () => <Link href="/(auth)/forgot-password">نسيت كلمة المرور؟</Link>,
        }}
      />
      <Stack.Screen
        name="forgot-password"
        options={{ title: 'استعادة كلمة المرور', headerBackTitle: 'رجوع' }}
      />
    </Stack>
  );
}
