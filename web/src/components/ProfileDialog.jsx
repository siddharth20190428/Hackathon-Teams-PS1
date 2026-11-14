import { useEffect, useId, useRef, useState } from 'react';
import { useAuth } from '../auth.jsx';
import { useToast } from '../toasts.jsx';
import { messageFor } from '../format.js';
import { Button, Field } from './ui.jsx';
import { SkillsPicker, TimeZoneSelect } from './ProfileFields.jsx';

// Edit your own name, skills and time zone. Uses the native <dialog>: focus is trapped,
// Escape closes it, and focus returns to the button that opened it.
export function ProfileDialog({ onClose }) {
  const { user, updateProfile } = useAuth();
  const toast = useToast();
  const uid = useId();
  const ref = useRef(null);
  const [name, setName] = useState(user.displayName);
  const [skills, setSkills] = useState(user.skills);
  const [offset, setOffset] = useState(user.utcOffsetMinutes);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  async function save(e) {
    e.preventDefault();
    setError('');
    setPending(true);
    try {
      await updateProfile({ displayName: name, skills, utcOffsetMinutes: offset });
      toast.success('Profile saved.');
      onClose();
    } catch (err) {
      setError(messageFor(err));
      setPending(false);
    }
  }

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={`${uid}-t`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => e.target === ref.current && onClose()}
    >
      <form className="dialog__panel form" onSubmit={save}>
        <h2 id={`${uid}-t`}>Edit profile</h2>
        <Field label="Display name" htmlFor={`${uid}-n`}>
          <input id={`${uid}-n`} value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} autoComplete="name" />
        </Field>
        <SkillsPicker value={skills} onChange={setSkills} />
        <TimeZoneSelect id={`${uid}-z`} value={offset} onChange={setOffset} />
        {error && (
          <p className="form__error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog__actions">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={pending}>
            Save
          </Button>
        </div>
      </form>
    </dialog>
  );
}
