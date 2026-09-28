import "./globals.css";
import { Fraunces, JetBrains_Mono, Plus_Jakarta_Sans } from "next/font/google";

const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-fraunces",
  axes: ["opsz"],
});
const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-jakarta",
});
const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
  weight: ["400", "500"],
});

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body
        className={`${fraunces.variable} ${jakarta.variable} ${mono.variable}`}
      >
        <div className="auth-shell">
          <a className="wordmark" href="/" aria-label="Draft home">
            Draft<span>.</span>
          </a>
          {children}
          <p className="auth-footer">
            Shared context for teams building with AI.
          </p>
        </div>
      </body>
    </html>
  );
}
