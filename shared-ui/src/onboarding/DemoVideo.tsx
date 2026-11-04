"use client";

import { useEffect, useRef, useState } from "react";

export interface DemoVideoSource {
  /** Each app serves the file from its own place, so the host supplies the URLs. */
  src: string;
  poster: string;
  alt: string;
}

/** A silent looping demo. With reduced motion on it stays on the poster and shows controls instead. */
export function DemoVideo({ src, poster, alt }: DemoVideoSource) {
  const ref = useRef<HTMLVideoElement>(null);
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setReducedMotion(true);
    ref.current?.pause();
  }, []);

  return (
    <video
      ref={ref}
      className="ui-demo-video"
      autoPlay
      muted
      loop
      playsInline
      preload="auto"
      controls={reducedMotion}
      poster={poster}
      aria-label={alt}
    >
      <source src={src} type="video/mp4" />
    </video>
  );
}
