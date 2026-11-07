import { useLayoutEffect, useRef, useState } from "react";
import type { Role } from "./api";
import { App } from "./App";
import { OwnProductsView } from "./OwnProductsView";
import { SuppliersView } from "./SuppliersView";
import { text } from "./text";
import { UsersView } from "./UsersView";
import { useOwnProducts } from "./useOwnProducts";
import "./own-products.css";

// The views of the tabs. Search and own products stay mounted and hidden, since their forms and paid results must
// outlive a switch; the suppliers' and the admin's views mount when they are opened and read their data fresh.
type View = "search" | "own" | "suppliers" | "users";

interface Tab {
  view: View;
  label: string;
}

interface AccountProps {
  login: string;
  onSignOut: () => Promise<void>;
}

interface ShellProps extends AccountProps {
  role: Role;
}

// Only what the role may open: the server refuses the rest anyway (403), the tab would just lead to an error
function tabsOf(role: Role, ownCount: number | null): Tab[] {
  return [
    { view: "search", label: text.tabs.search },
    { view: "own", label: text.tabs.own(ownCount) },
    { view: "suppliers", label: text.tabs.suppliers },
    ...(role === "admin" ? [{ view: "users", label: text.tabs.users } satisfies Tab] : []),
  ];
}

function Account({ login, onSignOut }: AccountProps) {
  const [isPending, setIsPending] = useState(false);
  const [hasFailed, setHasFailed] = useState(false);

  const signOut = async () => {
    setIsPending(true);
    setHasFailed(false);
    try {
      await onSignOut();
    } catch (error) {
      // The session is still open: saying otherwise would leave the prices on screen for whoever comes next
      console.error(error);
      setHasFailed(true);
      setIsPending(false);
    }
  };

  return (
    <div className="account">
      {hasFailed && <p className="error-text" role="alert">{text.auth.logoutFailed}</p>}
      <span>{login}</span>
      <button type="button" disabled={isPending} onClick={() => void signOut()}>
        {isPending ? text.auth.logoutPending : text.auth.logout}
      </button>
    </div>
  );
}

export function Shell({ login, role, onSignOut }: ShellProps) {
  const [view, setView] = useState<View>("search");
  // The page's scroll is shared and a short tab cuts it, so coming back to the results would lose the place in them
  const scrollOfView = useRef<Record<View, number>>({ search: 0, own: 0, suppliers: 0, users: 0 });
  const own = useOwnProducts();

  useLayoutEffect(() => {
    window.scrollTo(0, scrollOfView.current[view]);
  }, [view]);

  const changeView = (next: View) => {
    scrollOfView.current[view] = window.scrollY;
    setView(next);
  };

  const tabs = tabsOf(role, own.list.kind === "ok" ? own.list.products.length : null);
  return (
    <>
      <nav className="tabs" aria-label={text.tabs.label}>
        {tabs.map((tab) => (
          <button
            key={tab.view}
            type="button"
            aria-current={tab.view === view ? "page" : undefined}
            onClick={() => changeView(tab.view)}
          >
            {tab.label}
          </button>
        ))}
        <Account login={login} onSignOut={onSignOut} />
      </nav>
      {/* Hidden, not unmounted: the search's form and its paid results stay as they are */}
      <div hidden={view !== "search"}>
        <App own={own} />
      </div>
      <div hidden={view !== "own"}>
        <OwnProductsView own={own} />
      </div>
      {view === "suppliers" && <SuppliersView />}
      {view === "users" && <UsersView selfLogin={login} />}
    </>
  );
}
