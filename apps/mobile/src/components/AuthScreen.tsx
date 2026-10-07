import React from 'react';
import { KeyboardAvoidingView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Screen } from './ui';

export function AuthScreen({ children }: { children: React.ReactNode }) {
  return <SafeAreaView style={{ flex: 1 }}>
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <Screen>{children}</Screen>
    </KeyboardAvoidingView>
  </SafeAreaView>;
}
