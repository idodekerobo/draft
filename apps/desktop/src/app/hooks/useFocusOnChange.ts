import { useEffect, useRef } from "react";

/** Moves focus to the returned element when `value` changes, so a button that leaves the page does not take focus with it. Not on the first render. */
export function useFocusOnChange<T extends HTMLElement>(value: unknown) {
  const ref = useRef<T>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    ref.current?.focus();
  }, [value]);
  return ref;
}
