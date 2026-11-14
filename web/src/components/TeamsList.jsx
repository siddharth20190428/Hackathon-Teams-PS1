import { useMemo, useState } from 'react';
import { Avatar, Button, Empty, Seats, SkeletonList } from './ui.jsx';
import { Icon } from './Icon.jsx';

const PAGE = 40;

export function TeamsList({ teams, myTeamId, requested, onAsk }) {
  const [query, setQuery] = useState('');
  const [openOnly, setOpenOnly] = useState(true);
  const [shown, setShown] = useState(PAGE);

  const rows = useMemo(() => {
    if (!teams) return [];
    const q = query.trim().toLowerCase();
    return teams
      .filter((t) => (!openOnly || t.openSeats > 0) && (!q || t.name.toLowerCase().includes(q) || t.leaderName?.toLowerCase().includes(q)))
      .sort((a, b) => Number(b.openSeats > 0) - Number(a.openSeats > 0));
  }, [teams, query, openOnly]);

  if (!teams) return <SkeletonList />;

  return (
    <div>
      <div className="toolbar">
        <div className="search">
          <Icon name="search" size={16} />
          <input
            type="search"
            aria-label="Search teams"
            placeholder="Search teams or leaders"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setShown(PAGE);
            }}
          />
        </div>
        <label className="switch">
          <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} />
          <span>Open seats only</span>
        </label>
      </div>
      <p className="muted small count" aria-live="polite">
        {rows.length} {rows.length === 1 ? 'team' : 'teams'}
      </p>

      {rows.length === 0 ? (
        <Empty icon="search" title="No teams match">
          {query ? 'Try a different search.' : 'Create the first team from the panel on the right.'}
        </Empty>
      ) : (
        <ul className="list">
          {rows.slice(0, shown).map((t) => {
            const mine = t._id === myTeamId;
            const full = t.openSeats <= 0;
            const asked = requested.has(t._id);
            let action;
            if (mine) action = <span className="badge badge--brand">Your team</span>;
            else if (asked) action = <Button variant="secondary" size="sm" disabled icon="check">Requested</Button>;
            else if (full) action = <span className="badge">Full</span>;
            else if (myTeamId) action = null;
            else
              action = (
                <Button size="sm" onClick={() => onAsk(t)} aria-label={`Ask to join ${t.name}`}>
                  Ask to join
                </Button>
              );
            return (
              <li key={t._id} className="card team-card">
                <Avatar id={t.leaderId} name={t.leaderName ?? t.name} />
                <div className="team-card__main">
                  <h3>{t.name}</h3>
                  <p className="muted small">Led by {t.leaderName ?? 'unknown'}</p>
                </div>
                <div className="team-card__seats">
                  <Seats taken={t.memberCount} max={t.maxSize} />
                  <span className="small muted">
                    {full ? 'Full' : `${t.openSeats} open`}
                  </span>
                </div>
                <div className="team-card__action">{action}</div>
              </li>
            );
          })}
        </ul>
      )}
      {rows.length > shown && (
        <div className="more">
          <Button variant="secondary" onClick={() => setShown((n) => n + PAGE)}>
            Show more ({rows.length - shown} left)
          </Button>
        </div>
      )}
    </div>
  );
}
