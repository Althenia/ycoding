import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface ClaudeCodeCredentials {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  readonly subscriptionType?: string;
}

export interface ClaudeCodeAccount {
  readonly label: string;
  readonly source: string;
  readonly credentials: ClaudeCodeCredentials;
}

export interface ClaudeCodeCredentialSource {
  readonly list: () => Promise<ClaudeCodeAccount[]>;
  readonly read: (source: string) => Promise<ClaudeCodeCredentials | null>;
  readonly write: (
    source: string,
    credentials: ClaudeCodeCredentials,
  ) => Promise<boolean>;
  readonly refreshWithCli: () => Promise<void>;
}

export interface ClaudeCodeCredentialStore {
  readonly accounts: () => Promise<ClaudeCodeAccount[]>;
  readonly resolve: (source: string) => Promise<ClaudeCodeCredentials | null>;
  readonly reload: (source: string) => Promise<ClaudeCodeCredentials | null>;
}

export interface ClaudeCodeRequestEvent {
  readonly event: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

const primaryService = "Claude Code-credentials";
const oauthURL = "https://claude.ai/v1/oauth/token";
const oauthClientID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const expiryBuffer = 60_000;
const cacheTTL = 30_000;

export function parseClaudeCodeCredentials(
  raw: string,
): ClaudeCodeCredentials | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!record(parsed)) return null;
  const value = record(parsed.claudeAiOauth) ? parsed.claudeAiOauth : parsed;
  if (record(parsed.mcpOAuth) && typeof value.accessToken !== "string")
    return null;
  if (
    typeof value.accessToken !== "string" ||
    !value.accessToken.trim() ||
    typeof value.refreshToken !== "string" ||
    typeof value.expiresAt !== "number"
  )
    return null;
  return {
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    expiresAt: Math.trunc(value.expiresAt),
    subscriptionType:
      typeof value.subscriptionType === "string"
        ? value.subscriptionType
        : undefined,
  };
}

export function buildClaudeCodeAccountLabels(
  credentials: ReadonlyArray<ClaudeCodeCredentials>,
) {
  const base = credentials.map((item) =>
    item.subscriptionType
      ? `Claude ${item.subscriptionType.charAt(0).toUpperCase()}${item.subscriptionType.slice(1)}`
      : "Claude",
  );
  const counts = new Map<string, number>();
  base.forEach((label) => counts.set(label, (counts.get(label) ?? 0) + 1));
  const seen = new Map<string, number>();
  return base.map((label) => {
    if ((counts.get(label) ?? 0) === 1) return label;
    const index = (seen.get(label) ?? 0) + 1;
    seen.set(label, index);
    return `${label} ${index}`;
  });
}

export function buildClaudeCodeKeychainUpdate(
  source: string,
  account: string,
  value: string,
) {
  const quote = (input: string) =>
    `"${input.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  return {
    command: "/usr/bin/security",
    args: ["-i"] as const,
    input: `add-generic-password -s ${quote(source)} -a ${quote(account)} -U -X ${Buffer.from(value).toString("hex")}\n`,
  };
}

export function createSystemClaudeCodeCredentialSource(
  input: {
    readonly home?: string;
    readonly platform?: NodeJS.Platform;
  } = {},
): ClaudeCodeCredentialSource {
  const home = input.home ?? homedir();
  const platform = input.platform ?? process.platform;
  const file = join(home, ".claude", ".credentials.json");

  const readKeychain = (service: string) => {
    try {
      return execFileSync(
        "/usr/bin/security",
        ["find-generic-password", "-s", service, "-w"],
        {
          timeout: 2_000,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      ).trim();
    } catch (cause) {
      const error = record(cause) ? cause : {};
      const status =
        typeof error.status === "number" ? error.status : undefined;
      const code = typeof error.code === "string" ? error.code : undefined;
      if (status === 44) return null;
      if (error.killed === true || code === "ETIMEDOUT")
        throw new Error("Claude Code Keychain read timed out", { cause });
      if (status === 36) throw new Error("macOS Keychain is locked", { cause });
      if (status === 128)
        throw new Error("macOS Keychain access was denied", { cause });
      throw new Error(`Failed to read Claude Code Keychain entry ${service}`, {
        cause,
      });
    }
  };

  const readFile = () => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return null;
    }
  };

  const services = () => {
    if (platform !== "darwin") return [];
    try {
      const output = execFileSync("/usr/bin/security", ["dump-keychain"], {
        timeout: 5_000,
        maxBuffer: 10 * 1024 * 1024,
        encoding: "utf8",
      });
      const found = [
        ...output.matchAll(/"(Claude Code-credentials(?:-[0-9a-f]+)?)"/g),
      ].map((match) => match[1]);
      const unique = [...new Set(found)];
      return unique.toSorted((left, right) => {
        if (left === primaryService) return -1;
        if (right === primaryService) return 1;
        return left.localeCompare(right);
      });
    } catch {
      return [primaryService];
    }
  };

  const read = async (source: string) =>
    parseClaudeCodeCredentials(
      source === "file" ? (readFile() ?? "") : (readKeychain(source) ?? ""),
    );

  return {
    list: async () => {
      const keychain = await Promise.all(
        services().map(async (source) => {
          const credentials = await read(source);
          return credentials ? { source, credentials } : undefined;
        }),
      );
      const available = keychain.filter(
        (item): item is NonNullable<typeof item> => item !== undefined,
      );
      if (available.length === 0) {
        const credentials = await read("file");
        if (credentials) available.push({ source: "file", credentials });
      }
      const labels = buildClaudeCodeAccountLabels(
        available.map((item) => item.credentials),
      );
      return available.map((item, index) => ({
        ...item,
        label: labels[index] ?? "Claude",
      }));
    },
    read,
    write: async (source, credentials) => {
      if (source === "file") {
        try {
          const updated = updateCredentialBlob(
            readFileSync(file, "utf8"),
            credentials,
          );
          if (!updated) return false;
          writeFileSync(file, updated, { encoding: "utf8", mode: 0o600 });
          if (platform !== "win32") chmodSync(file, 0o600);
          return true;
        } catch {
          return false;
        }
      }
      if (platform !== "darwin") return false;
      try {
        const raw = readKeychain(source);
        if (!raw) return false;
        const updated = updateCredentialBlob(raw, credentials);
        if (!updated) return false;
        const command = buildClaudeCodeKeychainUpdate(
          source,
          keychainAccount(source) ?? source,
          updated,
        );
        execFileSync(command.command, command.args, {
          input: command.input,
          timeout: 2_000,
          stdio: ["pipe", "ignore", "ignore"],
        });
        return true;
      } catch {
        return false;
      }
    },
    refreshWithCli: async () => {
      try {
        execFileSync("claude", ["-p", ".", "--model", "haiku"], {
          timeout: 60_000,
          encoding: "utf8",
          env: { ...process.env, TERM: "dumb" },
          stdio: "ignore",
          cwd: tmpdir(),
        });
      } catch {}
    },
  };
}

export function createClaudeCodeCredentialStore(input: {
  readonly source: ClaudeCodeCredentialSource;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly cacheTTL?: number;
  readonly onEvent?: (event: ClaudeCodeRequestEvent) => void;
}): ClaudeCodeCredentialStore {
  const fetcher = input.fetch ?? fetch;
  const now = input.now ?? Date.now;
  const ttl = input.cacheTTL ?? cacheTTL;
  const cache = new Map<
    string,
    { readonly credentials: ClaudeCodeCredentials; readonly cachedAt: number }
  >();
  const refreshing = new Map<string, Promise<ClaudeCodeCredentials | null>>();
  let knownAccounts: ClaudeCodeAccount[] = [];
  const fresh = (value: ClaudeCodeCredentials) =>
    value.expiresAt > now() + expiryBuffer;
  const remember = (source: string, credentials: ClaudeCodeCredentials) => {
    cache.set(source, { credentials, cachedAt: now() });
    return credentials;
  };

  const refresh = async (source: string, current: ClaudeCodeCredentials) => {
    const active = refreshing.get(source);
    if (active) return active;
    const operation = (async () => {
      if (current.refreshToken) {
        const refreshed = await refreshOAuth(
          current.refreshToken,
          fetcher,
          now(),
        );
        const next = refreshed
          ? { ...refreshed, subscriptionType: current.subscriptionType }
          : null;
        if (next && fresh(next)) {
          const written = await input.source.write(source, next);
          input.onEvent?.({
            event: "oauth-refresh",
            data: { source, written },
          });
          return remember(source, next);
        }
      }
      await input.source.refreshWithCli();
      const next = await input.source.read(source);
      if (!next || !fresh(next)) return null;
      input.onEvent?.({ event: "cli-refresh", data: { source } });
      return remember(source, next);
    })().finally(() => refreshing.delete(source));
    refreshing.set(source, operation);
    return operation;
  };

  const reload = async (source: string) => {
    let credentials: ClaudeCodeCredentials | null;
    try {
      credentials = await input.source.read(source);
    } catch {
      cache.delete(source);
      return null;
    }
    if (
      !credentials ||
      !credentials.accessToken.trim() ||
      !fresh(credentials)
    ) {
      cache.delete(source);
      return null;
    }
    return remember(source, credentials);
  };

  const resolve = async (source: string) => {
    const time = now();
    const cached = cache.get(source);
    if (cached && time - cached.cachedAt < ttl && fresh(cached.credentials))
      return cached.credentials;
    let current: ClaudeCodeCredentials | null;
    try {
      current =
        (await input.source.read(source)) ?? cached?.credentials ?? null;
    } catch {
      current = cached?.credentials ?? null;
    }
    if (!current) {
      cache.delete(source);
      return null;
    }
    if (fresh(current)) return remember(source, current);
    return refresh(source, current);
  };

  return {
    accounts: async () => {
      const discovered = await input.source.list();
      if (discovered.length === 0 && knownAccounts.length > 0)
        return knownAccounts;
      knownAccounts = discovered;
      discovered.forEach((account) => {
        if (fresh(account.credentials))
          remember(account.source, account.credentials);
      });
      return knownAccounts;
    },
    resolve,
    reload,
  };
}

export function parseClaudeCodeOAuthResponse(
  raw: string,
  refreshToken: string,
  now = Date.now(),
): ClaudeCodeCredentials | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !record(parsed) ||
    typeof parsed.access_token !== "string" ||
    !parsed.access_token.trim()
  )
    return null;
  const expires =
    typeof parsed.expires_in === "number" ? parsed.expires_in : 36_000;
  return {
    accessToken: parsed.access_token,
    refreshToken:
      typeof parsed.refresh_token === "string"
        ? parsed.refresh_token
        : refreshToken,
    expiresAt: Math.trunc(now + expires * 1_000),
  };
}

export function loadClaudeCodeAccountSource(file: string) {
  try {
    return readFileSync(file, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

export function saveClaudeCodeAccountSource(file: string, source: string) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") chmodSync(file, 0o600);
}

async function refreshOAuth(
  refreshToken: string,
  fetcher: typeof fetch,
  now: number,
) {
  try {
    const response = await fetcher(oauthURL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: oauthClientID,
        refresh_token: refreshToken,
      }),
    });
    if (!response.ok) return null;
    return parseClaudeCodeOAuthResponse(
      await response.text(),
      refreshToken,
      now,
    );
  } catch {
    return null;
  }
}

function updateCredentialBlob(raw: string, credentials: ClaudeCodeCredentials) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!record(parsed)) return null;
  const target = record(parsed.claudeAiOauth) ? parsed.claudeAiOauth : parsed;
  target.accessToken = credentials.accessToken;
  target.refreshToken = credentials.refreshToken;
  target.expiresAt = credentials.expiresAt;
  return JSON.stringify(parsed);
}

function keychainAccount(service: string) {
  try {
    const output = execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", service],
      {
        timeout: 2_000,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return /"acct"<blob>="([^"]*)"/.exec(output)?.[1];
  } catch {
    return undefined;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
