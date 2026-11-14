import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Button } from './components/ui.jsx';

// confirm({ title, body, confirmLabel }) resolves true or false. It uses the browser's own
// <dialog>, which traps focus, closes on Escape and restores focus to the button that opened it.
const ConfirmContext = createContext(null);
export const useConfirm = () => useContext(ConfirmContext);

export function ConfirmProvider({ children }) {
  const [request, setRequest] = useState(null);
  const dialog = useRef(null);

  const confirm = useCallback((options) => new Promise((resolve) => setRequest({ ...options, resolve })), []);

  useEffect(() => {
    if (request && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [request]);

  const finish = (result) => {
    dialog.current?.close();
    request?.resolve(result);
    setRequest(null);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {request && (
        <dialog
          ref={dialog}
          className="dialog"
          aria-labelledby="confirm-title"
          aria-describedby="confirm-body"
          onCancel={(e) => {
            e.preventDefault();
            finish(false);
          }}
          onClick={(e) => e.target === dialog.current && finish(false)}
        >
          <div className="dialog__panel">
            <h2 id="confirm-title">{request.title}</h2>
            <p id="confirm-body">{request.body}</p>
            <div className="dialog__actions">
              <Button variant="secondary" autoFocus onClick={() => finish(false)}>
                Cancel
              </Button>
              <Button variant={request.danger === false ? 'primary' : 'danger'} onClick={() => finish(true)}>
                {request.confirmLabel ?? 'Confirm'}
              </Button>
            </div>
          </div>
        </dialog>
      )}
    </ConfirmContext.Provider>
  );
}
