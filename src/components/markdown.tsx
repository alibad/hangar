"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Model replies, rendered as the markdown they actually are.
 *
 * The playground printed them into a <pre>, so every reply arrived as literal
 * `**bold**`, `###` and unrendered tables — the models were formatting carefully
 * and none of it survived. GFM is on because they reach for tables, strikethrough
 * and task lists constantly.
 *
 * Raw HTML is deliberately NOT enabled. react-markdown escapes it by default,
 * and this text comes straight from a model, so leaving that default alone is
 * what keeps a reply from injecting markup into the console.
 *
 * Styling is explicit per element rather than a prose plugin: the console has no
 * typography plugin, and unstyled markdown in a chat bubble collapses into an
 * unreadable wall.
 */
export default function Markdown({ children, className = "" }: { children: string; className?: string }) {
  return (
    <div className={`text-sm leading-relaxed space-y-2 ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="whitespace-pre-wrap">{children}</p>,
          strong: ({ children }) => <strong className="font-semibold text-gray-100">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          h1: ({ children }) => <h1 className="text-base font-semibold text-gray-100 mt-3 first:mt-0">{children}</h1>,
          h2: ({ children }) => <h2 className="text-sm font-semibold text-gray-100 mt-3 first:mt-0">{children}</h2>,
          h3: ({ children }) => <h3 className="text-sm font-semibold text-gray-200 mt-2 first:mt-0">{children}</h3>,
          ul: ({ children }) => <ul className="list-disc pl-5 space-y-1">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5 space-y-1">{children}</ol>,
          li: ({ children }) => <li className="pl-0.5">{children}</li>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer"
               className="text-indigo-400 hover:text-indigo-300 underline underline-offset-2">
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-gray-700 pl-3 text-gray-400">{children}</blockquote>
          ),
          hr: () => <hr className="border-gray-800" />,
          code: ({ className: cls, children }) => {
            // A fenced block gets a language class; an inline span doesn't. Same
            // component handles both, so the distinction has to be made here.
            const fenced = /language-/.test(cls ?? "");
            if (!fenced) {
              return (
                <code className="rounded bg-gray-800 px-1 py-0.5 font-mono text-[12px] text-gray-200">
                  {children}
                </code>
              );
            }
            return (
              <code className="block overflow-x-auto rounded-lg bg-gray-950 border border-gray-800 p-3 font-mono text-[12px] text-gray-200">
                {children}
              </code>
            );
          },
          pre: ({ children }) => <pre className="not-prose">{children}</pre>,
          // Wide tables scroll inside their own box rather than stretching the
          // chat column past the panel.
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="w-full text-xs border-collapse">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-gray-800 bg-gray-900 px-2 py-1 text-left font-medium text-gray-300">{children}</th>
          ),
          td: ({ children }) => <td className="border border-gray-800 px-2 py-1 align-top">{children}</td>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
