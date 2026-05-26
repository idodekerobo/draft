import type { Metadata } from "next";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";

export const metadata: Metadata = {
  title: "Privacy Policy — Draft",
  description: "How Draft collects, uses, and protects your data.",
};

const h2Style: React.CSSProperties = {
  fontFamily: "var(--font-display)",
  fontSize: "1.15rem",
  fontWeight: 500,
  color: "var(--color-primary)",
  letterSpacing: "-0.02em",
  marginTop: "2.5rem",
  marginBottom: "0.75rem",
};

const h3Style: React.CSSProperties = {
  fontFamily: "var(--font-body)",
  fontSize: "0.95rem",
  fontWeight: 600,
  color: "var(--color-primary)",
  marginTop: "1.5rem",
  marginBottom: "0.5rem",
};

const pStyle: React.CSSProperties = {
  marginBottom: "1rem",
};

const ulStyle: React.CSSProperties = {
  paddingLeft: "1.25rem",
  marginBottom: "1rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.35rem",
};

export default function PrivacyPolicyPage() {
  return (
    <main>
      <Nav />

      <section
        style={{
          maxWidth: "760px",
          margin: "0 auto",
          padding: "8rem 2rem 6rem",
        }}
      >
        {/* Header */}
        <div style={{ marginBottom: "3rem" }}>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.65rem",
              color: "var(--color-accent)",
              letterSpacing: "0.12em",
              textTransform: "uppercase",
            }}
          >
            Legal
          </span>
          <h1
            style={{
              fontFamily: "var(--font-display)",
              fontSize: "clamp(2rem, 5vw, 3rem)",
              fontWeight: 500,
              color: "var(--color-primary)",
              letterSpacing: "-0.03em",
              lineHeight: 1.15,
              marginTop: "0.75rem",
              marginBottom: "1rem",
            }}
          >
            Privacy Policy
          </h1>
          <p
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.7rem",
              color: "var(--color-faint)",
              letterSpacing: "0.04em",
            }}
          >
            Draft / Product Manager Agent | Effective Date: March 1, 2026
          </p>
        </div>

        {/* Content */}
        <div
          style={{
            fontFamily: "var(--font-body)",
            fontSize: "0.95rem",
            color: "var(--color-muted)",
            lineHeight: 1.8,
          }}
        >
          <h2 style={h2Style}>1. Introduction</h2>
          <p style={pStyle}>
            Welcome to Product Manager Agent, operated by Idode Kerobo (sole proprietor) ("we," "us," or
            "our"). This Privacy Policy explains how we collect, use, disclose, and safeguard your
            information when you use our AI-powered product management agent and related services
            (collectively, the "Service"). By accessing or using the Service, you agree to the terms of
            this Privacy Policy.
          </p>
          <p style={pStyle}>
            If you have questions or concerns, you may contact us at{" "}
            <a
              href="https://idode.xyz/"
              style={{ color: "var(--color-accent)", textDecoration: "none" }}
            >
              idode.xyz
            </a>
            .
          </p>

          <h2 style={h2Style}>2. Information We Collect</h2>

          <h3 style={h3Style}>2.1 Information You Provide Directly</h3>
          <p style={pStyle}>When you register or use the Service, we may collect:</p>
          <ul style={ulStyle}>
            <li>Account information such as your name and email address</li>
            <li>Billing and payment information for paid subscription tiers</li>
            <li>Communications you send to us (e.g., support requests)</li>
            <li>Preferences and settings you configure within the Service</li>
          </ul>

          <h3 style={h3Style}>2.2 Information Collected Automatically</h3>
          <p style={pStyle}>When you use the Service, we automatically collect:</p>
          <ul style={ulStyle}>
            <li>Usage data such as features accessed, session duration, and interaction logs</li>
            <li>Device and browser information (type, operating system, IP address)</li>
            <li>Cookies and similar tracking technologies (see Section 7)</li>
            <li>Performance and diagnostic data to improve the Service</li>
          </ul>

          <h3 style={h3Style}>2.3 Information from Third-Party Integrations</h3>
          <p style={pStyle}>
            Product Manager Agent integrates with third-party platforms including Notion, Slack, GitHub,
            and others you choose to connect. When you authorize these integrations, we access data from
            those platforms only as necessary to provide the Service. This may include:
          </p>
          <ul style={ulStyle}>
            <li>Project and task data from connected workspaces</li>
            <li>Messages and communications you direct the agent to process</li>
            <li>Repository activity and code metadata from GitHub</li>
            <li>Other workspace content required to fulfill your requests</li>
          </ul>
          <p style={pStyle}>
            We access third-party data only with your explicit authorization and do not access it beyond
            what is needed to operate the Service.
          </p>

          <h2 style={h2Style}>3. How We Use Your Information</h2>
          <p style={pStyle}>We use the information we collect to:</p>
          <ul style={ulStyle}>
            <li>Provide, operate, and maintain the Service</li>
            <li>Process your requests and deliver AI-generated product management insights</li>
            <li>Communicate with you about your account, updates, and support</li>
            <li>Improve and develop new features and capabilities</li>
            <li>Monitor and analyze usage patterns and performance</li>
            <li>Comply with legal obligations and enforce our agreements</li>
            <li>Detect and prevent fraud, abuse, or security incidents</li>
          </ul>
          <p style={pStyle}>We do not sell your personal information to third parties.</p>

          <h2 style={h2Style}>4. AI and Large Language Model Processing</h2>
          <p style={pStyle}>
            The Service relies on artificial intelligence and large language model (LLM) providers to
            process your inputs and generate responses. When you interact with the agent, your prompts,
            workspace content, and related data may be transmitted to and processed by our LLM
            provider(s). These providers operate under their own privacy and data processing agreements.
          </p>
          <p style={pStyle}>
            We take reasonable steps to limit the data shared with LLM providers to what is strictly
            necessary, and we work only with providers who maintain industry-standard security and data
            protection practices. By using the Service, you acknowledge that your content will be
            processed by these AI systems.
          </p>

          <h2 style={h2Style}>5. How We Share Your Information</h2>
          <p style={pStyle}>We may share your information in the following circumstances:</p>
          <ul style={ulStyle}>
            <li>
              <strong style={{ color: "var(--color-primary)" }}>Service Providers:</strong> We share
              data with trusted third-party vendors who help us operate the Service, including cloud
              hosting providers, analytics platforms, payment processors, and AI/LLM providers. These
              parties are contractually obligated to protect your data.
            </li>
            <li>
              <strong style={{ color: "var(--color-primary)" }}>Third-Party Analytics:</strong> We use
              analytics tools to understand how the Service is used. These tools may collect anonymized
              or pseudonymized usage data.
            </li>
            <li>
              <strong style={{ color: "var(--color-primary)" }}>Legal Requirements:</strong> We may
              disclose your information if required by law, subpoena, court order, or government
              request, or to protect our rights and the safety of others.
            </li>
            <li>
              <strong style={{ color: "var(--color-primary)" }}>Business Transfers:</strong> In the
              event of a merger, acquisition, or sale of assets, your information may be transferred as
              part of that transaction. We will notify you of any such change.
            </li>
            <li>
              <strong style={{ color: "var(--color-primary)" }}>With Your Consent:</strong> We may
              share your information for other purposes with your explicit consent.
            </li>
          </ul>

          <h2 style={h2Style}>6. Data Retention</h2>
          <p style={pStyle}>
            We retain your personal information for as long as your account is active or as needed to
            provide the Service. If you close your account, we will delete or anonymize your data within
            a reasonable period, unless we are required to retain it for legal, regulatory, or
            legitimate business purposes.
          </p>
          <p style={pStyle}>
            Data from third-party integrations is retained only as long as needed to fulfill your
            requests and is not stored indefinitely beyond what is operationally necessary.
          </p>

          <h2 style={h2Style}>7. Cookies and Tracking Technologies</h2>
          <p style={pStyle}>
            We use cookies and similar technologies to authenticate users, remember preferences, and
            gather analytics. You may configure your browser to refuse cookies, though some features of
            the Service may not function properly without them. We do not currently respond to 'Do Not
            Track' signals, but we respect applicable privacy laws regarding user tracking.
          </p>

          <h2 style={h2Style}>8. Data Security</h2>
          <p style={pStyle}>
            We implement commercially reasonable technical and organizational security measures to
            protect your personal information from unauthorized access, disclosure, alteration, or
            destruction. However, no method of transmission over the internet or electronic storage is
            100% secure. We cannot guarantee absolute security and encourage you to use strong passwords
            and to notify us immediately of any suspected unauthorized access to your account.
          </p>

          <h2 style={h2Style}>9. Children's Privacy</h2>
          <p style={pStyle}>
            The Service is not specifically directed at children under the age of 13. We do not
            knowingly collect personal information from children under 13. If we become aware that we
            have collected personal information from a child under 13 without verified parental consent,
            we will take steps to delete that information. If you believe we have inadvertently collected
            such information, please contact us at the address below.
          </p>

          <h2 style={h2Style}>10. Your Rights and Choices</h2>
          <p style={pStyle}>
            Depending on your jurisdiction, you may have certain rights regarding your personal
            information, including:
          </p>
          <ul style={ulStyle}>
            <li>
              <strong style={{ color: "var(--color-primary)" }}>Access:</strong> Request a copy of the
              personal information we hold about you
            </li>
            <li>
              <strong style={{ color: "var(--color-primary)" }}>Correction:</strong> Request correction
              of inaccurate or incomplete information
            </li>
            <li>
              <strong style={{ color: "var(--color-primary)" }}>Deletion:</strong> Request deletion of
              your personal information, subject to certain exceptions
            </li>
            <li>
              <strong style={{ color: "var(--color-primary)" }}>Portability:</strong> Request transfer
              of your data in a machine-readable format
            </li>
            <li>
              <strong style={{ color: "var(--color-primary)" }}>Opt-out:</strong> Opt out of certain
              data processing activities, such as analytics
            </li>
          </ul>
          <p style={pStyle}>
            To exercise any of these rights, please contact us through our website at{" "}
            <a
              href="https://idode.xyz/"
              style={{ color: "var(--color-accent)", textDecoration: "none" }}
            >
              idode.xyz
            </a>
            . We will respond to requests within the timeframes required by applicable law.
          </p>

          <h2 style={h2Style}>11. Third-Party Links and Integrations</h2>
          <p style={pStyle}>
            The Service integrates with and may contain links to third-party websites and services. This
            Privacy Policy applies only to our Service. Third-party platforms such as Notion, Slack, and
            GitHub have their own privacy policies, which we encourage you to review. We are not
            responsible for the privacy practices of third-party services.
          </p>

          <h2 style={h2Style}>12. Changes to This Privacy Policy</h2>
          <p style={pStyle}>
            We may update this Privacy Policy from time to time. When we do, we will revise the
            effective date at the top of this page. We encourage you to review this policy periodically.
            Continued use of the Service after any changes constitutes your acceptance of the updated
            policy.
          </p>

          <h2 style={h2Style}>13. Contact Us</h2>
          <p style={pStyle}>
            If you have any questions, concerns, or requests regarding this Privacy Policy, please
            contact us at:
          </p>
          <p style={{ ...pStyle, color: "var(--color-primary)" }}>
            Idode Kerobo (sole proprietor)
            <br />
            Email:{" "}
            <a
              href="mailto:idode.kerobo@gmail.com"
              style={{ color: "var(--color-accent)", textDecoration: "none" }}
            >
              idode.kerobo@gmail.com
            </a>
          </p>

          {/* Divider */}
          <div
            style={{
              marginTop: "3rem",
              paddingTop: "2rem",
              borderTop: "1px solid var(--color-border)",
              fontFamily: "var(--font-mono)",
              fontSize: "0.65rem",
              color: "var(--color-faint)",
              letterSpacing: "0.04em",
            }}
          >
            Last updated: March 1, 2026
          </div>
        </div>
      </section>

      <Footer />
    </main>
  );
}
