interface NotificationPermissionSettings {
  granted?: boolean; status?: string; canAskAgain?: boolean; ios?: { status?: number }; android?: unknown;
}

/** A first-use prompt must never undo a previous denial in system settings. */
export function notificationPermissionUndetermined(settings: NotificationPermissionSettings, alreadyAsked = false): boolean {
  if (settings.canAskAgain === false) return false;
  // Expo Android reports denied while notifications are not enabled, even
  // before its first runtime request. Remember our request across restarts.
  if (settings.android && settings.status === 'denied') return settings.canAskAgain === true && !alreadyAsked;
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
