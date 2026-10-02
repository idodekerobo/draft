"use client";

import Image from "next/image";
import { FormEvent, useEffect, useRef, useState } from "react";
import { usePostHog } from "posthog-js/react";
import { EVENTS } from "@/lib/analytics";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import { OrbComposing } from "@/components/ui/thinking-orb";

const CAL_LINK = "https://cal.com/idode/learn-about-draft";

type SubmitState = "idle" | "submitting" | "success" | "error";

function GetStartedOrb({ mobile = false }: { mobile?: boolean }) {
  return (
    <div className={`getstarted-orb ${mobile ? "getstarted-orb-mobile" : "getstarted-orb-desktop"}`} aria-hidden="true">
      <OrbComposing size={380} scale={0.94} speed={0.65} style={{ width: "100%", height: "auto", aspectRatio: "1" }} />
    </div>
  );
}

export default function GetStartedPage() {
  const ph = usePostHog();
  const emailRef = useRef<HTMLInputElement>(null);
  const [waitlistOpen, setWaitlistOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [submitState, setSubmitState] = useState<SubmitState>("idle");

  useEffect(() => {
    if (waitlistOpen) emailRef.current?.focus();
  }, [waitlistOpen]);

  const handleOpenWaitlist = () => {
    setWaitlistOpen(true);
    ph?.capture(EVENTS.WAITLIST_OPENED, { source: "getstarted" });
    ph?.capture(EVENTS.CTA_CLICKED, {
      source: "getstarted",
      cta_text: "Join the waitlist",
    });
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitState("submitting");

    try {
      const response = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, source: "getstarted" }),
      });

      if (!response.ok) throw new Error("Waitlist submission failed");

      ph?.capture(EVENTS.WAITLIST_SUBMITTED, { source: "getstarted" });
      setSubmitState("success");
    } catch {
      setSubmitState("error");
    }
  };

  return (
    <main className="getstarted-page">
      <Nav showWaitlist={false} />
      <section className="getstarted-panel" aria-labelledby="getstarted-title">


        <GetStartedOrb mobile />

        <div className="getstarted-copy">
          <h1 id="getstarted-title">
            Get started with <span>Draft.</span>
          </h1>
          <p className="getstarted-lede">Your agents are moving fast. Give them a shared brain.</p>
          <p className="getstarted-body">
            Draft keeps your company&apos;s decisions, customer context, and priorities in one current place—so your team and every AI agent can work from the same source of truth.
          </p>

          <div className="getstarted-actions">
            <button
              type="button"
              className="minimal-button getstarted-primary"
              onClick={handleOpenWaitlist}
              aria-expanded={waitlistOpen}
              aria-controls="getstarted-waitlist"
            >
              Join the waitlist
              <span aria-hidden="true">↗</span>
            </button>
            <a
              className="getstarted-call-link"
              href={CAL_LINK}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => ph?.capture(EVENTS.CTA_CLICKED, { source: "getstarted", cta_text: "Book a Call" })}
            >
              Book a Call <span aria-hidden="true">↗</span>
            </a>
          </div>

          {waitlistOpen && (
            <div id="getstarted-waitlist" className="getstarted-waitlist is-open">
              {submitState === "success" ? (
                <p className="getstarted-success" role="status">
                  You&apos;re on the list. We&apos;ll be in touch when Draft is ready.
                </p>
              ) : (
                <form onSubmit={handleSubmit}>
                  <label htmlFor="getstarted-email">Enter your email and we&apos;ll let you know when Draft is ready.</label>
                  <div className="getstarted-form-row">
                    <input
                      ref={emailRef}
                      id="getstarted-email"
                      name="email"
                      type="email"
                      required
                      autoComplete="email"
                      placeholder="you@company.com"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      disabled={submitState === "submitting"}
                    />
                    <button type="submit" disabled={submitState === "submitting"}>
                      {submitState === "submitting" ? "Joining…" : "Join waitlist"}
                    </button>
                  </div>
                  {submitState === "error" && (
                    <p className="getstarted-error" role="alert">
                      Something went wrong. Please try again.
                    </p>
                  )}
                </form>
              )}
            </div>
          )}
        </div>


      </section>

      <figure className="getstarted-media">
        <GetStartedOrb />
        <div className="getstarted-media-frame">
          <Image
            src="/agent-loading-action-items.gif"
            alt="Draft preparing action items from company context"
            width={1472}
            height={1080}
            priority
            unoptimized
            sizes="(max-width: 600px) 90vw, (max-width: 900px) 560px, 42vw"
          />
        </div>
        <figcaption>One company brain. Every agent in sync.</figcaption>
      </figure>
      <Footer />
    </main>
  );
}
