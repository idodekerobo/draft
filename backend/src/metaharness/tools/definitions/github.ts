import { GithubClientError } from "../../../ingestion/github/client";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { ANY_RUN } from "draft-core/tools";
import { githubClient } from "../../../ingestion/github/client-instance";
import { defineTool, refuse } from "../tool-registry";
import { callerWorkspaceId } from "./shared";

type GithubConnection = { connection_key: string };

async function activeGithubConnection(client: SupabaseClient, workspaceId: string): Promise<GithubConnection | null> {
  const { data, error } = await client
    .from("connections")
    .select("connection_key")
    .eq("workspace_id", workspaceId)
    .eq("provider", "github")
    .eq("status", "active")
    .maybeSingle();
  if (error) throw new Error("Could not load the workspace GitHub connection");
  if (!data || !/^\d+$/.test(data.connection_key)) return null;
  return data as GithubConnection;
}

export async function listWorkspaceGithubRepos(client: SupabaseClient, workspaceId: string): Promise<string[]> {
  const connection = await activeGithubConnection(client, workspaceId);
  if (!connection) return [];
  return githubClient.listInstallationRepositories(connection.connection_key);
}

/** A repository's branches through the workspace's GitHub app, or null when GitHub is not connected or cannot reach it. */
export async function listWorkspaceGithubBranches(client: SupabaseClient, workspaceId: string, repo: string): Promise<{ defaultBranch: string; branches: string[] } | null> {
  const connection = await activeGithubConnection(client, workspaceId);
  if (!connection) return null;
  try {
    return await githubClient.listRepoBranches(connection.connection_key, repo);
  } catch (error) {
    if (error instanceof GithubClientError && error.kind === "permission") return null;
    throw error;
  }
}

export function createGithubTools(client: SupabaseClient) {
  const credential = defineTool({
    name: "github.credential",
    description: "Get a short-lived token scoped to the repositories and access configured for this routine.",
    allowedOrigins: ANY_RUN,
    mcp: false,
    modelVisible: false,
    input: z.object({}),
    auditArguments: () => ({}),
    handler: async ({ caller }) => {
      if (caller.origin.kind !== "run") return refuse("not_allowed", "This tool is only available to routine runs.");
      const permission = caller.origin.run.permissions.find((entry) => entry.tool === "github.credential");
      const limits = permission?.limits as { repos?: unknown; access?: unknown } | undefined;
      const repos = limits?.repos;
      const access = limits?.access;
      if (!Array.isArray(repos) || repos.length === 0 || !repos.every((repo) => typeof repo === "string") || (access !== "read" && access !== "write")) {
        return refuse("invalid_permission", "This routine has no valid GitHub repository scope.");
      }
      const connection = await activeGithubConnection(client, callerWorkspaceId(caller));
      if (!connection) return refuse("github_not_connected", "Connect GitHub to this workspace before using repository access.");
      const installed = await githubClient.listInstallationRepositories(connection.connection_key);
      if (!repos.every((repo) => installed.includes(repo))) {
        return refuse("repository_not_installed", "One or more configured repositories are no longer available to this installation.");
      }
      const token = await githubClient.mintScopedInstallationToken(connection.connection_key, {
        repositories: [...new Set(repos as string[])],
        permissions: access === "read" ? { contents: "read" } : { contents: "write", pull_requests: "write" },
      });
      return {
        status: "ok",
        output: token,
        summary: `Minted a ${access}-only GitHub token for ${(repos as string[]).length} configured repositories.`,
      };
    },
  });
  return [credential];
}
