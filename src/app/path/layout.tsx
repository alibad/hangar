import type { Metadata } from "next";
import "@/components/hq-path/hq-path.css";
import "@/components/hq-path/console-path.css";
import { HQ_THEME_JS } from "@/components/hq-path/hq-theme";

// Local preview of the public console.humanquest.net landing in the Human Quest family look ("The Path").
// Kept out of search: the live guide stays at / until the owner approves this one.
export const metadata: Metadata = {
  title: "Hangar Console — Local AI, fitted to your machine (Path preview)",
  description: "An open-source setup skill for Codex and Claude Code. Measure your machine, choose local AI models that fit, and run a private console for services, models and requests.",
  robots: { index: false, follow: false },
};

const FONTS = "https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300..800;1,9..144,300..600&family=Instrument+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap";

export default function PathLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
      <link rel="stylesheet" href={FONTS} precedence="default" />
      {/* The accent lives on this wrapper only: data-accent="hangar" paints it in Hangar's cobalt
          (see the ACCENT block in console-path.css). Remove the attribute for the family orange. */}
      <div className="hqp-root hqp-page hqcp" data-hqp-t="pattern" data-accent="hangar" data-hqp-theme="day" suppressHydrationWarning>
        <script dangerouslySetInnerHTML={{ __html: HQ_THEME_JS }} />
        {children}
      </div>
    </>
  );
}
