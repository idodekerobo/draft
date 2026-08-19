import { loadConfig } from "../../config";
import { GithubClient } from "./client";

const config = loadConfig();

export const githubClient = new GithubClient({
  appId: config.githubAppId,
  privateKeyPem: config.githubAppPrivateKey,
});
