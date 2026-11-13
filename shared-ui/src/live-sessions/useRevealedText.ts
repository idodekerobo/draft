import { useEffect, useRef, useState } from "react";
import { nextShown, safeCut } from "./reveal";

type Deps = {
  requestFrame?: (cb: (time: number) => void) => number;
  cancelFrame?: (handle: number) => void;
  reducedMotion?: () => boolean;
};

const FIRST_FRAME_MS = 16;

const prefersReducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** The part of `text` to show. New text is revealed a little at a time; text that replaces the shown part appears at once. */
export function useRevealedText(text: string, deps: Deps = {}): string {
  const requestFrame = deps.requestFrame ?? ((cb: (time: number) => void) => requestAnimationFrame(cb));
  const cancelFrame = deps.cancelFrame ?? ((handle: number) => cancelAnimationFrame(handle));
  const reducedMotion = deps.reducedMotion ?? prefersReducedMotion;

  const [shown, setShown] = useState(text.length);
  const shownRef = useRef(text.length);
  const textRef = useRef(text);
  const frameRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number | null>(null);

  useEffect(() => {
    const previous = textRef.current;
    textRef.current = text;
    const replaced = reducedMotion() || !text.startsWith(previous.slice(0, shownRef.current));
    if (replaced) {
      stop();
      shownRef.current = text.length;
      setShown(text.length);
      return;
    }
    if (frameRef.current === null && shownRef.current < text.length) frameRef.current = requestFrame(tick);

    function tick(time: number) {
      const dt = lastTimeRef.current === null ? FIRST_FRAME_MS : time - lastTimeRef.current;
      lastTimeRef.current = time;
      const target = textRef.current.length;
      const next = safeCut(textRef.current, nextShown(shownRef.current, target, dt));
      shownRef.current = next;
      setShown(next);
      if (next < target) {
        frameRef.current = requestFrame(tick);
      } else {
        frameRef.current = null;
        lastTimeRef.current = null;
      }
    }

    function stop() {
      if (frameRef.current !== null) cancelFrame(frameRef.current);
      frameRef.current = null;
      lastTimeRef.current = null;
    }
  }, [text]);

  useEffect(() => () => {
    if (frameRef.current !== null) cancelFrame(frameRef.current);
  }, []);

  return reducedMotion() ? text : text.slice(0, Math.min(shown, text.length));
}
