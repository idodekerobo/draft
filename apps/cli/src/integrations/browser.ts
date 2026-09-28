export interface BrowserLauncher {
  launchBrowser(url: string): Promise<{ opened: boolean }>;
}

export interface BrowserLauncherDeps {
  platform: NodeJS.Platform;
  spawn(argv: string[]): Promise<number>;
}

const defaultBrowserDeps: BrowserLauncherDeps = {
  platform: process.platform,
  spawn: async (argv) => {
    const child = Bun.spawn({
      cmd: argv,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    return child.exited;
  },
};

function allowedBrowserUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "file:";
  } catch {
    return false;
  }
}

export class PosixBrowserLauncher implements BrowserLauncher {
  constructor(private readonly deps: BrowserLauncherDeps = defaultBrowserDeps) {}

  async launchBrowser(url: string): Promise<{ opened: boolean }> {
    if (!allowedBrowserUrl(url)) return { opened: false };
    const executable = this.deps.platform === "darwin"
      ? "/usr/bin/open"
      : this.deps.platform === "linux"
        ? "/usr/bin/xdg-open"
        : null;
    if (!executable) return { opened: false };
    try {
      return { opened: await this.deps.spawn([executable, url]) === 0 };
    } catch {
      return { opened: false };
    }
  }
}

export const browserLauncher: BrowserLauncher = new PosixBrowserLauncher();
