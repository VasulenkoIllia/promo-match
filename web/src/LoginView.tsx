import { type SubmitEvent, useId, useState } from "react";
import { type SignedInUser, signIn } from "./api";
import { ErrorNote } from "./SearchView";
import { type ErrorText, errorTextFor, signInErrorText, text } from "./text";
import "./login.css";

interface LoginViewProps {
  initialLogin: string;
  onSignedIn: (user: SignedInUser) => void;
}

export function LoginView({ initialLogin, onSignedIn }: LoginViewProps) {
  const [login, setLogin] = useState(initialLogin);
  const [password, setPassword] = useState("");
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<ErrorText | null>(null);
  const loginId = useId();
  const passwordId = useId();

  const onSubmit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsPending(true);
    setError(null);
    try {
      onSignedIn(await signIn(login, password));
    } catch (caught) {
      setError(errorTextFor(caught, signInErrorText));
      setPassword("");
      setIsPending(false);
    }
  };

  return (
    <main className="login">
      <form className="login-panel" onSubmit={(event) => void onSubmit(event)}>
        <h1>{text.title}</h1>
        <h2>{text.auth.heading}</h2>
        <div className="panel-block">
          <label htmlFor={loginId} className="label">{text.auth.login}</label>
          <input
            id={loginId}
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            autoFocus={!initialLogin}
            value={login}
            onChange={(event) => setLogin(event.target.value)}
          />
        </div>
        <div className="panel-block">
          <label htmlFor={passwordId} className="label">{text.auth.password}</label>
          <input
            id={passwordId}
            type="password"
            autoComplete="current-password"
            required
            autoFocus={Boolean(initialLogin)}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        {error && <ErrorNote error={error} />}
        <button type="submit" className="primary" disabled={isPending}>
          {isPending ? text.auth.pending : text.auth.submit}
        </button>
      </form>
    </main>
  );
}
