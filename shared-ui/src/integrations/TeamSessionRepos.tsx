"use client";

import type { TeamSessionRepo, TeamSessionReposState } from "../types";
import { repoMeta } from "./session-repos";

function RepoRow({ repo }: { repo: TeamSessionRepo }) {
  return (
    <li className="ui-repo-row">
      <span className={repo.last_upload_at ? "ui-dot ui-dot--connected" : "ui-dot ui-dot--none"} aria-hidden="true" />
      <span className="ui-repo-row__name">
        {repo.label ?? "Unnamed repo"}
        <small>{repoMeta(repo)}</small>
      </span>
    </li>
  );
}

/** Every repo in the workspace with session capture on, from any teammate. */
export function TeamSessionRepos({ state, onRetry }: { state: TeamSessionReposState; onRetry: () => void | Promise<unknown> }) {
  if (state.status === "error") {
    return (
      <p className="ui-error" role="alert">
        Could not load repos. <button type="button" className="ui-link" onClick={() => void onRetry()}>Try again</button>
      </p>
    );
  }
  if (state.status === "loading") return <p className="ui-muted">Loading repos…</p>;
  if (state.repos.length === 0) return <p className="ui-muted">No repos are capturing sessions yet.</p>;
  return (
    <ul className="ui-rows ui-repo-list" aria-label="Repos capturing sessions">
      {state.repos.map((repo) => <RepoRow key={repo.id} repo={repo} />)}
    </ul>
  );
}
