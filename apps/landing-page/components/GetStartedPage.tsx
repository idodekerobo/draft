"use client";

import Image from "next/image";
import { FormEvent, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePostHog } from "posthog-js/react";
import { EVENTS } from "@/lib/analytics";
import { submitWaitlist } from "@/lib/waitlist";
import type { ProfileAnswers } from "@/lib/waitlist-questions";
import WaitlistProfileStep from "@/components/WaitlistProfileStep";
import { CalEmbed } from "@/components/PostSignupCall";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import { OrbComposing } from "@/components/ui/thinking-orb";
import { DEFAULT_CONTENT, type GetStartedContent } from "@/lib/getstarted-content";

const DESKTOP_QUERY = "(min-width: 901px)";
const subscribeDesktop = (onChange: () => void) => {
  const query = window.matchMedia(DESKTOP_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};
const getIsDesktop = () => window.matchMedia(DESKTOP_QUERY).matches;

type SubmitState = "idle" | "submitting" | "success" | "error";
type CtaLocation = "hero" | "sticky_bar" | "closing";

function GetStartedOrb({ mobile = false }: { mobile?: boolean }) {
  return (
    <div className={`getstarted-orb ${mobile ? "getstarted-orb-mobile" : "getstarted-orb-desktop"}`} aria-hidden="true">
      <OrbComposing size={380} scale={0.94} speed={0.65} pointerFollow style={{ width: "100%", height: "auto", aspectRatio: "1" }} />
    </div>
  );
}

function DownloadLink({
  primary,
  label,
  href,
  onClick,
}: {
  primary: boolean;
  label: string;
  href: string;
  onClick: () => void;
}) {
  return (
    <a href={href} className={primary ? "minimal-button getstarted-primary" : "getstarted-call-link"} onClick={onClick}>
      {label} <span aria-hidden="true">↗</span>
    </a>
  );
}

function CtaButton({
  primary,
  label,
  onClick,
  expanded,
  controls,
}: {
  primary: boolean;
  label: string;
  onClick: () => void;
  expanded: boolean;
  controls?: string;
}) {
  return (
    <button
      type="button"
      className={primary ? "minimal-button getstarted-primary" : "getstarted-call-link"}
      onClick={onClick}
      aria-expanded={expanded}
      aria-controls={controls}
    >
      {label} <span aria-hidden="true">↗</span>
    </button>
  );
}

export default function GetStartedPage({ content = DEFAULT_CONTENT }: { content?: GetStartedContent }) {
  const { source, media } = content;
  const ph = usePostHog();
  const emailRef = useRef<HTMLInputElement>(null);
  const [waitlistOpen, setWaitlistOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [signupToken, setSignupToken] = useState("");
  const [submitState, setSubmitState] = useState<SubmitState>("idle");
  const isDesktop = useSyncExternalStore(subscribeDesktop, getIsDesktop, () => false);
  const [callOpen, setCallOpen] = useState(false);
  const [profile, setProfile] = useState<ProfileAnswers>({});
  const [profileDone, setProfileDone] = useState(false);
  const sideCal = callOpen && isDesktop;
  const calRef = useRef<HTMLDivElement>(null);
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
    ph?.capture(EVENTS.WAITLIST_OPENED, { source, location });
    ph?.capture(EVENTS.CTA_CLICKED, {
      source,
      cta_text: "Join the waitlist",
      location,
    });
    if (location !== "hero") {
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      copyRef.current?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    }
  };

  const handleOpenCall = (location: CtaLocation) => {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const behavior = reduceMotion ? "auto" : "smooth";
    ph?.capture(EVENTS.CTA_CLICKED, { source, cta_text: "Book a Call", location });
    if (callOpen) {
      calRef.current?.scrollIntoView({ behavior, block: "start" });
      return;
    }
    setCallOpen(true);
    ph?.capture(EVENTS.CALL_EMBED_OPENED, { source, location });
    if (location !== "hero") copyRef.current?.scrollIntoView({ behavior, block: "start" });
  };

  const handleProfileDone = (answers: ProfileAnswers) => {
    setProfile(answers);
    setProfileDone(true);
    if (!callOpen) handleOpenCall("hero");
  };

  const waitlistPrimary = content.primaryCta === "waitlist";
  const downloadPrimary = content.primaryCta === "download";

  const handleDownloadClick = (location: CtaLocation) => {
    ph?.capture(EVENTS.DOWNLOAD_CLICKED, { source, location });
  };

  const downloadLink = (primary: boolean, location: CtaLocation) => (
    <DownloadLink
      primary={primary}
      label={content.downloadLabel ?? "Download"}
      href={content.downloadHref ?? "/download"}
      onClick={() => handleDownloadClick(location)}
    />
  );

  const renderActions = (location: Extract<CtaLocation, "hero" | "closing">) => {
    const call = (
      <CtaButton
        primary={!waitlistPrimary}
        label={content.callLabel}
        onClick={() => handleOpenCall(location)}
        expanded={callOpen}
      />
    );
    const waitlist = (
      <CtaButton
        primary={waitlistPrimary}
        label={content.waitlistLabel}
        onClick={() => handleOpenWaitlist(location)}
        expanded={waitlistOpen}
        controls="getstarted-waitlist"
      />
    );
    if (downloadPrimary) {
      // The call is offered after signup, so only download and waitlist show here.
      return (
        <div className="getstarted-actions">
          {downloadLink(true, location)}
          {content.downloadNote && <p className="getstarted-download-note">{content.downloadNote}</p>}
          {waitlist}
        </div>
      );
    }
    return (
      <div className="getstarted-actions">
        {waitlistPrimary ? waitlist : call}
        {waitlistPrimary ? call : waitlist}
      </div>
    );
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitState("submitting");

    try {
      const result = await submitWaitlist(email, source);
      setSignupToken(result.signup_token);
      setSubmitState("success");
    } catch {
      setSubmitState("error");
    }
  };

  return (
    <main className={`getstarted-page${sideCal ? " is-call-open" : ""}`}>
      <Nav showWaitlist={false} />
      <section className="getstarted-panel" aria-labelledby="getstarted-title">

        <div className="getstarted-copy" ref={copyRef}>
          <h1 id="getstarted-title">{content.heading}</h1>
          <p className="getstarted-lede">{content.lede}</p>

          {renderActions("hero")}

          {waitlistOpen && (
            <div id="getstarted-waitlist" className="getstarted-waitlist is-open">
              {submitState === "success" ? (
                <>
                  <p className="getstarted-success" role="status">
                    {profileDone ? "Thanks. Pick a time to talk." : "Thanks. We'll be in touch soon."}
                  </p>
                  <WaitlistProfileStep signupToken={signupToken} source={source} onDone={handleProfileDone} />
                </>
              ) : (
                <form onSubmit={handleSubmit}>
                  <label htmlFor="getstarted-email">Leave your email and we&apos;ll reach out to see if Draft fits your team.</label>
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
                      {submitState === "submitting" ? "Sending…" : "Send"}
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

          {callOpen && !isDesktop && (
            <div ref={calRef} style={{ marginTop: "1.25rem" }}>
              <CalEmbed email={email} source={source} profile={profile} />
            </div>
          )}
        </div>
      </section>

      <GetStartedOrb mobile />

      {sideCal && (
        <aside ref={calRef} className="getstarted-cal" aria-label="Book a call">
          <CalEmbed email={email} source={source} profile={profile} />
        </aside>
      )}

      <figure className="getstarted-media">
        <GetStartedOrb />
        <div className="getstarted-media-frame">
          {media.kind === "video" ? (
            <video
              autoPlay
              muted
              loop
              playsInline
              preload="auto"
              poster={media.poster}
              width={media.width}
              height={media.height}
              aria-label={media.alt}
            >
              {media.webm && <source src={media.webm} type="video/webm" />}
              <source src={media.mp4} type="video/mp4" />
            </video>
          ) : (
            <Image
              src={media.src}
              alt={media.alt}
              width={media.width}
              height={media.height}
              priority
              unoptimized
              sizes="(max-width: 600px) 90vw, (max-width: 900px) 560px, 42vw"
            />
          )}
        </div>
        <figcaption>{content.caption}</figcaption>
      </figure>

      <div className="getstarted-story">
        <section className="getstarted-story-block" aria-labelledby="getstarted-problem">
          <h2 id="getstarted-problem">{content.problemHeading}</h2>
          <p>{content.problemBody}</p>
        </section>

        <section className="getstarted-story-block" aria-labelledby="getstarted-what">
          <h2 id="getstarted-what">{content.whatHeading}</h2>
          <ul className="getstarted-rows">
            {content.rows.map((item) => (
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

        <p className="getstarted-agents">{content.agentsLine}</p>

        <section className="getstarted-story-block getstarted-closing" ref={closingRef} aria-labelledby="getstarted-closing-title">
          <h2 id="getstarted-closing-title">{content.closingHeading}</h2>
          {renderActions("closing")}
        </section>
      </div>

      {showStickyBar && (
        <div className="getstarted-sticky">
          {downloadPrimary ? (
            downloadLink(true, "sticky_bar")
          ) : waitlistPrimary ? (
            <CtaButton
              primary
              label={content.waitlistLabel}
              onClick={() => handleOpenWaitlist("sticky_bar")}
              expanded={waitlistOpen}
              controls="getstarted-waitlist"
            />
          ) : (
            <CtaButton primary label={content.callLabel} onClick={() => handleOpenCall("sticky_bar")} expanded={callOpen} />
          )}
        </div>
      )}
      <Footer />
    </main>
  );
}
