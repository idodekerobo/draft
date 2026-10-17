"use client";

import Image from "next/image";
import { FormEvent, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePostHog } from "posthog-js/react";
import { EVENTS } from "@/lib/analytics";
import { buildCalLink, CAL_BASE } from "@/lib/attribution";
import { submitWaitlist } from "@/lib/waitlist";
import WaitlistProfileStep from "@/components/WaitlistProfileStep";
import PostSignupCall, { CalEmbed } from "@/components/PostSignupCall";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import { OrbComposing } from "@/components/ui/thinking-orb";

const DESKTOP_QUERY = "(min-width: 901px)";
const subscribeNoop = () => () => {};
const subscribeDesktop = (onChange: () => void) => {
  const query = window.matchMedia(DESKTOP_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};
const getIsDesktop = () => window.matchMedia(DESKTOP_QUERY).matches;

type SubmitState = "idle" | "submitting" | "success" | "error";
type CtaLocation = "hero" | "sticky_bar" | "closing";

const WHAT_DRAFT_DOES = [
  {
    title: "A shared company brain",
    body: "Pulls context from Slack, GitHub, Linear, GMail, meetings, and more. Keeps it current as your team works.",
  },
  {
    title: "Routines on any agent",
    body: "Schedule recurring jobs, like a daily summary of your team's action items, and run them with the agent you prefer.",
  },
  {
    title: "Shared coding sessions",
    body: "Work in the same session as a teammate, with any agent (Claude Code, Codex, and more) you like.",
    soon: true,
  },
];

function GetStartedOrb({ mobile = false }: { mobile?: boolean }) {
  return (
    <div className={`getstarted-orb ${mobile ? "getstarted-orb-mobile" : "getstarted-orb-desktop"}`} aria-hidden="true">
      <OrbComposing size={380} scale={0.94} speed={0.65} pointerFollow style={{ width: "100%", height: "auto", aspectRatio: "1" }} />
    </div>
  );
}

export default function GetStartedPage() {
  const ph = usePostHog();
  const emailRef = useRef<HTMLInputElement>(null);
  const [waitlistOpen, setWaitlistOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [submitState, setSubmitState] = useState<SubmitState>("idle");
  const calHref = useSyncExternalStore(subscribeNoop, buildCalLink, () => CAL_BASE);
  const isDesktop = useSyncExternalStore(subscribeDesktop, getIsDesktop, () => false);
  const [callOpen, setCallOpen] = useState(false);
  const sideCal = callOpen && isDesktop;
  const copyRef = useRef<HTMLDivElement>(null);
  const closingRef = useRef<HTMLElement>(null);
  const [copyVisible, setCopyVisible] = useState(true);
  const [closingVisible, setClosingVisible] = useState(false);
  const showStickyBar = !copyVisible && !closingVisible && submitState !== "success";

  useEffect(() => {
    if (waitlistOpen) emailRef.current?.focus();
  }, [waitlistOpen]);

  useEffect(() => {
    const copy = copyRef.current;
    const closing = closingRef.current;
    if (!copy || !closing) return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === copy) setCopyVisible(entry.isIntersecting);
        else setClosingVisible(entry.isIntersecting);
      }
    });
    observer.observe(copy);
    observer.observe(closing);
    return () => observer.disconnect();
  }, []);

  const handleOpenWaitlist = (location: CtaLocation) => {
    setWaitlistOpen(true);
    ph?.capture(EVENTS.WAITLIST_OPENED, { source: "getstarted", location });
    ph?.capture(EVENTS.CTA_CLICKED, {
      source: "getstarted",
      cta_text: "Join the waitlist",
      location,
    });
    if (location !== "hero") {
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      copyRef.current?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    }
  };

  const renderActions = (location: Extract<CtaLocation, "hero" | "closing">) => (
    <div className="getstarted-actions">
      <button
        type="button"
        className="minimal-button getstarted-primary"
        onClick={() => handleOpenWaitlist(location)}
        aria-expanded={waitlistOpen}
        aria-controls="getstarted-waitlist"
      >
        Join the waitlist
        <span aria-hidden="true">↗</span>
      </button>
      <a
        className="getstarted-call-link"
        href={calHref}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => ph?.capture(EVENTS.CTA_CLICKED, { source: "getstarted", cta_text: "Book a Call", location })}
      >
        Book a Call <span aria-hidden="true">↗</span>
      </a>
    </div>
  );

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitState("submitting");

    try {
      await submitWaitlist(email, "getstarted");
      setSubmitState("success");
    } catch {
      setSubmitState("error");
    }
  };

  return (
    <main className={`getstarted-page${sideCal ? " is-call-open" : ""}`}>
      <Nav showWaitlist={false} />
      <section className="getstarted-panel" aria-labelledby="getstarted-title">


        <GetStartedOrb mobile />

        <div className="getstarted-copy" ref={copyRef}>
          <h1 id="getstarted-title">One brain for every agent your team uses.</h1>
          <p className="getstarted-lede">
            Draft keeps your company&apos;s decisions, customer context, and priorities current. Every AI agent can read them.
          </p>

          {renderActions("hero")}

          {waitlistOpen && (
            <div id="getstarted-waitlist" className="getstarted-waitlist is-open">
              {submitState === "success" ? (
                <>
                  <p className="getstarted-success" role="status">
                    You&apos;re on the list. We&apos;ll be in touch ASAP.
                  </p>
                  <PostSignupCall
                    email={email}
                    source="getstarted"
                    open={callOpen}
                    onOpenChange={setCallOpen}
                    inlineEmbed={!isDesktop}
                  />
                  <WaitlistProfileStep email={email} source="getstarted" />
                </>
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

      {sideCal && (
        <aside className="getstarted-cal" aria-label="Book a call">
          <CalEmbed email={email} source="getstarted" />
        </aside>
      )}

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

      <div className="getstarted-story">
        <section className="getstarted-story-block" aria-labelledby="getstarted-problem">
          <h2 id="getstarted-problem">Your agents start every session knowing nothing about your company.</h2>
          <p>
            Decisions live in Slack threads, call notes, and old tickets. Each agent has to be told again, and each teammate tells it something different.
          </p>
        </section>

        <section className="getstarted-story-block" aria-labelledby="getstarted-what">
          <h2 id="getstarted-what">What Draft does</h2>
          <ul className="getstarted-rows">
            {WHAT_DRAFT_DOES.map((item) => (
              <li key={item.title}>
                <h3>
                  {item.title}
                  {item.soon && <span className="getstarted-soon">Coming soon</span>}
                </h3>
                <p>{item.body}</p>
                {/* TODO: add the Routines screen recording under the "Routines on any agent" row */}
              </li>
            ))}
          </ul>
        </section>

        <p className="getstarted-agents">Works with Claude Code, Codex, Cursor, and more, through MCP or CLI.</p>

        <section className="getstarted-story-block getstarted-closing" ref={closingRef} aria-labelledby="getstarted-closing-title">
          <h2 id="getstarted-closing-title">Give every agent the same brain.</h2>
          {renderActions("closing")}
        </section>
      </div>

      {showStickyBar && (
        <div className="getstarted-sticky">
          <button
            type="button"
            className="minimal-button getstarted-primary"
            onClick={() => handleOpenWaitlist("sticky_bar")}
          >
            Join the waitlist
            <span aria-hidden="true">↗</span>
          </button>
        </div>
      )}
      <Footer />
    </main>
  );
}
