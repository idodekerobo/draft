'use client';

import { useEffect } from 'react';
import { usePostHog } from 'posthog-js/react';
import { EVENTS } from '@/lib/analytics';

// Maps element IDs/data-section attributes to canonical section names
const SECTIONS = [
  { id: 'features', name: 'features' },
  { id: 'integrations', name: 'integrations' },
  { id: 'how-it-works', name: 'how_it_works' },
  { id: 'for-who', name: 'for_who' },
];

export function SectionObserver() {
  const ph = usePostHog();

  useEffect(() => {
    if (!ph) return;

    const observers: IntersectionObserver[] = [];

    SECTIONS.forEach(({ id, name }) => {
      const el =
        document.getElementById(id) ||
        document.querySelector<HTMLElement>(`[data-section="${id}"]`);
      if (!el) return;

      const observer = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting) {
            ph.capture(EVENTS.SECTION_VIEWED, { section: name });
            observer.disconnect(); // fire once per session
          }
        },
        { threshold: 0.3 }
      );

      observer.observe(el);
      observers.push(observer);
    });

    return () => observers.forEach((o) => o.disconnect());
  }, [ph]);

  return null;
}
