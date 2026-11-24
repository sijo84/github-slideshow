import { type ChangeEvent, type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { api, ApiError } from '../api/client.js';
import { useMe } from '../api/useMe.js';
import './auth.css';
import { validateDisplayName } from './Login.js';
import { usePageEnter } from './usePageEnter.js';

/** Mirrors the server: PNG, JPEG or WebP, at most 1 MB (apps/server/src/app.ts multipart limit). */
export const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const AVATAR_MAX_BYTES = 1_048_576;

export interface Invite {
  code: string;
  used: boolean;
  createdAt: string;
}

export function checkAvatarFile(file: File): string | undefined {
  if (!(AVATAR_TYPES as readonly string[]).includes(file.type)) return 'Avatar must be a PNG, JPEG or WebP image';
  if (file.size > AVATAR_MAX_BYTES) return 'Avatar must be 1 MB or smaller';
  return undefined;
}

function errorText(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Could not reach the server. Please try again.';
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function Profile() {
  const { me, loading, refresh } = useMe();
  const ref = usePageEnter('profile');
  const uid = useId();
  const fileInput = useRef<HTMLInputElement>(null);

  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState<'name' | 'upload' | 'remove' | 'invite' | null>(null);

  // Display name
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | undefined>();
  const currentName = me?.displayName;
  useEffect(() => {
    if (currentName !== undefined) setName(currentName);
  }, [currentName]);

  // Avatar preview (object URL revoked whenever it changes and on unmount)
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!previewUrl) return;
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  // Invites
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [newCode, setNewCode] = useState<string | null>(null);
  const loadInvites = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await api<{ invites: Invite[] }>('/api/invites', { signal });
      setInvites(res.invites);
    } catch (err) {
      if (signal?.aborted) return;
      setError(errorText(err));
      setInvites((prev) => prev ?? []);
    }
  }, []);
  useEffect(() => {
    const ac = new AbortController();
    void loadInvites(ac.signal);
    return () => ac.abort();
  }, [loadInvites]);

  function begin(kind: NonNullable<typeof busy>): void {
    setBusy(kind);
    setError(null);
    setStatus(null);
  }

  function clearPicked(): void {
    setFile(null);
    setPreviewUrl(null);
    if (fileInput.current) fileInput.current.value = '';
  }

  async function saveName(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const problem = validateDisplayName(name);
    setNameError(problem);
    if (problem) return;
    begin('name');
    try {
      await api('/api/profile', { method: 'PATCH', body: { displayName: name.trim() } });
      await refresh();
      setStatus('Display name saved');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  function onPick(e: ChangeEvent<HTMLInputElement>): void {
    const picked = e.target.files?.[0];
    setError(null);
    setStatus(null);
    if (!picked) {
      clearPicked();
      return;
    }
    const problem = checkAvatarFile(picked);
    if (problem) {
      clearPicked();
      setError(problem);
      return;
    }
    setFile(picked);
    setPreviewUrl(URL.createObjectURL(picked));
  }

  async function upload(): Promise<void> {
    if (!file) return;
    begin('upload');
    try {
      const form = new FormData();
      form.append('avatar', file);
      await api('/api/profile/avatar', { method: 'POST', body: form });
      clearPicked();
      await refresh();
      setStatus('Avatar updated');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function removeAvatar(): Promise<void> {
    begin('remove');
    try {
      await api('/api/profile/avatar', { method: 'DELETE' });
      clearPicked();
      await refresh();
      setStatus('Avatar removed');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function createInvite(): Promise<void> {
    begin('invite');
    try {
      const res = await api<{ code: string }>('/api/invites', { method: 'POST' });
      setNewCode(res.code);
      setStatus(`Invite code created: ${res.code}`);
      await loadInvites();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  if (!me) {
    return (
      <div ref={ref} className="page profile-page">
        <h1>Profile</h1>
        <p className="muted">{loading ? 'Loading…' : 'Not signed in.'}</p>
      </div>
    );
  }

  const nameId = `${uid}-name`;
  const nameErrId = `${uid}-name-error`;
  const emailId = `${uid}-email`;
  const avatarId = `${uid}-avatar`;
  const avatarHintId = `${uid}-avatar-hint`;

  return (
    <div ref={ref} className="page profile-page">
      <h1>Profile</h1>

      {error && (
        <div role="alert" className="alert">
          {error}
        </div>
      )}
      <p role="status" className="muted" aria-live="polite">
        {status ?? ''}
      </p>

      <section className="card" aria-labelledby={`${uid}-avatar-h`}>
        <h2 id={`${uid}-avatar-h`}>Avatar</h2>
        <div className="avatar-row">
          <img className="avatar-img" src={previewUrl ?? me.avatarUrl} alt={me.displayName} width={96} height={96} />
          <div className="stack">
            <div className="field">
              <label htmlFor={avatarId}>Avatar image</label>
              <input
                ref={fileInput}
                id={avatarId}
                type="file"
                accept={AVATAR_TYPES.join(',')}
                onChange={onPick}
                aria-describedby={avatarHintId}
                disabled={busy !== null}
              />
              <p id={avatarHintId} className="field-hint muted">
                PNG, JPEG or WebP, up to 1 MB.
              </p>
            </div>
            <div className="row">
              {file && (
                <>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void upload()}
                    disabled={busy !== null}
                  >
                    {busy === 'upload' ? 'Uploading…' : 'Upload avatar'}
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={clearPicked} disabled={busy !== null}>
                    Cancel
                  </button>
                </>
              )}
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => void removeAvatar()}
                disabled={busy !== null}
              >
                Remove avatar
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="card" aria-labelledby={`${uid}-account-h`}>
        <h2 id={`${uid}-account-h`}>Account</h2>
        <form className="stack" onSubmit={(e) => void saveName(e)} noValidate>
          <div className="field">
            <label htmlFor={emailId}>Email</label>
            <input id={emailId} type="email" value={me.email} readOnly />
          </div>
          <div className="field">
            <label htmlFor={nameId}>Display name</label>
            <input
              id={nameId}
              type="text"
              value={name}
              autoComplete="nickname"
              onChange={(e) => {
                setName(e.target.value);
                setNameError(undefined);
              }}
              aria-invalid={nameError ? true : undefined}
              aria-describedby={nameError ? nameErrId : undefined}
            />
            {nameError && (
              <p id={nameErrId} className="field-error">
                {nameError}
              </p>
            )}
          </div>
          <div className="row">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy !== null || name.trim() === me.displayName}
            >
              {busy === 'name' ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </section>

      <section className="card" aria-labelledby={`${uid}-invites-h`}>
        <h2 id={`${uid}-invites-h`}>Invite codes</h2>
        <p className="muted">Share a code with a friend so they can create an account.</p>
        <div className="row">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void createInvite()}
            disabled={busy !== null}
          >
            Create invite code
          </button>
        </div>
        {invites === null ? (
          <p className="muted">Loading invite codes…</p>
        ) : invites.length === 0 ? (
          <p className="muted">No invite codes yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Code</th>
                  <th scope="col">Status</th>
                  <th scope="col">Created</th>
                </tr>
              </thead>
              <tbody>
                {invites.map((inv) => (
                  <tr key={inv.code} aria-current={inv.code === newCode ? 'true' : undefined}>
                    <td className="invite-code">{inv.code}</td>
                    <td>
                      <span className="badge">{inv.used ? 'Used' : 'Available'}</span>
                    </td>
                    <td>{formatDate(inv.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
