import React from 'react';
import { Modal, type ModalProps } from 'react-native';
import { useAppLock } from './AppLockContext';

/** RN Modal owns a native window above the route's View overlay. Remove its
 * sensitive children and dismiss it without animation whenever the gate covers
 * content. State in the owning sheet/editor remains mounted for unlock. */
export function PrivacyModal({ children, visible = true, animationType, ...props }: ModalProps) {
  const { contentBlocked } = useAppLock();
  return <Modal {...props} visible={visible && !contentBlocked}
    animationType={contentBlocked ? 'none' : animationType}>
    {contentBlocked ? null : children}
  </Modal>;
}
