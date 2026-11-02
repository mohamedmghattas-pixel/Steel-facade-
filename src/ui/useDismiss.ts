/**
 * Closing behaviour shared by menus, popovers and context menus: a press
 * outside `ref` closes, and so does Esc. Esc is taken in the capture phase and
 * stopped there, so it closes only the menu (not a dialog behind it, and it
 * does not also clear the selection); focus then goes back to `returnFocus`
 * (the button that opened it), when given.
 */
import { useEffect, type RefObject } from 'react';

export function useDismiss(open: boolean, ref: RefObject<HTMLElement | null>, close: () => void, returnFocus?: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close();
      returnFocus?.current?.focus();
    };
    window.addEventListener('mousedown', outside);
    window.addEventListener('keydown', esc, true);
    return () => {
      window.removeEventListener('mousedown', outside);
      window.removeEventListener('keydown', esc, true);
    };
  }, [open, ref, close, returnFocus]);
}
