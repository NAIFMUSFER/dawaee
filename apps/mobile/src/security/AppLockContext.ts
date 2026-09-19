import { createContext, useContext } from 'react';

export interface AppLockApi {
  locked: boolean;
  /** Includes the background shield and the current route's area lock. */
  contentBlocked: boolean;
  needsArea: (area: string) => boolean;
  verifyArea: (area: string, prompt: string, cancel: string) => Promise<boolean>;
}

export const AppLockContext = createContext<AppLockApi>({
  locked: false, contentBlocked: false,
  needsArea: () => false, verifyArea: async () => true,
});

export const useAppLock = (): AppLockApi => useContext(AppLockContext);
