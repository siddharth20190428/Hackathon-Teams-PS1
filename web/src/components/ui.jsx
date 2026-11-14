import { initials, tone, skillLabel } from '../format.js';
import { Icon } from './Icon.jsx';

export function Avatar({ id, name, size = 'md' }) {
  return (
    <span className={`avatar avatar--${size} tone-${tone(id)}`} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

export function Button({ variant = 'primary', size = 'md', loading = false, icon, children, className = '', disabled, ...rest }) {
  return (
    <button
      type="button"
      className={`btn btn--${variant} btn--${size} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner /> : icon ? <Icon name={icon} size={16} /> : null}
      {children}
    </button>
  );
}

export function SkillChip({ skill, tone: kind = 'neutral' }) {
  return <span className={`chip chip--${kind}`}>{skillLabel(skill)}</span>;
}

export function Skills({ skills = [], max = 4 }) {
  if (!skills.length) return <span className="muted small">No skills listed</span>;
  const shown = skills.slice(0, max);
  return (
    <span className="chips">
      {shown.map((s) => (
        <SkillChip key={s} skill={s} />
      ))}
      {skills.length > max && <span className="chip chip--more">+{skills.length - max}</span>}
    </span>
  );
}

// Filled dots for taken seats, so "2 of 4" is readable at a glance (and as text for screen readers).
export function Seats({ taken, max }) {
  const open = Math.max(0, max - taken);
  return (
    <span className="seats" role="img" aria-label={`${taken} of ${max} seats taken, ${open} open`}>
      {Array.from({ length: max }, (_, i) => (
        <span key={i} className={i < taken ? 'seat seat--on' : 'seat'} />
      ))}
    </span>
  );
}

export function Empty({ icon = 'users', title, children }) {
  return (
    <div className="empty">
      <span className="empty__icon">
        <Icon name={icon} size={22} />
      </span>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}

export function SkeletonList({ rows = 4 }) {
  return (
    <div className="list" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="card skeleton">
          <span className="skeleton__bar skeleton__bar--lg" />
          <span className="skeleton__bar" />
        </div>
      ))}
    </div>
  );
}

export function Field({ label, hint, error, children, htmlFor }) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && !error && <p className="field__hint">{hint}</p>}
      {error && (
        <p className="field__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
