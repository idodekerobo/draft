import { readDraftConfig, writeDraftConfig } from "../config";
import { migrations, CURRENT_MIGRATION } from "./index";

export async function runMigrations(): Promise<void> {
  const result = readDraftConfig();
  const config = result.ok ? result.config : { version: "1", tools: {} };
  const lastTs = config.last_migration ?? 0;

  if (lastTs >= CURRENT_MIGRATION) return;

  const pending = Object.keys(migrations)
    .map(Number)
    .filter(ts => ts > lastTs)
    .sort((a, b) => a - b);

  for (const ts of pending) {
    try {
      await migrations[ts]();
      config.last_migration = ts;
      writeDraftConfig({ ...config });
    } catch (err) {
      console.error(`[draft] migration ${ts} failed:`, err);
      return;
    }
  }
}
