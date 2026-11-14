import { useId, useState } from 'react';
import { useAuth } from '../auth.jsx';
import { detectedOffset, messageFor } from '../format.js';
import { SkillsPicker, TimeZoneSelect } from './ProfileFields.jsx';
import { Button, Field } from './ui.jsx';
import { Icon } from './Icon.jsx';

export function AuthPage() {
  const { login, register } = useAuth();
  const uid = useId();
  const [mode, setMode] = useState('login');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [skills, setSkills] = useState([]);
  const [offset, setOffset] = useState(detectedOffset);
  const creating = mode === 'register';

  async function submit(e) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setError('');
    setPending(true);
    try {
      if (creating) {
        await register({
          email: form.get('email'),
          password: form.get('password'),
          displayName: form.get('displayName'),
          skills,
          utcOffsetMinutes: offset,
        });
      } else {
        await login({ email: form.get('email'), password: form.get('password') });
      }
    } catch (err) {
      setError(messageFor(err));
      setPending(false);
    }
  }

  return (
    <div className="auth">
      <section className="auth__brand" aria-hidden="true">
        <div className="logo logo--light">
          <Icon name="users" size={20} />
          <span>Team Finder</span>
        </div>
        <h1>Build the right team, fast.</h1>
        <p>See open teams and people in real time, get matched on complementary skills and overlapping hours, and never lose a seat to a race.</p>
        <ul>
          <li><Icon name="check" size={16} /> Live board, no refreshing</li>
          <li><Icon name="check" size={16} /> Matches ranked by skills and time zone</li>
          <li><Icon name="check" size={16} /> One person, one team, guaranteed</li>
        </ul>
      </section>

      <main className="auth__panel">
        <div className="logo auth__mobile-logo">
          <Icon name="users" size={20} />
          <span>Team Finder</span>
        </div>
        <h2>{creating ? 'Create your account' : 'Welcome back'}</h2>
        <p className="muted">{creating ? 'It takes less than a minute.' : 'Sign in to see your team and the live board.'}</p>

        <form onSubmit={submit} noValidate={false} className="form">
          {creating && (
            <Field label="Display name" htmlFor={`${uid}-name`}>
              <input id={`${uid}-name`} name="displayName" required maxLength={60} autoComplete="name" />
            </Field>
          )}
          <Field label="Email" htmlFor={`${uid}-email`}>
            <input id={`${uid}-email`} name="email" type="email" required autoComplete="email" />
          </Field>
          <Field label="Password" htmlFor={`${uid}-pw`} hint={creating ? 'At least 8 characters.' : undefined}>
            <input
              id={`${uid}-pw`}
              name="password"
              type="password"
              required
              minLength={creating ? 8 : undefined}
              maxLength={128}
              autoComplete={creating ? 'new-password' : 'current-password'}
            />
          </Field>

          {creating && (
            <>
              <SkillsPicker value={skills} onChange={setSkills} />
              <TimeZoneSelect id={`${uid}-tz`} value={offset} onChange={setOffset} />
            </>
          )}

          {error && (
            <p className="form__error" role="alert">
              <Icon name="alert" size={16} /> {error}
            </p>
          )}
          <Button type="submit" size="lg" loading={pending}>
            {creating ? 'Create account' : 'Sign in'}
          </Button>
        </form>

        <p className="auth__switch">
          {creating ? 'Already have an account?' : 'New here?'}{' '}
          <button
            type="button"
            className="link"
            onClick={() => {
              setMode(creating ? 'login' : 'register');
              setError('');
              setPending(false);
            }}
          >
            {creating ? 'Sign in' : 'Create an account'}
          </button>
        </p>
      </main>
    </div>
  );
}
