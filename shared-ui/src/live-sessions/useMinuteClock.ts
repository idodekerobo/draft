"use client";

import { useEffect, useState } from "react";

const MINUTE_MS = 60_000;

/** Now, refreshed once a minute, for status words and relative times that change slowly. */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}
