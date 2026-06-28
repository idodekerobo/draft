import m20260628 from "./20260628000000_initial_framework";

export const migrations: Record<number, () => void | Promise<void>> = {
  20260628000000: m20260628,
};

export const CURRENT_MIGRATION = Math.max(...Object.keys(migrations).map(Number));
