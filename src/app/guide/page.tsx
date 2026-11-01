import Image from "next/image";
import Script from "next/script";
import type { Metadata } from "next";
import { PUBLIC_SITE_URL, PUBLIC_SITE_TITLE, PUBLIC_SITE_DESCRIPTION } from "@/lib/public-site";
import HostedOnboarding from "@/components/hosted-onboarding";

export const metadata: Metadata = {
  title: PUBLIC_SITE_TITLE, description: PUBLIC_SITE_DESCRIPTION,
  alternates: { canonical: PUBLIC_SITE_URL },
  openGraph: { type: "website", siteName: "Hangar Console", url: PUBLIC_SITE_URL, title: PUBLIC_SITE_TITLE, description: PUBLIC_SITE_DESCRIPTION, images: [{url: `${PUBLIC_SITE_URL}/social/console.png`,width:1200,height:630,alt:"Hangar — local AI, fitted to your machine"}] },
  twitter: {card:"summary_large_image",title:PUBLIC_SITE_TITLE,description:PUBLIC_SITE_DESCRIPTION,images:[`${PUBLIC_SITE_URL}/social/console.png`]},
};

export default function GuidePage() {
  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="sticky top-0 z-30 border-b border-gray-800 bg-gray-950/90 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[1500px] items-center gap-3 px-4 sm:px-6">
          <Image src="/icons/icon-192.png" alt="" width={32} height={32} priority className="h-8 w-8" />
          <span className="text-lg font-semibold tracking-[-0.02em] text-gray-100">Hangar</span>
          <span className="rounded-full border border-gray-800 bg-gray-900 px-2 py-0.5 text-[10px] font-medium text-gray-500">Machine-aware local AI</span>
          <a href="https://github.com/alibad/hangar" target="_blank" rel="noreferrer" className="ml-auto rounded-lg border border-gray-800 px-3 py-2 text-xs font-medium text-gray-400 transition hover:border-gray-600 hover:text-gray-100">
            Repository
          </a>
        </div>
      </header>
      <main className="mx-auto max-w-[1500px] px-4 pb-16 pt-5 sm:px-6">
        <script type="application/ld+json" dangerouslySetInnerHTML={{__html:JSON.stringify({"@context":"https://schema.org","@type":"SoftwareApplication",name:"Hangar Console",url:PUBLIC_SITE_URL,description:PUBLIC_SITE_DESCRIPTION,applicationCategory:"DeveloperApplication",operatingSystem:"macOS, Windows, Linux",codeRepository:"https://github.com/alibad/hangar",publisher:{"@type":"Organization",name:"Human Quest",url:"https://www.humanquest.net/"}}).replace(/</g,"\\u003c")}}/>
        <HostedOnboarding />
      </main>
      {/* The shared Human Quest band: back to humanquest.net and on to the other quests. */}
      <div className="mx-auto max-w-[1500px] px-4 pb-8 sm:px-6">
        <hq-footer current="hangar" theme="dark">
          <a href="https://www.humanquest.net/?ref=hangar">A Human Quest AI pattern · humanquest.net</a>
        </hq-footer>
        <Script src="https://www.humanquest.net/embed/hq-footer.js" strategy="afterInteractive" />
      </div>
      <footer className="mx-auto flex max-w-[1500px] flex-wrap items-center justify-between gap-4 border-t border-gray-800 px-4 py-8 text-xs text-gray-400 sm:px-6">
        <p>A <a href="https://www.humanquest.net/" className="text-gray-200 underline underline-offset-4">Human Quest</a> project.</p>
        <a href="https://www.humanquest.net/ai-patterns" className="underline underline-offset-4">Explore AI Patterns ↗</a>
      </footer>
    </div>
  );
}
