import { useMemo, useState } from 'react';
import { Avatar, Empty, Skills, SkeletonList } from './ui.jsx';
import { Icon } from './Icon.jsx';
import { tzShort, skillLabel } from '../format.js';

export function PeopleList({ people, meId }) {
  const [query, setQuery] = useState('');
  const rows = useMemo(() => {
    if (!people) return [];
    const q = query.trim().toLowerCase();
    return people.filter(
      (p) => p._id !== meId && (!q || p.displayName.toLowerCase().includes(q) || p.skills?.some((s) => skillLabel(s).toLowerCase().includes(q))),
    );
  }, [people, query, meId]);

  if (!people) return <SkeletonList />;

  return (
    <div>
      <div className="toolbar">
        <div className="search">
          <Icon name="search" size={16} />
          <input type="search" aria-label="Search people" placeholder="Search by name or skill" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      </div>
      <p className="muted small count" aria-live="polite">
        {rows.length} {rows.length === 1 ? 'person' : 'people'} looking for a team
      </p>
      {rows.length === 0 ? (
        <Empty icon="user" title="Nobody here yet">New sign-ups appear here instantly.</Empty>
      ) : (
        <ul className="list">
          {rows.map((p) => (
            <li key={p._id} className="card person-card">
              <Avatar id={p._id} name={p.displayName} />
              <div className="person-card__main">
                <h3>{p.displayName}</h3>
                <p className="muted small">
                  <Icon name="clock" size={13} /> {tzShort(p.utcOffsetMinutes)}
                </p>
              </div>
              <Skills skills={p.skills} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
