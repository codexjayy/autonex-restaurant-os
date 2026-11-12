import { chromium, defineConfig, devices } from '@playwright/test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function resolveChromiumExecutable(): string | undefined {
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH && existsSync(process.env.PLAYWRIGHT_CHROMIUM_PATH)) {
    return process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }

  try {
    const defaultExe = chromium.executablePath();
    if (defaultExe && existsSync(defaultExe)) {
      return defaultExe;
    }
  } catch {
    // Fall back to cached browser discovery below
  }

  const cacheRoot = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'ms-playwright')
    : undefined;
  if (cacheRoot && existsSync(cacheRoot)) {
    for (const entry of readdirSync(cacheRoot)) {
      if (entry.startsWith('chromium_headless_shell-')) {
        const candidate = join(cacheRoot, entry, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
        if (existsSync(candidate)) return candidate;
      }
      if (entry.startsWith('chromium-')) {
        const candidate = join(cacheRoot, entry, 'chrome-win64', 'chrome.exe');
        if (existsSync(candidate)) return candidate;
      }
    }
  }

  return undefined;
}

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3100);
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${port}`;
const executablePath = resolveChromiumExecutable();

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'on-first-retry',
    headless: true,
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: `pnpm next start -p ${port}`,
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
