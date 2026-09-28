import type { Metadata } from "next";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";

export const metadata: Metadata = {
  title: "Terms of Use — Draft",
  description: "The terms governing your use of Draft.",
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

const capsStyle: React.CSSProperties = {
  fontSize: "0.85rem",
  lineHeight: 1.7,
  color: "var(--color-primary)",
  marginBottom: "1rem",
};

export default function TermsPage() {
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
            Terms of Use
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
          <h2 style={h2Style}>1. Acceptance of Terms</h2>
          <p style={pStyle}>
            These Terms of Use ("Terms") govern your access to and use of Product Manager Agent and all
            related services (collectively, the "Service"), operated by Idode Kerobo (sole proprietor)
            ("we," "us," or "our"). By accessing or using the Service, you agree to be bound by these
            Terms. If you do not agree to these Terms, do not use the Service.
          </p>
          <p style={pStyle}>
            We may update these Terms from time to time. Continued use of the Service after changes are
            posted constitutes your acceptance of the revised Terms. We will update the effective date at
            the top of this page when changes are made.
          </p>

          <h2 style={h2Style}>2. Description of Service</h2>
          <p style={pStyle}>
            Product Manager Agent is an AI-powered product management agent that integrates with
            third-party productivity platforms including Notion, Slack, GitHub, and others. The Service
            uses artificial intelligence to assist users with product management tasks, including but not
            limited to summarizing activity, drafting documents, organizing tasks, and synthesizing
            information across connected workspaces.
          </p>
          <p style={pStyle}>
            The Service is offered in both free and paid subscription tiers. Features available under
            each tier are described on the Service or communicated to you at the time of sign-up. We
            reserve the right to modify, suspend, or discontinue features at any time with or without
            notice.
          </p>

          <h2 style={h2Style}>3. Eligibility</h2>
          <p style={pStyle}>
            You must be of legal age to form a binding contract in your jurisdiction to use this
            Service. By using the Service, you represent that you meet this requirement. If you are using
            the Service on behalf of a company or organization, you represent that you have the authority
            to bind that entity to these Terms.
          </p>

          <h2 style={h2Style}>4. Account Registration and Security</h2>
          <p style={pStyle}>
            To access certain features, you may be required to register for an account. You agree to:
          </p>
          <ul style={ulStyle}>
            <li>Provide accurate, current, and complete information during registration</li>
            <li>Maintain and promptly update your account information</li>
            <li>Keep your login credentials confidential and not share them with others</li>
            <li>Notify us immediately of any unauthorized access to your account</li>
          </ul>
          <p style={pStyle}>
            You are responsible for all activity that occurs under your account. We are not liable for
            any loss or damage arising from unauthorized use of your credentials.
          </p>

          <h2 style={h2Style}>5. Third-Party Integrations</h2>
          <p style={pStyle}>
            The Service allows you to connect and authorize access to third-party platforms such as
            Notion, Slack, and GitHub. By connecting these integrations, you:
          </p>
          <ul style={ulStyle}>
            <li>
              Authorize us to access, retrieve, and process data from those platforms on your behalf, as
              described in our Privacy Policy
            </li>
            <li>Represent that you have the right and authority to grant such access</li>
            <li>
              Acknowledge that your use of third-party platforms is governed by their respective terms
              of service and privacy policies, not these Terms
            </li>
          </ul>
          <p style={pStyle}>
            We are not responsible for the availability, functionality, or content of third-party
            platforms, and we make no warranties regarding them. You should review the terms and privacy
            policies of any third-party service you connect to the Service.
          </p>

          <h2 style={h2Style}>6. AI-Generated Content and Limitations</h2>
          <p style={pStyle}>
            The Service uses AI and large language models to generate responses, summaries, suggestions,
            and other content. You acknowledge and agree that:
          </p>
          <ul style={ulStyle}>
            <li>
              AI-generated content may be inaccurate, incomplete, or inappropriate for your specific
              situation
            </li>
            <li>
              You are solely responsible for reviewing and validating any AI-generated output before
              acting on it
            </li>
            <li>
              We do not guarantee the accuracy, reliability, completeness, or suitability of
              AI-generated content
            </li>
            <li>
              The Service is not a substitute for professional advice (legal, financial, technical, or
              otherwise)
            </li>
          </ul>
          <p style={pStyle}>
            We expressly disclaim any liability for decisions made based on AI-generated content
            produced by the Service.
          </p>

          <h2 style={h2Style}>7. Acceptable Use</h2>
          <p style={pStyle}>
            You agree to use the Service only for lawful purposes and in compliance with these Terms.
            You agree not to:
          </p>
          <ul style={ulStyle}>
            <li>Use the Service to violate any applicable law, regulation, or third-party rights</li>
            <li>
              Input or transmit content that is unlawful, harmful, defamatory, obscene, or otherwise
              objectionable
            </li>
            <li>
              Attempt to reverse engineer, decompile, or extract source code from the Service
            </li>
            <li>Use the Service to generate spam, phishing content, or malware</li>
            <li>
              Interfere with or disrupt the integrity or performance of the Service or its
              infrastructure
            </li>
            <li>Use automated means to access the Service beyond authorized API usage</li>
            <li>
              Resell, sublicense, or commercially exploit the Service without our written consent
            </li>
            <li>
              Attempt to bypass any security measures or access portions of the Service you are not
              authorized to use
            </li>
          </ul>
          <p style={pStyle}>
            We reserve the right to suspend or terminate your account for any violation of this section.
          </p>

          <h2 style={h2Style}>8. Intellectual Property</h2>

          <h3 style={h3Style}>8.1 Our IP</h3>
          <p style={pStyle}>
            The Service, including its software, design, features, and documentation, is owned by Idode
            Kerobo (sole proprietor) and protected by applicable intellectual property laws. You are
            granted a limited, non-exclusive, non-transferable, revocable license to use the Service for
            its intended purposes. Nothing in these Terms transfers any ownership rights to you.
          </p>

          <h3 style={h3Style}>8.2 Your Content</h3>
          <p style={pStyle}>
            You retain ownership of any content, data, or materials you input into the Service or that
            are accessed from your connected integrations. By using the Service, you grant us a limited
            license to process your content solely for the purpose of providing and improving the
            Service. We will not use your content to train AI models without your explicit consent.
          </p>

          <h2 style={h2Style}>9. Subscription and Payment</h2>
          <p style={pStyle}>
            The Service is offered on a freemium basis. Paid subscription tiers provide access to
            additional features. By subscribing to a paid tier, you agree to:
          </p>
          <ul style={ulStyle}>
            <li>Pay all applicable fees as described at the time of purchase</li>
            <li>
              Authorize us or our payment processor to charge your payment method on the billing cycle
              selected
            </li>
            <li>Notify us of any changes to your payment information</li>
          </ul>
          <p style={pStyle}>
            Fees are non-refundable except as required by applicable law or as otherwise stated at the
            time of purchase. We reserve the right to change pricing with reasonable advance notice.
            Continued use of the paid tier after a price change constitutes acceptance of the new
            pricing.
          </p>

          <h2 style={h2Style}>10. Termination</h2>
          <p style={pStyle}>
            You may terminate your account at any time by contacting us or using the account deletion
            feature within the Service. We may suspend or terminate your access immediately and without
            prior notice if we determine you have violated these Terms, applicable law, or the rights of
            any third party.
          </p>
          <p style={pStyle}>
            Upon termination, your right to use the Service ceases immediately. Sections that by their
            nature should survive termination (including intellectual property, disclaimer of warranties,
            limitation of liability, and dispute resolution) shall remain in effect.
          </p>

          <h2 style={h2Style}>11. Disclaimer of Warranties</h2>
          <p style={capsStyle}>
            THE SERVICE IS PROVIDED ON AN "AS IS" AND "AS AVAILABLE" BASIS WITHOUT WARRANTIES OF ANY
            KIND, EITHER EXPRESS OR IMPLIED. TO THE FULLEST EXTENT PERMITTED BY LAW, WE DISCLAIM ALL
            WARRANTIES, INCLUDING IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
            PURPOSE, ACCURACY, AND NON-INFRINGEMENT. WE DO NOT WARRANT THAT THE SERVICE WILL BE
            UNINTERRUPTED, ERROR-FREE, OR SECURE, OR THAT AI-GENERATED CONTENT WILL BE ACCURATE OR
            SUITABLE FOR YOUR PURPOSES.
          </p>

          <h2 style={h2Style}>12. Limitation of Liability</h2>
          <p style={capsStyle}>
            TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IDODE KEROBO (SOLE PROPRIETOR) SHALL NOT
            BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR ANY
            LOSS OF PROFITS, DATA, GOODWILL, OR BUSINESS OPPORTUNITIES, ARISING OUT OF OR RELATED TO
            YOUR USE OF OR INABILITY TO USE THE SERVICE, EVEN IF WE HAVE BEEN ADVISED OF THE
            POSSIBILITY OF SUCH DAMAGES.
          </p>
          <p style={capsStyle}>
            OUR TOTAL CUMULATIVE LIABILITY TO YOU FOR ANY CLAIMS ARISING OUT OF OR RELATED TO THESE
            TERMS OR THE SERVICE SHALL NOT EXCEED THE GREATER OF (A) THE AMOUNT YOU PAID TO US IN THE
            THREE (3) MONTHS PRECEDING THE CLAIM, OR (B) FIFTY US DOLLARS ($50).
          </p>

          <h2 style={h2Style}>13. Indemnification</h2>
          <p style={pStyle}>
            You agree to indemnify, defend, and hold harmless Idode Kerobo from and against any claims,
            damages, losses, liabilities, costs, and expenses (including reasonable attorneys' fees)
            arising from: (a) your use of the Service; (b) your breach of these Terms; (c) your
            violation of any applicable law or third-party rights; or (d) any content you input into or
            transmit through the Service.
          </p>

          <h2 style={h2Style}>14. Governing Law and Dispute Resolution</h2>
          <p style={pStyle}>
            These Terms shall be governed by and construed in accordance with the laws of the United
            States, without regard to conflict of law principles. Any disputes arising out of or related
            to these Terms or the Service shall be resolved through binding arbitration in accordance
            with the rules of a recognized arbitration body, except that either party may seek
            injunctive or equitable relief in a court of competent jurisdiction for matters involving
            intellectual property or unauthorized access to the Service.
          </p>
          <p style={pStyle}>
            You and we each waive any right to a jury trial or to participate in a class action lawsuit
            or class-wide arbitration.
          </p>

          <h2 style={h2Style}>15. Miscellaneous</h2>
          <ul style={{ ...ulStyle, listStyle: "none", paddingLeft: 0 }}>
            <li style={{ marginBottom: "0.75rem" }}>
              <strong style={{ color: "var(--color-primary)" }}>Entire Agreement:</strong> These Terms,
              together with our Privacy Policy, constitute the entire agreement between you and us
              regarding the Service and supersede all prior agreements.
            </li>
            <li style={{ marginBottom: "0.75rem" }}>
              <strong style={{ color: "var(--color-primary)" }}>Severability:</strong> If any provision
              of these Terms is found to be unenforceable, the remaining provisions will remain in full
              force and effect.
            </li>
            <li style={{ marginBottom: "0.75rem" }}>
              <strong style={{ color: "var(--color-primary)" }}>Waiver:</strong> Our failure to enforce
              any right or provision of these Terms will not constitute a waiver of that right or
              provision.
            </li>
            <li style={{ marginBottom: "0.75rem" }}>
              <strong style={{ color: "var(--color-primary)" }}>Assignment:</strong> You may not assign
              your rights or obligations under these Terms without our prior written consent. We may
              assign our rights and obligations without restriction.
            </li>
            <li style={{ marginBottom: "0.75rem" }}>
              <strong style={{ color: "var(--color-primary)" }}>Force Majeure:</strong> We shall not be
              liable for delays or failures in performance resulting from causes beyond our reasonable
              control.
            </li>
          </ul>

          <h2 style={h2Style}>16. Contact Us</h2>
          <p style={pStyle}>
            If you have questions about these Terms, please contact us at:
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
