import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { Icon } from './components/Icon.jsx';

const ToastContext = createContext(null);
export const useToast = () => useContext(ToastContext);

const ICONS = { success: 'check', error: 'alert', info: 'info' };

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id) => setItems((list) => list.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (kind, message) => {
      const id = nextId.current++;
      setItems((list) => [...list.slice(-3), { id, kind, message }]);
      setTimeout(() => dismiss(id), kind === 'error' ? 7000 : 4500);
    },
    [dismiss],
  );

  const api = useMemo(
    () => ({
      success: (m) => push('success', m),
      error: (m) => push('error', m),
      info: (m) => push('info', m),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* The live region exists from the start, so screen readers announce what is added to it. */}
      <div className="toasts" role="region" aria-label="Notifications">
        <div aria-live="polite">
          {items.map((t) => (
            <div key={t.id} className={`toast toast--${t.kind}`}>
              <Icon name={ICONS[t.kind]} />
              <span>{t.message}</span>
              <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
                <Icon name="x" size={16} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </ToastContext.Provider>
  );
}
