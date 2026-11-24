import { type FormEvent, useId, useState } from 'react';
import { useNavigate } from 'react-router';
import { api, ApiError } from '../api/client.js';
import { type Me, useMe } from '../api/useMe.js';
import './auth.css';
import { usePageEnter } from './usePageEnter.js';

type Mode = 'login' | 'register';
type FieldName = 'email' | 'password' | 'displayName' | 'inviteCode';
type FieldErrors = Partial<Record<FieldName, string>>;

/** Same pattern and limits as the server's zod schemas (apps/server/src/routes/auth.ts). */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const PASSWORD_MIN = 10;
const PASSWORD_MAX = 200;
export const DISPLAY_NAME_MIN = 2;
export const DISPLAY_NAME_MAX = 24;

export function validateDisplayName(raw: string): string | undefined {
  const name = raw.trim();
  if (name.length === 0) return 'Display name is required';
  if (name.length < DISPLAY_NAME_MIN || name.length > DISPLAY_NAME_MAX) {
    return `Display name must be ${DISPLAY_NAME_MIN} to ${DISPLAY_NAME_MAX} characters`;
  }
  return undefined;
}

interface Values {
  email: string;
  password: string;
  displayName: string;
  inviteCode: string;
}

function validate(mode: Mode, v: Values): FieldErrors {
  const errors: FieldErrors = {};
  const email = v.email.trim();
  if (email.length === 0) errors.email = 'Email is required';
  else if (email.length > 254) errors.email = 'Email is too long';
  else if (!EMAIL_RE.test(email)) errors.email = 'Enter a valid email address';

  if (v.password.length === 0) errors.password = 'Password is required';
  else if (v.password.length > PASSWORD_MAX) errors.password = `Password must be at most ${PASSWORD_MAX} characters`;
  else if (mode === 'register' && v.password.length < PASSWORD_MIN) {
    errors.password = `Password must be at least ${PASSWORD_MIN} characters`;
  }

  if (mode === 'register') {
    const nameError = validateDisplayName(v.displayName);
    if (nameError) errors.displayName = nameError;
    if (v.inviteCode.trim().length > 200) errors.inviteCode = 'Invite code is too long';
  }
  return errors;
}

export function Login() {
  const { setMe } = useMe();
  const navigate = useNavigate();
  const ref = usePageEnter('login');
  const uid = useId();
  const [mode, setMode] = useState<Mode>('login');
  const [values, setValues] = useState<Values>({ email: '', password: '', displayName: '', inviteCode: '' });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const isRegister = mode === 'register';
  const fieldId = (name: FieldName) => `${uid}-${name}`;
  const errorId = (name: FieldName) => `${uid}-${name}-error`;

  function update(name: FieldName, value: string): void {
    setValues((prev) => ({ ...prev, [name]: value }));
    if (errors[name]) setErrors((prev) => ({ ...prev, [name]: undefined }));
  }

  function toggleMode(): void {
    setMode((m) => (m === 'login' ? 'register' : 'login'));
    setErrors({});
    setServerError(null);
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (pending) return;
    const found = validate(mode, values);
    setErrors(found);
    setServerError(null);
    if (Object.values(found).some(Boolean)) return;

    const email = values.email.trim();
    const body: Record<string, string> = isRegister
      ? { email, password: values.password, displayName: values.displayName.trim() }
      : { email, password: values.password };
    const invite = values.inviteCode.trim();
    if (isRegister && invite) body.inviteCode = invite;

    setPending(true);
    try {
      const user = await api<Me>(isRegister ? '/api/auth/register' : '/api/auth/login', { method: 'POST', body });
      setMe(user);
      navigate('/', { replace: true });
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Could not reach the server. Please try again.');
      setPending(false);
    }
  }

  function field(name: FieldName, label: string, input: { type: string; autoComplete: string }, hint?: string) {
    const error = errors[name];
    const hintId = `${uid}-${name}-hint`;
    const describedBy = [hint ? hintId : null, error ? errorId(name) : null].filter(Boolean).join(' ') || undefined;
    return (
      <div className="field">
        <label htmlFor={fieldId(name)}>{label}</label>
        <input
          id={fieldId(name)}
          name={name}
          type={input.type}
          autoComplete={input.autoComplete}
          value={values[name]}
          onChange={(e) => update(name, e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
        />
        {hint && (
          <p id={hintId} className="field-hint muted">
            {hint}
          </p>
        )}
        {error && (
          <p id={errorId(name)} className="field-error">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <main className="auth-page">
      <div ref={ref} className="card auth-card">
        <h1>{isRegister ? 'Create account' : 'Login'}</h1>
        <p className="muted">{isRegister ? 'Join the home game.' : 'Welcome back to the table.'}</p>
        <form className="auth-form" onSubmit={(e) => void onSubmit(e)} noValidate aria-busy={pending || undefined}>
          {serverError && (
            <div role="alert" className="alert">
              {serverError}
            </div>
          )}
          {field('email', 'Email', { type: 'email', autoComplete: 'email' })}
          {field(
            'password',
            'Password',
            { type: 'password', autoComplete: isRegister ? 'new-password' : 'current-password' },
            isRegister ? `At least ${PASSWORD_MIN} characters.` : undefined,
          )}
          {isRegister &&
            field(
              'displayName',
              'Display name',
              { type: 'text', autoComplete: 'nickname' },
              `${DISPLAY_NAME_MIN}–${DISPLAY_NAME_MAX} characters, shown at the table.`,
            )}
          {isRegister && field('inviteCode', 'Invite code', { type: 'text', autoComplete: 'off' }, 'Optional.')}
          <button type="submit" className="btn btn-primary" disabled={pending}>
            {isRegister ? 'Create account' : 'Log in'}
          </button>
        </form>
        <button type="button" className="btn btn-ghost auth-toggle" onClick={toggleMode} disabled={pending}>
          {isRegister ? 'I already have an account' : 'Create an account'}
        </button>
      </div>
    </main>
  );
}
