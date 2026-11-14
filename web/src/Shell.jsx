import { useEffect, useState } from 'react';
import { api } from './api.js';
import { useAuth } from './auth.jsx';
import { useLiveData } from './live.js';
import { useToast } from './toasts.jsx';
import { messageFor } from './format.js';
import { Header } from './components/Header.jsx';
import { Tabs } from './components/Tabs.jsx';
import { TeamsList } from './components/TeamsList.jsx';
import { PeopleList } from './components/PeopleList.jsx';
import { MyTeam } from './components/MyTeam.jsx';
import { Icon } from './components/Icon.jsx';
import { Button } from './components/ui.jsx';
import { ProfileDialog } from './components/ProfileDialog.jsx';

function useWide() {
  const query = '(min-width: 960px)';
  const [wide, setWide] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
}

export function Shell() {
  const { user } = useAuth();
  const toast = useToast();
  const data = useLiveData();
  const wide = useWide();
  const [tab, setTab] = useState('teams');
  const [requested, setRequested] = useState(() => new Set());
  const [editing, setEditing] = useState(false);
  const [nudged, setNudged] = useState(() => {
    try {
      return sessionStorage.getItem('skills-nudge') === '1';
    } catch {
      return false;
    }
  });
  const dismissNudge = () => {
    setNudged(true);
    try {
      sessionStorage.setItem('skills-nudge', '1');
    } catch {
      /* storage can be blocked; the nudge then returns on reload, which is fine */
    }
  };

  const myTeamId = data.mine?.team?._id ?? null;
  const current = wide && tab === 'team' ? 'teams' : tab;
  const requestCount = data.mine?.requests?.length ?? 0;

  // Optimistic: the button flips to "Requested" at once; if the server says no, it flips back.
  async function ask(team) {
    setRequested((s) => new Set(s).add(team._id));
    try {
      await api('POST', `/teams/${team._id}/join-requests`, {});
      toast.success(`Asked to join ${team.name}. The leader will see it live.`);
    } catch (err) {
      if (err.code === 'ALREADY_REQUESTED') {
        toast.info(messageFor(err));
        return;
      }
      setRequested((s) => {
        const next = new Set(s);
        next.delete(team._id);
        return next;
      });
      toast.error(messageFor(err));
    }
  }

  const tabs = [
    { id: 'teams', label: 'Teams', count: data.board?.length },
    { id: 'people', label: 'People', count: data.people?.length },
    ...(wide ? [] : [{ id: 'team', label: myTeamId ? 'Your team' : 'Get a team', count: requestCount || undefined }]),
  ];

  return (
    <div className="shell">
      <Header live={data.live} onEditProfile={() => setEditing(true)} />
      {user.skills.length === 0 && !nudged && (
        <div className="nudge" role="note">
          <Icon name="sparkle" />
          <span>Add your skills to get better teammate matches.</span>
          <Button size="sm" onClick={() => setEditing(true)}>Add skills</Button>
          <button type="button" className="icon-btn" aria-label="Dismiss" onClick={dismissNudge}>
            <Icon name="x" size={16} />
          </button>
        </div>
      )}
      {editing && <ProfileDialog onClose={() => setEditing(false)} />}
      {data.loadFailed && !data.board && (
        <div className="banner" role="alert">
          <Icon name="alert" /> Could not load the board.
          <Button size="sm" variant="secondary" onClick={() => data.refreshAll().catch(() => {})}>Retry</Button>
        </div>
      )}
      <div className="layout">
        <div className="main">
          <Tabs tabs={tabs} value={current} onChange={setTab} label="Browse" />
          <div role="tabpanel" id="panel-teams" aria-labelledby="tab-teams" hidden={current !== 'teams'}>
            {current === 'teams' && <TeamsList teams={data.board} myTeamId={myTeamId} requested={requested} onAsk={ask} />}
          </div>
          <div role="tabpanel" id="panel-people" aria-labelledby="tab-people" hidden={current !== 'people'}>
            {current === 'people' && <PeopleList people={data.people} meId={user.id} />}
          </div>
          {!wide && (
            <div role="tabpanel" id="panel-team" aria-labelledby="tab-team" hidden={current !== 'team'}>
              {current === 'team' && <MyTeam mine={data.mine} meId={user.id} refresh={data.refreshMine} />}
            </div>
          )}
        </div>
        {wide && (
          <aside className="side" aria-label="Your team">
            <MyTeam mine={data.mine} meId={user.id} refresh={data.refreshMine} />
          </aside>
        )}
      </div>
    </div>
  );
}
