import Image from "next/image";
import type { Metadata } from "next";
import HostedOnboarding from "@/components/hosted-onboarding";

export const metadata: Metadata = {
  title: "Run Hangar locally",
  description: "Install Hangar beside Ollama and a local LLM, configure your machine, and verify the private local console.",
};

export default function GuidePage() {
  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="sticky top-0 z-30 border-b border-gray-800 bg-gray-950/90 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[1500px] items-center gap-3 px-4 sm:px-6">
          <Image src="/icons/icon.svg" alt="" width={24} height={24} priority className="h-6 w-6" />
          <span className="text-lg font-semibold tracking-[-0.02em] text-gray-100">Hangar</span>
          <span className="rounded-full border border-gray-800 bg-gray-900 px-2 py-0.5 text-[10px] font-medium text-gray-500">Local setup</span>
          <a href="https://github.com/alibad/hangar" target="_blank" rel="noreferrer" className="ml-auto rounded-lg border border-gray-800 px-3 py-2 text-xs font-medium text-gray-400 transition hover:border-gray-600 hover:text-gray-100">
            Repository
          </a>
        </div>
      </header>
      <main className="mx-auto max-w-[1500px] px-4 pb-16 pt-5 sm:px-6">
        <HostedOnboarding />
      </main>
    </div>
  );
}
