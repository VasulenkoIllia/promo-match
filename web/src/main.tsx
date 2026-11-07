import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { type LinkPage, linkPageOf } from "./links";
import { LinkView } from "./LinkView";
import { Session } from "./Session";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing in index.html");

// The page of an admin's one-time link (links.ts), or the app. The token leaves the address before the first render:
// it stays out of the history, a bookmark, a synced tab and a screenshot, and lives in the page's memory only.
const linkPage = linkPageOf(window.location.pathname, window.location.hash);
if (linkPage) window.history.replaceState(null, "", window.location.pathname);

function Root({ initialLinkPage }: { initialLinkPage: LinkPage | null }) {
  const [page, setPage] = useState(initialLinkPage);
  const [login, setLogin] = useState("");
  if (page) {
    return (
      <LinkView
        page={page}
        onDone={(doneLogin) => {
          window.history.replaceState(null, "", "/");
          setLogin(doneLogin);
          setPage(null);
        }}
      />
    );
  }
  return <Session initialLogin={login} />;
}

createRoot(root).render(
  <StrictMode>
    <Root initialLinkPage={linkPage} />
  </StrictMode>,
);
