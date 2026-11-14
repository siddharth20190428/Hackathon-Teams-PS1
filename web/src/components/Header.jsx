import { useAuth } from '../auth.jsx';
import { Avatar } from './ui.jsx';
import { Icon } from './Icon.jsx';

const LIVE_TEXT = { live: 'Live', connecting: 'Connecting', off: 'Offline' };

export function Header({ live }) {
  const { user, logout } = useAuth();
  return (
    <header className="header">
      <div className="header__inner">
        <div className="logo">
          <Icon name="users" size={20} />
          <span>Team Finder</span>
        </div>
        <span className={`pill pill--${live}`} role="status" aria-label={`Live updates: ${LIVE_TEXT[live]}`}>
          <span className="pill__dot" /> {LIVE_TEXT[live]}
        </span>
        <div className="header__user">
          <Avatar id={user.id} name={user.displayName} size="sm" />
          <span className="header__name">{user.displayName}</span>
          <button type="button" className="icon-btn" onClick={logout} aria-label="Sign out" title="Sign out">
            <Icon name="logout" />
          </button>
        </div>
      </div>
    </header>
  );
}
