import type { Metadata } from "next";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";

export const metadata: Metadata = {
  title: "Support — Draft",
  description: "Get help with Draft. Reach out to our support team.",
};

export default function SupportPage() {
  return (
    <main>
      <Nav />
      <div
        style={{
          maxWidth: "680px",
          margin: "0 auto",
          padding: "6rem 2rem 4rem",
        }}
      >
        <h1
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "2rem",
            fontWeight: 500,
            color: "var(--color-primary)",
            letterSpacing: "-0.03em",
            marginBottom: "0.75rem",
          }}
        >
          Support
        </h1>
        <p
          style={{
            fontFamily: "var(--font-body)",
            fontSize: "1rem",
            color: "var(--color-muted)",
            lineHeight: 1.7,
            marginBottom: "2.5rem",
          }}
        >
          Have a question, found a bug, or need help getting started? We're here
          for you. Send us an email and we'll get back to you as soon as possible.
        </p>

        <div
          style={{
            border: "1px solid var(--color-border)",
            borderRadius: "12px",
            padding: "2rem",
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.6rem",
              color: "var(--color-faint)",
              letterSpacing: "0.1em",
              textTransform: "uppercase",
            }}
          >
            Email us
          </span>
          <a
            href="mailto:idode.kerobo@gmail.com"
            style={{
              fontFamily: "var(--font-body)",
              fontSize: "1rem",
              color: "var(--color-accent)",
              textDecoration: "none",
              fontWeight: 500,
            }}
          >
            idode.kerobo@gmail.com
          </a>
        </div>
      </div>
      <Footer />
    </main>
  );
}
