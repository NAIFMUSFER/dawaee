interface NotificationPermissionSettings {
  granted?: boolean; status?: string; canAskAgain?: boolean; ios?: { status?: number };
}

/** A first-use prompt must never undo a previous denial in system settings. */
export function notificationPermissionUndetermined(settings: NotificationPermissionSettings): boolean {
  if (settings.canAskAgain === false) return false;
  return typeof settings.ios?.status === 'number'
    ? settings.ios.status === 0 : settings.status === 'undetermined';
}

/** iOS authorization is more specific than Expo's cross-platform flag. */
export function notificationPermissionGranted(settings: NotificationPermissionSettings): boolean {
  if (typeof settings.ios?.status === 'number') {
    // UNAuthorizationStatus: authorized, provisional, ephemeral.
    return [2, 3, 4].includes(settings.ios.status);
  }
  return settings.granted === true || settings.status === 'granted';
}
