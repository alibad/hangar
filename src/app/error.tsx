"use client";

import { AlertTriangle, RotateCcw } from "lucide-react";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-950 px-6 text-gray-100">
      <section className="w-full max-w-lg rounded-2xl border border-red-500/30 bg-gray-900 p-6">
        <AlertTriangle className="h-6 w-6 text-red-400" />
        <h1 className="mt-4 text-lg font-semibold">The console could not finish rendering</h1>
        <p className="mt-2 text-sm leading-relaxed text-gray-400">Your services keep running independently. Retry the console view to reconnect.</p>
        <button onClick={reset} className="mt-5 inline-flex items-center gap-2 rounded-lg bg-indigo-500 px-3 py-2 text-sm font-medium on-accent transition hover:bg-indigo-400">
          <RotateCcw className="h-4 w-4" /> Retry console
        </button>
      </section>
    </main>
  );
}
