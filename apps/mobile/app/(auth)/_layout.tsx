import { Stack } from 'expo-router';
import { PALETTE } from '@dawaee/shared';

export default function AuthLayout() {
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: PALETTE.background } }} />;
}
