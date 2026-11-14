import { useId, useState } from 'react';
import { api, routes } from '../api.js';
import { useAction } from '../useAction.js';
import { useToast } from '../toasts.jsx';
import { useConfirm } from '../confirm.jsx';
import { useAuth } from '../auth.jsx';
import { formatDateTime } from '../format.js';
import { Avatar, Button, Field, Seats, SkeletonList, StatusBadge } from './ui.jsx';
import { Icon } from './Icon.jsx';
import { Suggestions } from './Suggestions.jsx';
import { History } from './History.jsx';

function NoTeam({ refresh }) {
  const uid = useId();
  const toast = useToast();
  const [create, creating] = useAction();
  const [join, joining] = useAction();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');

  const submitCreate = (e) => {
    e.preventDefault();
    return create(async () => {
      await api('POST', routes.teams, { name });
      toast.success('Team created. Invite people with your code.');
      setName('');
      await refresh();
    });
  };
  const submitJoin = (e) => {
    e.preventDefault();
    return join(async () => {
      await api('POST', routes.joinByCode, { code: code.trim() });
      toast.success('You joined the team.');
      setCode('');
      await refresh();
    });
  };

  return (
    <div className="stack">
      <section className="panel">
        <h3>You are not in a team yet</h3>
        <p className="muted small">Create one and invite people, join with a code, or ask to join from the board.</p>
      </section>
      <form className="panel form" onSubmit={submitCreate}>
        <h3>Create a team</h3>
        <Field label="Team name" htmlFor={`${uid}-n`}>
          <input id={`${uid}-n`} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required placeholder="e.g. Night Owls" />
        </Field>
        <Button type="submit" loading={creating} icon="plus">Create team</Button>
      </form>
      <form className="panel form" onSubmit={submitJoin}>
        <h3>Have an invite code?</h3>
        <Field label="Invite code" htmlFor={`${uid}-c`}>
          <input id={`${uid}-c`} value={code} onChange={(e) => setCode(e.target.value)} maxLength={64} required autoComplete="off" spellCheck="false" className="mono" />
        </Field>
        <Button type="submit" variant="secondary" loading={joining} icon="key">Join with code</Button>
      </form>
    </div>
  );
}

function Invite({ team, refresh }) {
  const locked = team.locked === true;
  const toast = useToast();
  const confirm = useConfirm();
  const [regen, regenerating] = useAction();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(team.inviteCode);
      toast.success('Invite code copied.');
    } catch {
      toast.info('Copy failed. Select the code and copy it by hand.');
    }
  };
  const regenerate = async () => {
    const ok = await confirm({
      title: 'Generate a new invite code?',
      body: 'The current code stops working immediately.',
      confirmLabel: 'Generate new code',
      danger: false,
    });
    if (!ok) return;
    regen(async () => {
      await api('POST', `/teams/${team._id}/invite/regenerate`, {});
      toast.success('New invite code ready.');
      await refresh();
    });
  };
  return (
    <section className="panel">
      <div className="panel__head">
        <h3><Icon name="key" size={16} /> Invite code</h3>
      </div>
      <div className="code">
        <code aria-label="Invite code">{team.inviteCode}</code>
        <Button variant="secondary" size="sm" icon="copy" onClick={copy}>Copy</Button>
      </div>
      <p className="muted small">
        {locked
          ? 'The team is locked, so this code does not work until you unlock it.'
          : team.inviteExpiresAt
            ? `Expires ${formatDateTime(team.inviteExpiresAt)}.`
            : 'Share it with the people you want.'}
      </p>
      <Button variant="ghost" size="sm" icon="refresh" loading={regenerating} onClick={regenerate}>New code</Button>
    </section>
  );
}

export function MyTeam({ mine, meId, refresh, onDeclined }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [act, pending] = useAction();
  const { user } = useAuth();
  const [hidden, setHidden] = useState(() => new Set()); // requests declined optimistically

  if (!mine) return <SkeletonList rows={2} />;
  if (!mine.team) return <NoTeam refresh={refresh} />;

  const { team, role, members, requests = [] } = mine;
  const leader = role === 'leader';
  const visibleRequests = requests.filter((r) => !hidden.has(r._id));
  const full = team.openSeats <= 0;
  const locked = team.status === 'locked';
  const ready = team.status === 'ready';
  const missing = Math.max(0, team.minSize - team.memberCount);

  const lock = async () => {
    const ok = await confirm({
      title: 'Lock this team?',
      body: 'Nobody can join, with or without a code, and pending requests are cancelled. You can unlock it any time.',
      confirmLabel: 'Lock team',
      danger: false,
    });
    if (!ok) return;
    act(async () => {
      await api('POST', `/teams/${team._id}/lock`, {});
      toast.success('Team locked.');
      await refresh();
    });
  };
  const unlock = () =>
    act(async () => {
      await api('POST', `/teams/${team._id}/unlock`, {});
      toast.success('Team unlocked. People can join again.');
      await refresh();
    });

  const leave = async () => {
    const ok = await confirm({
      title: 'Leave this team?',
      body: leader
        ? members.length > 1
          ? 'Leadership passes to the longest-serving member.'
          : 'You are the only member, so the team will be deleted.'
        : 'Your seat opens up for someone else.',
      confirmLabel: 'Leave team',
    });
    if (!ok) return;
    act(async () => {
      await api('POST', `/teams/${team._id}/leave`, {});
      toast.success('You left the team.');
      await refresh();
    });
  };

  const remove = async (m) => {
    const ok = await confirm({ title: `Remove ${m.displayName}?`, body: 'They can ask to join again later.', confirmLabel: 'Remove' });
    if (!ok) return;
    act(async () => {
      await api('DELETE', `/teams/${team._id}/members/${m.userId}`);
      toast.success(`${m.displayName} was removed.`);
      await refresh();
    });
  };

  const accept = (r) =>
    act(async () => {
      try {
        await api('POST', `/teams/${team._id}/join-requests/${r._id}/accept`, {});
        toast.success(`${r.displayName} joined your team.`);
      } finally {
        await refresh();
      }
    });

  // Optimistic: the request disappears at once; if the server refuses, it comes back.
  const decline = async (r) => {
    setHidden((h) => new Set(h).add(r._id));
    try {
      await api('POST', `/teams/${team._id}/join-requests/${r._id}/decline`, {});
      onDeclined?.();
      await refresh();
    } catch (err) {
      setHidden((h) => {
        const next = new Set(h);
        next.delete(r._id);
        return next;
      });
      toast.error('Could not decline that request. It is back in the list.');
    }
  };

  return (
    <div className="stack">
      <section className="panel panel--hero">
        <div className="hero__top">
          <div>
            <p className="eyebrow">{leader ? 'You lead' : 'Your team'}</p>
            <h2>{team.name}</h2>
          </div>
          <span className={`badge ${leader ? 'badge--brand' : ''}`}>{leader && <Icon name="crown" size={13} />} {leader ? 'Leader' : 'Member'}</span>
        </div>
        <div className="hero__seats">
          <Seats taken={team.memberCount} max={team.maxSize} />
          <span className="small muted">{full ? 'Team is full' : `${team.openSeats} open seat${team.openSeats === 1 ? '' : 's'}`}</span>
          <StatusBadge status={team.status} count={team.memberCount} minSize={team.minSize} />
        </div>
        <p className="small muted">
          {locked
            ? 'Locked: nobody can join until the leader unlocks the team.'
            : ready
              ? leader
                ? 'You meet the minimum size. Lock the team when you are done recruiting.'
                : 'The team meets the minimum size.'
              : `Needs ${missing} more member${missing === 1 ? '' : 's'} to reach the minimum of ${team.minSize}.`}
        </p>
        {leader && (locked || ready) && (
          <Button variant="secondary" size="sm" icon={locked ? 'refresh' : 'key'} loading={pending} onClick={locked ? unlock : lock}>
            {locked ? 'Unlock team' : 'Lock team'}
          </Button>
        )}
      </section>

      <section className="panel" aria-labelledby="members-title">
        <div className="panel__head">
          <h3 id="members-title">Members</h3>
          <span className="muted small">{members.length}</span>
        </div>
        <ul className="members">
          {members.map((m) => (
            <li key={m.userId}>
              <Avatar id={m.userId} name={m.displayName} />
              <span className="members__name">
                {m.displayName}
                {m.userId === meId && <span className="muted"> (you)</span>}
              </span>
              {m.role === 'leader' && <span className="badge badge--brand"><Icon name="crown" size={12} /> Leader</span>}
              {leader && m.userId !== meId && (
                <Button variant="ghost" size="sm" icon="trash" onClick={() => remove(m)} aria-label={`Remove ${m.displayName}`} />
              )}
            </li>
          ))}
        </ul>
      </section>

      {leader && <Invite team={team} refresh={refresh} />}

      {leader && (
        <section className="panel" aria-labelledby="req-title">
          <div className="panel__head">
            <h3 id="req-title"><Icon name="mail" size={16} /> Join requests</h3>
            <span className="muted small">{visibleRequests.length}</span>
          </div>
          {visibleRequests.length === 0 ? (
            <p className="muted small">No pending requests. New ones appear here live.</p>
          ) : (
            <ul className="members">
              {visibleRequests.map((r) => (
                <li key={r._id}>
                  <Avatar id={r.userId} name={r.displayName} />
                  <span className="members__name">{r.displayName}</span>
                  <Button size="sm" onClick={() => accept(r)} disabled={pending || full} aria-label={`Accept ${r.displayName}`}>Accept</Button>
                  <Button size="sm" variant="secondary" onClick={() => decline(r)} aria-label={`Decline ${r.displayName}`}>Decline</Button>
                </li>
              ))}
            </ul>
          )}
          {full && visibleRequests.length > 0 && <p className="muted small">The team is full, so requests cannot be accepted.</p>}
        </section>
      )}

      {!full && !locked && <Suggestions teamId={team._id} memberCount={team.memberCount} profileKey={`${user.skills.join()}|${user.utcOffsetMinutes}`} />}

      <History
        teamId={team._id}
        meId={meId}
        watch={`${team.version ?? ''}|${team.memberCount}|${team.status}|${members.map((m) => m.userId).join()}|${requests.length}`}
      />

      <Button variant="danger-ghost" icon="door" onClick={leave} loading={pending}>Leave team</Button>
    </div>
  );
}
