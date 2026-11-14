import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { describeAudit, formatDateTime, messageFor } from '../format.js';
import { Button, Spinner } from './ui.jsx';
import { Icon } from './Icon.jsx';
import './history.css';

const SHOWN = 8;

// What happened to this team, newest first, for every member. The server writes each entry in the
// same transaction as the change, so this list cannot disagree with the team. `watch` is a string
// that changes whenever the team does, so the list reloads by itself; Refresh covers the rest.
export function History({ teamId, meId, watch }) {
  const [state, setState] = useState({ status: 'loading' });
  const [all, setAll] = useState(false);

  const load = useCallback(async () => {
    setState((s) => (s.data ? { ...s, refreshing: true } : { status: 'loading' }));
    try {
      const data = await api('GET', `/teams/${teamId}/audit?limit=50`);
      setState({ status: 'ready', data });
    } catch (err) {
      setState({ status: 'error', message: messageFor(err) });
    }
  }, [teamId]);

  useEffect(() => {
    load();
  }, [load, watch]);

  const { data } = state;
  const entries = data?.entries ?? [];
  const shown = all ? entries : entries.slice(0, SHOWN);

  return (
    <section className="panel" aria-labelledby="history-title">
      <div className="panel__head">
        <h3 id="history-title">
          <Icon name="clock" size={16} /> History
        </h3>
        <Button variant="ghost" size="sm" icon="refresh" onClick={load} loading={state.refreshing} aria-label="Refresh history">
          Refresh
        </Button>
      </div>

      {state.status === 'loading' && (
        <p className="muted small">
          <Spinner /> Loading…
        </p>
      )}
      {state.status === 'error' && <p className="form__error" role="alert">{state.message}</p>}
      {data && entries.length === 0 && <p className="muted small">Nothing has happened yet.</p>}

      {entries.length > 0 && (
        <>
          <ol className="history">
            {shown.map((e) => {
              const { icon, text } = describeAudit(e, data.names, meId);
              return (
                <li key={e._id} className="history__item">
                  <span className="history__icon" aria-hidden="true">
                    <Icon name={icon} size={14} />
                  </span>
                  <span className="history__text">{text}</span>
                  <time className="history__time muted small" dateTime={e.ts}>
                    {formatDateTime(e.ts)}
                  </time>
                </li>
              );
            })}
          </ol>
          {entries.length > SHOWN && (
            <Button variant="ghost" size="sm" onClick={() => setAll((v) => !v)} aria-expanded={all}>
              {all ? 'Show fewer' : `Show all ${entries.length}`}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
