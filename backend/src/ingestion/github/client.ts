import { SignJWT, importPKCS8 } from "jose";

const GITHUB_API_VERSION = "2022-11-28";
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

export type GithubClientErrorKind = "permission" | "gone" | "rate_limited" | "transient";

export class GithubClientError extends Error {
  constructor(
    message: string,
    public readonly kind: GithubClientErrorKind,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

export interface InstallationInfo {
  accountLogin: string;
  accountId: number;
  suspendedAt: string | null;
}

interface GithubClientDeps {
  appId: string;
  privateKeyPem: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export class GithubClient {
  private readonly appId: string;
  private readonly privateKeyPem: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly tokenCache = new Map<string, CachedToken>();
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(deps: GithubClientDeps) {
    this.appId = deps.appId;
    this.privateKeyPem = deps.privateKeyPem;
    this.fetchFn = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  private headers(authorization: string): Record<string, string> {
    return {
      Authorization: authorization,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    };
  }

  private async signAppJwt(): Promise<string> {
    const nowSeconds = Math.floor(this.now() / 1000);
    const iat = nowSeconds - 60;
    const key = await importPKCS8(this.privateKeyPem, "RS256");
    return new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuedAt(iat)
      .setExpirationTime(iat + 600) // GitHub's hard cap: exp must be <=10min after iat
      .setIssuer(this.appId)
      .sign(key);
  }

  async getInstallationToken(installationId: string): Promise<string> {
    const cached = this.tokenCache.get(installationId);
    if (cached && cached.expiresAtMs - this.now() > TOKEN_REFRESH_MARGIN_MS) {
      return cached.token;
    }

    const existing = this.inFlight.get(installationId);
    if (existing) return existing;

    const mintPromise = this.mintInstallationToken(installationId).finally(() => {
      this.inFlight.delete(installationId);
    });
    this.inFlight.set(installationId, mintPromise);
    return mintPromise;
  }

  private async mintInstallationToken(installationId: string, isRetry = false): Promise<string> {
    const jwt = await this.signAppJwt();
    const res = await this.fetchFn(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      { method: "POST", headers: this.headers(`Bearer ${jwt}`) },
    );

    if (res.status === 401 && !isRetry) {
      this.tokenCache.delete(installationId);
      return this.mintInstallationToken(installationId, true);
    }
    if (res.status === 403 || res.status === 404) {
      throw new GithubClientError(
        `installation ${installationId} token mint failed (${res.status})`,
        res.status === 403 ? "permission" : "gone",
      );
    }
    if (res.status === 429 || (res.status === 403 && res.headers.get("retry-after"))) {
      const retryAfter = Number(res.headers.get("retry-after") ?? "0") || undefined;
      throw new GithubClientError("rate limited minting installation token", "rate_limited", retryAfter);
    }
    if (!res.ok) {
      throw new GithubClientError(`installation token mint failed (${res.status})`, "transient");
    }

    const body = (await res.json()) as { token: string; expires_at: string };
    const expiresAtMs = Date.parse(body.expires_at);
    this.tokenCache.set(installationId, { token: body.token, expiresAtMs });
    return body.token;
  }

  async verifyInstallation(installationId: string): Promise<InstallationInfo> {
    const jwt = await this.signAppJwt();
    const res = await this.fetchFn(`https://api.github.com/app/installations/${installationId}`, {
      headers: this.headers(`Bearer ${jwt}`),
    });
    if (res.status === 403 || res.status === 404) {
      throw new GithubClientError(
        `installation ${installationId} verify failed (${res.status})`,
        res.status === 403 ? "permission" : "gone",
      );
    }
    if (!res.ok) {
      throw new GithubClientError(`installation verify failed (${res.status})`, "transient");
    }

    const body = (await res.json()) as {
      account: { login: string; id: number };
      suspended_at: string | null;
    };
    return {
      accountLogin: body.account.login,
      accountId: body.account.id,
      suspendedAt: body.suspended_at,
    };
  }
}
