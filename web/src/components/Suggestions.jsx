import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { messageFor, percent, tzShort } from '../format.js';
import { Avatar, Button, Skills, SkillChip, Spinner } from './ui.jsx';
import { Icon } from './Icon.jsx';

// Ranked teammates for this team. Score = skill complement x 0.6 + time-zone overlap x 0.4;
// "How is this scored?" shows the numbers for each person, so the ranking is never a black box.
export function Suggestions({ teamId, memberCount, profileKey }) {
  const [state, setState] = useState({ status: 'loading' });

  const load = useCallback(async () => {
    setState((s) => (s.data ? { ...s, refreshing: true } : { status: 'loading' }));
    try {
      const data = await api('GET', `/teams/${teamId}/suggestions?limit=5`);
      setState({ status: 'ready', data });
    } catch (err) {
      setState({ status: 'error', message: messageFor(err) });
    }
  }, [teamId]);

  // Reload when the team changes (someone joined or left).
  useEffect(() => {
    load();
  }, [load, memberCount, profileKey]);

  const { data } = state;
  return (
    <section className="panel" aria-labelledby="sugg-title">
      <div className="panel__head">
        <h3 id="sugg-title">
          <Icon name="sparkle" size={16} /> Suggested teammates
        </h3>
        <Button variant="ghost" size="sm" icon="refresh" onClick={load} loading={state.refreshing} aria-label="Refresh suggestions">
          Refresh
        </Button>
      </div>

      {state.status === 'loading' && (
        <p className="muted small">
          <Spinner /> Finding matches…
        </p>
      )}
      {state.status === 'error' && <p className="form__error" role="alert">{state.message}</p>}
      {data && data.suggestions.length === 0 && <p className="muted small">No one to suggest right now. Check back as people sign up.</p>}

      {data && data.suggestions.length > 0 && (
        <>
          <p className="muted small">
            Ranked by <strong>skills you are missing</strong> (60%) and <strong>shared working hours</strong> (40%).
          </p>
          <ol className="suggest">
            {data.suggestions.map((s) => (
              <li key={s.user._id ?? s.user.id} className="suggest__item">
                <Avatar id={s.user._id ?? s.user.id} name={s.user.displayName} />
                <div className="suggest__main">
                  <div className="suggest__top">
                    <h4>{s.user.displayName}</h4>
                    <span className="match" title="Overall match">{percent(s.score)}% match</span>
                  </div>
                  <Skills skills={s.user.skills} />
                  <ul className="reasons">
                    {s.reasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                  <details className="how">
                    <summary>How is this scored?</summary>
                    <dl>
                      <div>
                        <dt>Skills ({percent(s.skills.score)}%)</dt>
                        <dd>
                          Adds:{' '}
                          {s.skills.adds.length ? s.skills.adds.map((x) => <SkillChip key={x} skill={x} tone="good" />) : 'nothing new'}
                        </dd>
                      </div>
                      <div>
                        <dt>Time zone ({percent(s.timezone.score)}%)</dt>
                        <dd>
                          {tzShort(s.user.utcOffsetMinutes)}, {Math.abs(s.timezone.differenceHours)} h from your team, about {s.timezone.overlapHours} h of shared working time
                        </dd>
                      </div>
                      <div>
                        <dt>Total</dt>
                        <dd>
                          0.6 × {percent(s.skills.score)}% + 0.4 × {percent(s.timezone.score)}% = {percent(s.score)}%
                        </dd>
                      </div>
                    </dl>
                  </details>
                </div>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
