"use client";

import { useEffect, useState } from "react";

/**
 * A ticking `Date.now()`.
 *
 * Deadlines are the one thing on this desk that change without anybody clicking:
 * a countdown has to move, and a card has to lock itself the moment the story goes
 * to print. Reading the clock in render would be both impure and frozen, so the time
 * comes from state that an interval advances.
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}
