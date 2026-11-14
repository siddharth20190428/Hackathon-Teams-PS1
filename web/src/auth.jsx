import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, setUnauthorizedHandler } from './api.js';
import { useToast } from './toasts.jsx';

const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }) {
  const toast = useToast();
  const [state, setState] = useState({ status: 'loading', user: null });
  const signedIn = useRef(false);

  useEffect(() => {
    signedIn.current = state.status === 'ready';
  }, [state.status]);

  useEffect(() => {
    // Any request that comes back 401 while signed in means the session ended.
    setUnauthorizedHandler(() => {
      if (!signedIn.current) return;
      setState({ status: 'anon', user: null });
      toast.info('Your session ended. Please sign in again.');
    });
    let alive = true;
    api('GET', '/me')
      .then(({ user }) => alive && setState({ status: 'ready', user }))
      .catch(() => alive && setState({ status: 'anon', user: null }));
    return () => {
      alive = false;
    };
  }, [toast]);

  const enter = useCallback(async (path, body) => {
    const { user } = await api('POST', path, body);
    setState({ status: 'ready', user });
  }, []);

  const value = useMemo(
    () => ({
      status: state.status,
      user: state.user,
      login: (body) => enter('/auth/login', body),
      register: (body) => enter('/auth/register', body),
      logout: async () => {
        await api('POST', '/auth/logout').catch(() => {});
        setState({ status: 'anon', user: null });
      },
    }),
    [state, enter],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
