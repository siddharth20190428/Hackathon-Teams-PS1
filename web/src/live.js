import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, routes } from './api.js';

// The data the page shows, kept fresh.
//
// - The board and the people list refresh on every live event. They are one cached read each
//   on the server, so a burst of events costs one query, not one per open page.
// - "Your team" is not cached on the server, so it is not refreshed on every event. It
//   refreshes after your own actions, when the stream (re)connects, when the tab comes back,
//   and every 15 s while you are in a team.
// - State is only replaced when the data really changed, so quiet refreshes cause no re-render.
export function useLiveData() {
  const [board, setBoard] = useState(null); // null while the first load is running
  const [people, setPeople] = useState(null);
  const [mine, setMine] = useState(null);
  const [live, setLive] = useState('connecting');
  const [loadFailed, setLoadFailed] = useState(false);
  const seen = useRef({ board: '', people: '', mine: '' });

  const update = useCallback((key, value, setter) => {
    const json = JSON.stringify(value);
    if (seen.current[key] === json) return;
    seen.current[key] = json;
    setter(value);
  }, []);

  const refreshBoard = useCallback(async () => {
    const [b, p] = await Promise.all([api('GET', routes.board), api('GET', routes.people)]);
    update('board', b.teams, setBoard);
    update('people', p.people, setPeople);
  }, [update]);

  const refreshMine = useCallback(async () => {
    update('mine', await api('GET', routes.myTeam), setMine);
  }, [update]);

  const refreshAll = useCallback(
    () => Promise.all([refreshBoard(), refreshMine()]).then(() => setLoadFailed(false)),
    [refreshBoard, refreshMine],
  );

  // First load.
  useEffect(() => {
    refreshAll().catch(() => setLoadFailed(true));
  }, [refreshAll]);

  // The live stream.
  useEffect(() => {
    let es;
    let retry;
    let debounce;
    const open = () => {
      setLive('connecting');
      es = new EventSource(routes.events);
      es.addEventListener('ready', () => {
        setLive('live');
        refreshAll().catch(() => {}); // an event may have been missed while disconnected
      });
      es.addEventListener('board', () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => refreshBoard().catch(() => {}), 150);
      });
      es.onerror = () => {
        if (es.readyState === EventSource.CLOSED) {
          setLive('off'); // refused by the server (for example too many open streams)
          retry = setTimeout(open, 5000);
        } else {
          setLive('connecting'); // the browser reconnects by itself
        }
      };
    };
    open();
    return () => {
      clearTimeout(retry);
      clearTimeout(debounce);
      es?.close();
    };
  }, [refreshAll, refreshBoard]);

  // Coming back to the tab, and a slow poll for the team panel.
  const inTeam = Boolean(mine?.team);
  useEffect(() => {
    const onVisible = () => document.visibilityState === 'visible' && refreshAll().catch(() => {});
    document.addEventListener('visibilitychange', onVisible);
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && inTeam) refreshMine().catch(() => {});
    }, 15_000);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(timer);
    };
  }, [refreshAll, refreshMine, inTeam]);

  return useMemo(
    () => ({ board, people, mine, live, loadFailed, refreshAll, refreshMine }),
    [board, people, mine, live, loadFailed, refreshAll, refreshMine],
  );
}
