import { type SubmitEvent, useEffect, useId, useState } from "react";
import type { Role } from "./api";
import { linkUrl } from "./links";
import { ErrorNote } from "./SearchView";
import { type ErrorText, errorTextFor } from "./text";
import { type CreatedLink, createInvite, createReset, fetchUsers, setUserActive, type UserEntry, type UserList } from "./users-api";
import { dayText, roleName, usersErrorText, usersText } from "./users-text";
import "./users.css";

const ROLES: Role[] = ["manager", "admin"];

type ListState = { kind: "loading" } | { kind: "ok"; list: UserList } | { kind: "error"; error: ErrorText };

// A link just made, shown until the next one: the server keeps only its hash, so it cannot be shown again
interface ShownLink {
  heading: string;
  url: string;
  expiresAt: string;
}

function shownLink(link: CreatedLink, heading: string): ShownLink {
  return { heading, url: linkUrl(window.location.origin, link.kind, link.token), expiresAt: link.expiresAt };
}

function InviteForm({ onCreated }: { onCreated: (link: ShownLink) => void }) {
  const [role, setRole] = useState<Role>("manager");
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<ErrorText | null>(null);
  const roleId = useId();

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsPending(true);
    setError(null);
    try {
      onCreated(shownLink(await createInvite(role), usersText.inviteHeading(role)));
    } catch (caught) {
      setError(errorTextFor(caught, usersErrorText));
    } finally {
      setIsPending(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)}>
      <h1>{usersText.newHeading}</h1>
      <div className="panel-block">
        <label htmlFor={roleId} className="label">{usersText.role}</label>
        <select id={roleId} value={role} onChange={(event) => setRole(event.target.value as Role)}>
          {ROLES.map((each) => <option key={each} value={each}>{roleName(each)}</option>)}
        </select>
        <p className="hint">{usersText.roleHint}</p>
      </div>
      {error && <ErrorNote error={error} />}
      <div className="user-invite-submit">
        <button type="submit" className="primary" disabled={isPending}>
          {isPending ? usersText.creating : usersText.createInvite}
        </button>
      </div>
    </form>
  );
}

function LinkPanel({ link }: { link: ShownLink }) {
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const urlId = useId();

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(link.url);
      setCopy("copied");
    } catch (error) {
      // No clipboard without HTTPS or the page's focus: the field stays for copying by hand
      console.error(error);
      setCopy("failed");
    }
  };

  return (
    <section className="user-link" aria-live="polite">
      <h2>{link.heading}</h2>
      <label htmlFor={urlId} className="label">{usersText.linkLabel}</label>
      <input id={urlId} type="text" readOnly value={link.url} onFocus={(event) => event.target.select()} />
      <div className="row">
        <button type="button" className="primary" onClick={() => void copyUrl()}>{usersText.copy}</button>
        {copy === "copied" && <span className="hint" role="status">{usersText.copied}</span>}
      </div>
      {copy === "failed" && <p className="error-text" role="alert">{usersText.copyFailed}</p>}
      <p className="hint">{usersText.linkHint(link.expiresAt)}</p>
    </section>
  );
}

interface UserRowProps {
  user: UserEntry;
  isSelf: boolean;
  onChanged: () => void;
  onLink: (link: ShownLink) => void;
}

function UserRow({ user, isSelf, onChanged, onLink }: UserRowProps) {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<ErrorText | null>(null);

  const act = async (work: () => Promise<void>) => {
    setIsPending(true);
    setError(null);
    try {
      await work();
    } catch (caught) {
      setError(errorTextFor(caught, usersErrorText));
    } finally {
      setIsPending(false);
    }
  };

  const toggle = () => act(async () => {
    await setUserActive(user.id, !user.isActive);
    onChanged();
  });
  const reset = () => act(async () => {
    onLink(shownLink(await createReset(user.id), usersText.resetHeading(user.login)));
  });

  return (
    <tr className={user.isActive ? undefined : "is-disabled"}>
      <td className="user-login">
        {user.login}
        {isSelf && <span className="hint"> ({usersText.you})</span>}
      </td>
      <td>{roleName(user.role)}</td>
      <td>{user.isActive ? usersText.active : usersText.disabled}</td>
      <td>{dayText(user.createdAt)}</td>
      <td>
        <div className="user-actions">
          <button type="button" disabled={isPending} aria-label={usersText.resetUser(user.login)} onClick={() => void reset()}>
            {usersText.reset}
          </button>
          {!isSelf && (
            <button
              type="button"
              disabled={isPending}
              aria-label={user.isActive ? usersText.disableUser(user.login) : usersText.enableUser(user.login)}
              onClick={() => void toggle()}
            >
              {user.isActive ? usersText.disable : usersText.enable}
            </button>
          )}
        </div>
        {error && <ErrorNote error={error} />}
      </td>
    </tr>
  );
}

function UserTable({ list, selfLogin, onChanged, onLink }: {
  list: UserList;
  selfLogin: string;
  onChanged: () => void;
  onLink: (link: ShownLink) => void;
}) {
  const { columns } = usersText;
  return (
    <>
      {!list.isComplete && <p className="note warn">{usersText.incomplete}</p>}
      <table className="users">
        <thead>
          <tr>
            <th scope="col">{columns.login}</th>
            <th scope="col">{columns.role}</th>
            <th scope="col">{columns.state}</th>
            <th scope="col">{columns.created}</th>
            <th scope="col">{columns.actions}</th>
          </tr>
        </thead>
        <tbody>
          {list.users.map((user) => (
            <UserRow key={user.id} user={user} isSelf={user.login === selfLogin} onChanged={onChanged} onLink={onLink} />
          ))}
        </tbody>
      </table>
      <p className="hint">{usersText.resetHint}</p>
    </>
  );
}

// The admin's screen (Shell.tsx shows its tab to an admin only; the server answers a manager 403 on its API). Mounted
// when it is opened, so the list is read fresh each time.
export function UsersView({ selfLogin }: { selfLogin: string }) {
  const [state, setState] = useState<ListState>({ kind: "loading" });
  const [loads, setLoads] = useState(0);
  const [link, setLink] = useState<ShownLink | null>(null);
  const headingId = useId();

  useEffect(() => {
    const controller = new AbortController();
    fetchUsers(controller.signal)
      .then((list) => setState({ kind: "ok", list }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ kind: "error", error: errorTextFor(error, usersErrorText) });
      });
    return () => controller.abort();
  }, [loads]);

  const reload = () => setLoads((count) => count + 1);

  return (
    <div className="layout">
      <div className="query-panel">
        <InviteForm onCreated={setLink} />
        {link && <LinkPanel key={link.url} link={link} />}
      </div>
      <main className="results" aria-labelledby={headingId}>
        <h2 id={headingId} className="visually-hidden">{usersText.heading}</h2>
        {state.kind === "loading" && <p className="hint">{usersText.loading}</p>}
        {state.kind === "error" && (
          <ErrorNote error={state.error}>
            <button
              type="button"
              onClick={() => {
                setState({ kind: "loading" });
                reload();
              }}
            >
              {usersText.retry}
            </button>
          </ErrorNote>
        )}
        {state.kind === "ok" && <UserTable list={state.list} selfLogin={selfLogin} onChanged={reload} onLink={setLink} />}
      </main>
    </div>
  );
}
