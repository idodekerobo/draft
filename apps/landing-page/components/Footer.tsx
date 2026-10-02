"use client";

import Link from "next/link";

import { usePostHog } from "posthog-js/react";
import { EVENTS } from "@/lib/analytics";
import DraftLogo from "@/components/DraftLogo";

const links = [
  { label: "Features", href: "/#features" },
  { label: "Support", href: "/support" },
  { label: "Privacy", href: "/privacy-policy" },
  { label: "Terms", href: "/terms" },
];

export default function Footer() {
  const ph = usePostHog();
  return (
    <footer className="minimal-footer minimal-shell">
      <DraftLogo href="/" />
      <span>© {new Date().getFullYear()} Draft</span>
      <nav aria-label="Footer navigation">
        {links.map(({ label, href }) => <Link key={href} href={href} onClick={() => ph?.capture(EVENTS.NAV_LINK_CLICKED, { source: "footer", label })}>{label}</Link>)}
      </nav>
    </footer>
  );
}
