import { type SubmitEvent, useId, useState } from "react";
import type { LinkPage } from "./links";
import { ErrorNote } from "./SearchView";
import { type ErrorText, errorTextFor } from "./text";
import { acceptInvite, acceptReset } from "./users-api";
import { linkErrorText, linkText } from "./users-text";
import "./login.css";

// The server's bound (src/auth/request.ts), checked here first so a short password costs no attempt of the link's five
const MIN_PASSWORD_CHARS = 12;

interface LinkViewProps {
  page: LinkPage;
  // To the sign-in form, with the login just made or reset
  onDone: (login: string) => void;
}

function PasswordFields({ password, again, onPassword, onAgain }: {
  password: string;
  again: string;
  onPassword: (value: string) => void;
  onAgain: (value: string) => void;
}) {
  const passwordId = useId();
  const againId = useId();
  return (
    <>
      <div className="panel-block">
        <label htmlFor={passwordId} className="label">{linkText.password}</label>
        <input
          id={passwordId}
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(event) => onPassword(event.target.value)}
        />
        <p className="hint">{linkText.passwordHint}</p>
      </div>
      <div className="panel-block">
        <label htmlFor={againId} className="label">{linkText.again}</label>
        <input
          id={againId}
          type="password"
          autoComplete="new-password"
          required
          value={again}
          onChange={(event) => onAgain(event.target.value)}
        />
      </div>
    </>
  );
}

// The page of an invite or a reset link. The token came out of the address before the first render (main.tsx) and lives
// only here, in memory.
export function LinkView({ page, onDone }: LinkViewProps) {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<ErrorText | null>(null);
  const [doneLogin, setDoneLogin] = useState<string | null>(null);
  const loginId = useId();
  const { kind, token } = page;

  const onSubmit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token) return;
    if (password.length < MIN_PASSWORD_CHARS) {
      setError({ message: linkText.tooShort, detail: null });
      return;
    }
    if (password !== again) {
      setError({ message: linkText.differ, detail: null });
      return;
    }
    setIsPending(true);
    setError(null);
    try {
      const accepted = kind === "invite" ? await acceptInvite(token, login, password) : await acceptReset(token, password);
      setDoneLogin(accepted.login);
    } catch (caught) {
      setError(errorTextFor(caught, linkErrorText));
      setIsPending(false);
    }
  };

  if (doneLogin !== null || !token) {
    return (
      <main className="login">
        <div className="login-panel">
          <h1>{linkText.heading[kind]}</h1>
          <p className={doneLogin === null ? "note error" : "note"} role="status">
            {doneLogin === null ? linkText.noToken : linkText.done[kind](doneLogin)}
          </p>
          <button type="button" className="primary" onClick={() => onDone(doneLogin ?? "")}>{linkText.toLogin}</button>
        </div>
      </main>
    );
  }

  return (
    <main className="login">
      <form className="login-panel" onSubmit={(event) => void onSubmit(event)}>
        <h1>{linkText.heading[kind]}</h1>
        {kind === "invite" && (
          <div className="panel-block">
            <label htmlFor={loginId} className="label">{linkText.login}</label>
            <input
              id={loginId}
              type="text"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              autoFocus
              value={login}
              onChange={(event) => setLogin(event.target.value)}
            />
            <p className="hint">{linkText.loginHint}</p>
          </div>
        )}
        <PasswordFields password={password} again={again} onPassword={setPassword} onAgain={setAgain} />
        {error && <ErrorNote error={error} />}
        <button type="submit" className="primary" disabled={isPending}>
          {isPending ? linkText.pending : linkText.submit[kind]}
        </button>
      </form>
    </main>
  );
}
