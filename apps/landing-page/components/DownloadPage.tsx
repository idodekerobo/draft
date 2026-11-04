"use client";

import { useEffect } from "react";
import { usePostHog } from "posthog-js/react";
import Footer from "@/components/Footer";
import Nav from "@/components/Nav";
import { OrbComposing } from "@/components/ui/thinking-orb";
import { EVENTS } from "@/lib/analytics";
import { APP_URL } from "@/lib/config";

// The web app signs people up and sets up their company before it hands them the download.
const SIGNUP_URL = `${APP_URL}/signup?src=download`;

export default function DownloadPage() {
  const ph = usePostHog();

  useEffect(() => {
    ph?.capture(EVENTS.DOWNLOAD_PAGE_VIEWED);
  }, [ph]);

  return (
    <main className="download-page">
      <Nav showWaitlist={false} />
      <section className="download-hero" aria-labelledby="download-title">
        <div className="download-orb" aria-hidden="true">
          <OrbComposing size={380} scale={0.94} speed={0.65} pointerFollow style={{ width: "100%", height: "auto", aspectRatio: "1" }} />
        </div>
        <h1 id="download-title">Download Draft</h1>
        <p className="download-lede">
          Shared context for your team and your AI agents. Create your account and set up your company first, then get the app.
        </p>
        <a
          className="minimal-button download-cta"
          href={SIGNUP_URL}
          onClick={() => ph?.capture(EVENTS.DOWNLOAD_CLICKED, { source: "download_page" })}
        >
          Download for Mac <span aria-hidden="true">↗</span>
        </a>
        <p className="download-note">Apple Silicon Macs only (M1 or later). Intel Macs and Windows are not supported yet.</p>
      </section>
      <Footer />
    </main>
  );
}
