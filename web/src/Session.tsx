import { useEffect, useState } from "react";
import { ApiError, fetchSignedInUser, type SignedInUser, setSignedOutListener, signOut } from "./api";
import { LoginView } from "./LoginView";
import { ErrorNote } from "./SearchView";
import { Shell } from "./Shell";
import { type ErrorText, errorTextFor, searchErrorText, text } from "./text";

type SessionState =
  | { kind: "checking" }
  | { kind: "signed-out" }
  | { kind: "check-failed"; error: ErrorText }
  | { kind: "signed-in"; user: SignedInUser };

function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.failure.kind === "status" && error.failure.status === 401;
}

// Whether the browser is signed in decides what is on the page. The end of a session takes the whole Shell away with its
// form and results: they hold purchase prices, and whoever signs in next may be someone else.
// initialLogin: the login a link page has just made or reset, for the sign-in form
export function Session({ initialLogin = "" }: { initialLogin?: string }) {
  const [state, setState] = useState<SessionState>({ kind: "checking" });
  const [checks, setChecks] = useState(0);

  useEffect(() => {
    setSignedOutListener(() => setState({ kind: "signed-out" }));
    return () => setSignedOutListener(() => undefined);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchSignedInUser(controller.signal)
      .then((user) => setState({ kind: "signed-in", user }))
      .catch((error: unknown) => {
        // A 401 has told the listener already
        if (controller.signal.aborted || isUnauthorized(error)) return;
        setState({ kind: "check-failed", error: errorTextFor(error, searchErrorText) });
      });
    return () => controller.abort();
  }, [checks]);

  const endSession = async () => {
    await signOut();
    setState({ kind: "signed-out" });
  };

  switch (state.kind) {
    case "checking":
      return <p className="login-note">{text.auth.checking}</p>;
    case "check-failed":
      return (
        <div className="login-note">
          <ErrorNote error={{ ...state.error, message: `${text.auth.checkFailed} ${state.error.message}` }}>
            <button
              type="button"
              onClick={() => {
                setState({ kind: "checking" });
                setChecks((count) => count + 1);
              }}
            >
              {text.auth.retry}
            </button>
          </ErrorNote>
        </div>
      );
    case "signed-out":
      return <LoginView initialLogin={initialLogin} onSignedIn={(user) => setState({ kind: "signed-in", user })} />;
    case "signed-in":
      return <Shell login={state.user.login} role={state.user.role} onSignOut={endSession} />;
  }
}
