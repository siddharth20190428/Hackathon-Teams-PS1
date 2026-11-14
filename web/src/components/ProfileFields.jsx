import { SKILLS, skillLabel, offsetOptions, detectedOffset, detectedZoneName, tzLabel, utcLabel } from '../format.js';
import { Field } from './ui.jsx';

// Shared by sign-up and "Edit profile".
export function SkillsPicker({ value, onChange }) {
  const toggle = (skill) => onChange(value.includes(skill) ? value.filter((x) => x !== skill) : [...value, skill]);
  return (
    <fieldset className="field">
      <legend>Your skills</legend>
      <div className="toggles">
        {SKILLS.map((s) => (
          <label key={s} className="toggle">
            <input type="checkbox" checked={value.includes(s)} onChange={() => toggle(s)} />
            <span>{skillLabel(s)}</span>
          </label>
        ))}
      </div>
      <p className="field__hint">Teams are matched with people who add what they are missing.</p>
    </fieldset>
  );
}

export function TimeZoneSelect({ id, value, onChange }) {
  const detected = detectedOffset();
  const zone = detectedZoneName();
  return (
    <Field label="Your time zone" htmlFor={id} hint="Used to find teammates who work at the same hours.">
      <select id={id} value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {offsetOptions(detected, value).map((m) => (
          <option key={m} value={m}>
            {tzLabel(m)}
            {m === detected ? ' (detected)' : ''}
          </option>
        ))}
      </select>
      {value !== detected && (
        <p className="field__hint tz-detected">
          Your device reports {zone ? `${zone}, ` : ''}
          {utcLabel(detected)}.{' '}
          <button type="button" className="link" onClick={() => onChange(detected)}>
            Use this
          </button>
        </p>
      )}
    </Field>
  );
}
