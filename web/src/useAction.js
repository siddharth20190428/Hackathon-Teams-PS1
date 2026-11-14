import { useCallback, useRef, useState } from 'react';
import { useToast } from './toasts.jsx';
import { messageFor } from './format.js';

// Runs one write at a time for a button: while it runs `pending` is true (the button shows a
// spinner and is disabled), and a failure becomes a toast. A second click while pending does
// nothing, which together with the Idempotency-Key makes a double click harmless.
export function useAction() {
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const busy = useRef(false);

  const run = useCallback(
    async (fn) => {
      if (busy.current) return undefined;
      busy.current = true;
      setPending(true);
      try {
        return await fn();
      } catch (err) {
        toast.error(messageFor(err));
        return undefined;
      } finally {
        busy.current = false;
        setPending(false);
      }
    },
    [toast],
  );

  return [run, pending];
}
