"use client";

import { useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import RouterUsageView from "@/components/router-usage-view";
import { useUsageSnapshot } from "@/components/use-usage-snapshot";
import {
  filterUsage,
  groupUsage,
  projectLabels,
  sourceLabel,
  sumUsage,
  type AssistantSnapshot,
} from "@/lib/assistant-usage-data";

type Source = "router" | "all" | "codex" | "claude";
const SOURCES = [
  { id: "router", label: "AI Router" },
  { id: "all", label: "All assistants" },
  { id: "codex", label: "Codex · GPT" },
  { id: "claude", label: "Claude Code" },
] as const;
const compact = (n: number) =>
  Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(n);
const number = (n: number) => n.toLocaleString("en-US");
const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const projectName = (p: string) =>
  p
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() || p;
const dayLabel = (day: string) =>
  new Date(day + "T12:00:00Z").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
const dayAt = (ago: number) =>
  new Date(Date.now() - ago * 86400000).toISOString().slice(0, 10);
const control =
  "rounded-lg border border-gray-800 bg-gray-950 px-3 py-2 text-xs text-gray-300";
const estimate = (g: {
  totalTokens: number;
  unpricedTokens: number;
  estimatedCost: number;
}) =>
  g.totalTokens && g.unpricedTokens === g.totalTokens
    ? "Unpriced"
    : money(g.estimatedCost) + (g.unpricedTokens ? " + unpriced" : "");

export default function UsageView() {
  const [source, setSource] = useState<Source>("router");
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-gray-100">AI usage</h1>
          <p className="mt-1 text-xs text-gray-500">
            Follow your token usage, explore models, and compare your coding
            assistants.
          </p>
        </div>
        <div
          className="flex flex-wrap gap-1 rounded-xl border border-gray-800 p-1"
          aria-label="Usage source"
        >
          {SOURCES.map((s) => (
            <button
              type="button"
              key={s.id}
              aria-pressed={s.id === source}
              onClick={() => setSource(s.id)}
              className={`rounded-lg px-3 py-2 text-xs transition ${source === s.id ? "bg-orange-500/15 font-medium text-orange-200" : "text-gray-500 hover:text-gray-200"}`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
      {source === "router" ? (
        <RouterUsageView />
      ) : (
        <AssistantUsage source={source} onSource={setSource} />
      )}
    </div>
  );
}

function AssistantUsage({
  source,
  onSource,
}: {
  source: Exclude<Source, "router">;
  onSource: (s: Source) => void;
}) {
  const { data, error, loading, refresh } = useUsageSnapshot<AssistantSnapshot>(
    "/api/assistant-usage",
  );
  const [range, setRange] = useState("30");
  const [from, setFrom] = useState(dayAt(29));
  const [to, setTo] = useState(dayAt(0));
  const [model, setModel] = useState("");
  const [project, setProject] = useState("");
  const [breakdown, setBreakdown] = useState<
    "model" | "project" | "day" | "session"
  >("model");
  const [metric, setMetric] = useState<"tokens" | "cost">("tokens");
  const [showAll, setShowAll] = useState(false);
  const dates = useMemo(
    () => ({ from: range === "all" ? "" : from, to }),
    [range, from, to],
  );
  const sourceRows = useMemo(
    () =>
      filterUsage(data?.rows || [], {
        ...dates,
        source: source === "all" ? "" : source,
      }),
    [data, dates, source],
  );
  const models = useMemo(
    () => [...new Set(sourceRows.map((r) => r.model))].sort(),
    [sourceRows],
  );
  const projects = useMemo(
    () => [...new Set(sourceRows.map((r) => r.project))].sort(),
    [sourceRows],
  );
  const labels = useMemo(() => projectLabels(projects), [projects]);
  const label = (p: string) => labels.get(p) || projectName(p);
  const byLabel = useMemo(
    () => [...projects].sort((a, b) => label(a).localeCompare(label(b))),
    [projects, labels],
  );
  const activeModel = models.includes(model) ? model : "";
  const activeProject = projects.includes(project) ? project : "";
  const rows = useMemo(
    () =>
      filterUsage(sourceRows, { model: activeModel, project: activeProject }),
    [sourceRows, activeModel, activeProject],
  );
  const totals = useMemo(() => sumUsage(rows), [rows]);
  const groups = useMemo(() => {
    const values = groupUsage(rows, breakdown);
    return breakdown === "day"
      ? values.sort((a, b) => b.key.localeCompare(a.key))
      : values;
  }, [rows, breakdown]);
  const days = useMemo(() => {
    const grouped = new Map(groupUsage(rows, "day").map((g) => [g.key, g]));
    const first = dates.from || [...grouped.keys()].sort()[0];
    if (!first || first > to) return [];
    const result: Array<{
      day: string;
      tokens: number;
      cost: number;
      cached: number;
      output: number;
    }> = [];
    for (
      let t = Date.parse(first + "T00:00:00Z");
      t <= Date.parse(to + "T00:00:00Z");
      t += 86400000
    ) {
      const day = new Date(t).toISOString().slice(0, 10);
      const value = grouped.get(day);
      result.push({
        day,
        tokens: value?.totalTokens || 0,
        cost: value?.estimatedCost || 0,
        cached: value?.cached || 0,
        output: value?.output || 0,
      });
    }
    return result;
  }, [rows, dates, to]);
  const peak = Math.max(
    1,
    ...days.map((d) => (metric === "tokens" ? d.tokens : d.cost)),
  );
  const sessions = new Set(rows.map((r) => `${r.source}:${r.session}`)).size;
  const selectRange = (value: string) => {
    setRange(value);
    if (value === "custom") return;
    setTo(dayAt(0));
    if (value !== "all") setFrom(dayAt(Number(value) - 1));
  };
  const selectSource = (value: Source) => {
    setModel("");
    setProject("");
    onSource(value);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-gray-100">
            {source === "all" ? "Coding assistants" : sourceLabel(source)}
          </h2>
          <p className="mt-1 text-xs text-gray-500">
            Actual tokens recorded on this machine · active and archived tasks
          </p>
        </div>
        <button
          type="button"
          disabled={loading}
          onClick={refresh}
          className={`flex items-center gap-2 ${control}`}
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
          />
          {loading ? "Updating…" : "Refresh"}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-gray-800 bg-gray-950 p-3">
        <select
          aria-label="Date range"
          value={range}
          onChange={(e) => selectRange(e.target.value)}
          className={control}
        >
          <option value="1">Today</option>
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="all">All time</option>
          <option value="custom">Custom dates</option>
        </select>
        <input
          aria-label="From date"
          type="date"
          max={to}
          value={range === "all" ? "" : from}
          onChange={(e) => {
            setRange("custom");
            setFrom(e.target.value);
          }}
          className={control}
        />
        <span className="text-xs text-gray-500">to</span>
        <input
          aria-label="To date"
          type="date"
          min={dates.from}
          value={to}
          onChange={(e) => {
            setRange("custom");
            setTo(e.target.value);
          }}
          className={control}
        />
        <select
          aria-label="Model filter"
          value={activeModel}
          onChange={(e) => setModel(e.target.value)}
          className={`${control} max-w-64`}
        >
          <option value="">All models</option>
          {models.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <select
          aria-label="Project filter"
          value={activeProject}
          onChange={(e) => setProject(e.target.value)}
          className={`${control} max-w-56`}
        >
          <option value="">All projects</option>
          {byLabel.map((p) => (
            <option key={p} value={p} title={p}>
              {label(p)}
            </option>
          ))}
        </select>
        {(activeModel || activeProject) && (
          <button
            type="button"
            className="px-2 text-xs text-orange-300"
            onClick={() => {
              setModel("");
              setProject("");
            }}
          >
            Clear filters
          </button>
        )}
        <span className="text-[11px] text-gray-500">UTC</span>
      </div>
      {error && (
        <div
          role="alert"
          className="rounded-xl border border-red-900/50 p-4 text-sm text-red-300"
        >
          {data
            ? "Showing the last successful update. "
            : "Could not load usage. "}
          {error}
        </div>
      )}
      {!data && !error && (
        <div
          role="status"
          className="rounded-xl border border-gray-800 p-8 text-sm text-gray-500"
        >
          Reading recorded usage… The first scan indexes your local history.
        </div>
      )}
      {data && (
        <>
          {Object.entries(data.sources)
            .filter(
              ([id, s]) => !s.available && (source === "all" || source === id),
            )
            .map(([id, s]) => (
              <p role="alert" key={id} className="text-sm text-red-300">
                {id} could not be read: {s.error}. Its usage is excluded from
                these results.
              </p>
            ))}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi
              label="Total tokens"
              value={compact(totals.totalTokens)}
              exact={number(totals.totalTokens)}
              note={`${number(totals.calls)} usage updates · ${number(sessions)} tasks`}
            />
            <Kpi
              label="Input / output"
              value={`${compact(totals.input)} / ${compact(totals.output)}`}
              note="Cached tokens included in input"
            />
            <Kpi
              label="Input from cache"
              value={
                totals.input
                  ? `${((100 * totals.cached) / totals.input).toFixed(1)}%`
                  : "—"
              }
              note={`${compact(totals.cached)} cached input tokens`}
            />
            <Kpi
              label="API-rate estimate"
              value={estimate(totals)}
              note={
                totals.unpricedTokens
                  ? `${compact(totals.unpricedTokens)} tokens have no published rate`
                  : "Reference value · not your subscription bill"
              }
            />
          </div>
          {source === "all" && (
            <div className="grid gap-3 md:grid-cols-2">
              {(["codex", "claude"] as const).map((id) => {
                const total = sumUsage(rows.filter((r) => r.source === id));
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => selectSource(id)}
                    className="flex items-center justify-between gap-4 rounded-xl border border-gray-800 p-4 text-left hover:border-orange-500/50"
                  >
                    <div>
                      <div className="text-sm font-medium text-gray-100">
                        {sourceLabel(id)}
                      </div>
                      <div className="mt-1 text-xs text-gray-500">
                        {data.sources[id].available
                          ? `${number(total.calls)} usage updates`
                          : "Source could not be read"}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-lg font-semibold text-gray-100">
                        {data.sources[id].available
                          ? compact(total.totalTokens)
                          : "—"}
                      </div>
                      <div className="text-xs text-orange-300">
                        View usage →
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
          {!rows.length ? (
            <div className="rounded-xl border border-gray-800 p-8 text-center">
              <h3 className="text-sm font-medium text-gray-100">
                No usage in this selection
              </h3>
              <p className="mt-2 text-xs text-gray-500">
                Choose another date range or clear the model and project
                filters.
              </p>
            </div>
          ) : (
            <>
              <div className="rounded-xl border border-gray-800 bg-gray-950 p-4">
                <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-medium text-gray-100">
                    Daily usage
                  </h3>
                  <div className="flex gap-1">
                    {(["tokens", "cost"] as const).map((m) => (
                      <button
                        type="button"
                        key={m}
                        aria-pressed={metric === m}
                        onClick={() => setMetric(m)}
                        className={`rounded-lg px-3 py-1.5 text-xs ${metric === m ? "bg-orange-500/15 text-orange-200" : "text-gray-500"}`}
                      >
                        {m === "cost" ? "API-rate estimate" : "Tokens"}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="mb-2 flex justify-between text-[11px] text-gray-500">
                  <span>
                    {metric === "tokens"
                      ? compact(peak) + " tokens"
                      : money(peak)}
                  </span>
                  <span>Choose a day to focus</span>
                </div>
                <div
                  className="flex h-40 items-stretch gap-1 overflow-x-auto border-b border-gray-800"
                  aria-label="Daily usage chart"
                >
                  {days.map((d) => {
                    const value = metric === "tokens" ? d.tokens : d.cost;
                    return (
                      <button
                        key={d.day}
                        type="button"
                        title={`${d.day}: ${number(d.tokens)} tokens · ${money(d.cost)} estimated`}
                        aria-label={`${d.day}, ${number(d.tokens)} tokens, focus day`}
                        onClick={() => {
                          setFrom(d.day);
                          setTo(d.day);
                          setRange("custom");
                        }}
                        className="flex h-full min-w-[5px] flex-1 flex-col justify-end rounded-t-sm hover:opacity-70 focus-visible:outline-2 focus-visible:outline-orange-500"
                      >
                        <div
                          className="flex w-full flex-col justify-end overflow-hidden rounded-t-sm bg-orange-500/70"
                          style={{
                            height: `${value ? Math.max(1, (value / peak) * 100) : 0}%`,
                          }}
                        >
                          {metric === "tokens" && d.tokens > 0 && (
                            <>
                              <div
                                className="bg-violet-400/80"
                                style={{
                                  height: `${(d.output / d.tokens) * 100}%`,
                                }}
                              />
                              <div
                                className="bg-teal-500/80"
                                style={{
                                  height: `${((d.tokens - d.cached - d.output) / d.tokens) * 100}%`,
                                }}
                              />
                              <div
                                className="bg-orange-400/80"
                                style={{
                                  height: `${(d.cached / d.tokens) * 100}%`,
                                }}
                              />
                            </>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
                <div className="mt-2 flex justify-between text-[11px] text-gray-500">
                  <span>{days[0] && dayLabel(days[0].day)}</span>
                  <span>
                    {days.length > 2 &&
                      dayLabel(days[Math.floor(days.length / 2)].day)}
                  </span>
                  <span>{days.at(-1) && dayLabel(days.at(-1)!.day)}</span>
                </div>
                {metric === "tokens" && (
                  <div className="mt-4 flex flex-wrap gap-4 text-[11px] text-gray-500">
                    <Legend color="bg-orange-400" text="Cached input" />
                    <Legend color="bg-teal-500" text="Other input" />
                    <Legend
                      color="bg-violet-400"
                      text="Output (includes reasoning)"
                    />
                  </div>
                )}
              </div>
              <div className="overflow-hidden rounded-xl border border-gray-800 bg-gray-950">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-800 p-3">
                  <div className="flex gap-1">
                    {(["model", "project", "day", "session"] as const).map(
                      (key) => (
                        <button
                          type="button"
                          key={key}
                          aria-pressed={breakdown === key}
                          onClick={() => {
                            setBreakdown(key);
                            setShowAll(false);
                          }}
                          className={`rounded-lg px-3 py-1.5 text-xs capitalize ${breakdown === key ? "bg-orange-500/15 text-orange-200" : "text-gray-500"}`}
                        >
                          {key === "session" ? "Tasks" : key + "s"}
                        </button>
                      ),
                    )}
                  </div>
                  <span className="text-[11px] text-gray-500">
                    {number(groups.length)}{" "}
                    {breakdown === "session" ? "tasks" : breakdown + "s"} · same
                    filters as chart
                  </span>
                </div>
                <div className="max-h-[480px] overflow-auto">
                  <table className="w-full text-right text-xs">
                    <thead className="sticky top-0 bg-gray-950 text-[10px] uppercase text-gray-500">
                      <tr>
                        <th className="p-3 text-left">
                          {breakdown === "session" ? "Task" : breakdown}
                        </th>
                        <th className="p-3">Input</th>
                        <th className="p-3">Cached¹</th>
                        <th className="p-3">Output</th>
                        <th className="p-3">Total tokens</th>
                        <th className="p-3">API estimate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(showAll ? groups : groups.slice(0, 20)).map((g) => (
                        <tr
                          key={g.key}
                          className="border-t border-gray-800/60 text-gray-300"
                        >
                          <td
                            className="max-w-64 truncate p-3 text-left"
                            title={g.key}
                          >
                            {breakdown === "model" ||
                            breakdown === "project" ? (
                              <button
                                type="button"
                                className="text-orange-300 hover:underline"
                                onClick={() =>
                                  breakdown === "model"
                                    ? setModel(g.key)
                                    : setProject(g.key)
                                }
                              >
                                {breakdown === "project"
                                  ? label(g.key)
                                  : g.key}
                              </button>
                            ) : breakdown === "session" ? (
                              g.key.slice(0, 8) + "…"
                            ) : (
                              dayLabel(g.key)
                            )}
                          </td>
                          <td className="p-3" title={number(g.input)}>
                            {compact(g.input)}
                          </td>
                          <td className="p-3" title={number(g.cached)}>
                            {compact(g.cached)}
                          </td>
                          <td className="p-3" title={number(g.output)}>
                            {compact(g.output)}
                          </td>
                          <td
                            className="p-3 font-medium"
                            title={number(g.totalTokens)}
                          >
                            {compact(g.totalTokens)}
                          </td>
                          <td className="p-3">{estimate(g)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-gray-800 font-medium text-gray-100">
                        <td className="p-3 text-left">Selection total</td>
                        <td className="p-3">{compact(totals.input)}</td>
                        <td className="p-3">{compact(totals.cached)}</td>
                        <td className="p-3">{compact(totals.output)}</td>
                        <td className="p-3">{compact(totals.totalTokens)}</td>
                        <td className="p-3">{estimate(totals)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
                {groups.length > 20 && (
                  <button
                    type="button"
                    onClick={() => setShowAll(!showAll)}
                    className="w-full border-t border-gray-800 py-3 text-xs text-orange-300"
                  >
                    {showAll
                      ? "Show top 20"
                      : `Show all ${number(groups.length)}`}
                  </button>
                )}
              </div>
            </>
          )}
          <details className="rounded-xl border border-gray-800 p-4 text-xs text-gray-500">
            <summary className="cursor-pointer text-gray-300">
              Coverage & how this is counted
            </summary>
            <div className="mt-3 space-y-2 leading-relaxed">
              <p>
                Codex reads token counts reported in local task history,
                including archived tasks. Claude reads local Claude Code
                transcripts. Regular ChatGPT web chats and cloud-only tasks are
                outside this local history.
              </p>
              <p>
                ¹ Cached input is part of input. Reasoning is part of output.
                Total tokens = input + output; neither subset is added twice.{" "}
                {source !== "claude" &&
                  `Codex reports ${number(rows.filter((r) => r.source === "codex").reduce((n, r) => n + r.reasoning, 0))} reasoning tokens in this selection.`}
              </p>
              <p>
                API estimates value usage at reference token rates; they are not
                subscription charges. GPT estimates use standard short-context
                rates checked {data.pricingDate}, applied to historical usage as
                well. Long-context premiums, Fast mode, tool charges, and
                historical discounts are excluded. Models without a verified
                rate keep their tokens and show as unpriced.{" "}
                <a
                  className="text-orange-300 underline"
                  href="https://developers.openai.com/api/docs/pricing"
                  target="_blank"
                  rel="noreferrer"
                >
                  OpenAI pricing
                </a>
                .
              </p>
              <p>
                All assistants combines Codex and Claude. AI Router has its own
                call accounting; it is kept separate because an assistant can
                itself call the router.
              </p>
              <p>
                Last updated {new Date(data.generatedAt).toLocaleString()}.
                Refreshes every 30 seconds while this page is visible.{" "}
                {data.sources.codex.files ?? 0} Codex transcript files indexed.
              </p>
              {data.warnings.map((w) => (
                <p key={w} className="text-amber-400">
                  {w}
                </p>
              ))}
            </div>
          </details>
        </>
      )}
    </div>
  );
}

function Kpi({
  label,
  value,
  note,
  exact,
}: {
  label: string;
  value: string;
  note: string;
  exact?: string;
}) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-950 p-4">
      <div className="text-[10px] uppercase tracking-wide text-gray-500">
        {label}
      </div>
      <div title={exact} className="mt-2 text-xl font-semibold text-gray-100">
        {value}
      </div>
      <div className="mt-1 text-[11px] text-gray-500">{note}</div>
    </div>
  );
}
function Legend({ color, text }: { color: string; text: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-sm ${color}`} />
      {text}
    </span>
  );
}
