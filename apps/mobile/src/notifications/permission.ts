/** iOS authorization is more specific than Expo's cross-platform flag. */
export function notificationPermissionGranted(settings: {
  granted?: boolean; status?: string; ios?: { status?: number };
}): boolean {
  if (typeof settings.ios?.status === 'number') {
    // UNAuthorizationStatus: authorized, provisional, ephemeral.
    return [2, 3, 4].includes(settings.ios.status);
  }
  return settings.granted === true || settings.status === 'granted';
}
