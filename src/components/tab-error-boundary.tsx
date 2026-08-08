"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

export default class TabErrorBoundary extends Component<
  { children: ReactNode; label: string },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`BeTenshi ${this.props.label} tab crashed`, error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <section className="rounded-xl border border-red-500/30 bg-red-500/5 p-6" role="alert">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-red-400" />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-gray-100">{this.props.label} hit an error</h2>
            <p className="mt-1 text-xs leading-relaxed text-gray-400">
              The rest of the console is still available. Retry this tool, or use the navigation above to inspect another surface.
            </p>
            <pre className="mt-3 max-h-32 overflow-auto rounded-lg bg-gray-950 p-3 text-[11px] text-red-300">
              {this.state.error.message}
            </pre>
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              className="mt-4 inline-flex items-center gap-2 rounded-lg border border-red-500/30 px-3 py-1.5 text-xs font-medium text-red-300 transition hover:bg-red-500/10"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Retry {this.props.label}
            </button>
          </div>
        </div>
      </section>
    );
  }
}
