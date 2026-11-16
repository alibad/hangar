import { HqFamilyFooter, HqHero, HqQuestbar, HqSunset } from "@/components/hq-path/hq-path";
import { ConsoleManual, ConsolePrompt } from "@/components/hq-path/console-prompt";
import { ConsoleGallery } from "@/components/hq-path/console-gallery";

const REPO = "https://github.com/alibad/hangar";
const SKILL_CODEX = `${REPO}/blob/main/.agents/skills/hangar-setup/SKILL.md`;
const SKILL_CLAUDE = `${REPO}/blob/main/.claude/skills/hangar-setup/SKILL.md`;

/** A real capture in both looks: the light console by day, the dark console at night. */
function Shot({ name, alt, w, h, eager = false }: { name: string; alt: string; w: number; h: number; eager?: boolean }) {
  const loading = eager ? "eager" : "lazy";
  return (
    <>
      <img className="hqcp-day" src={`/hq-path/${name}-day.webp`} alt={alt} width={w} height={h} loading={loading} decoding="async" />
      <img className="hqcp-night" src={`/hq-path/${name}-night.webp`} alt={alt} width={w} height={h} loading={loading} decoding="async" />
    </>
  );
}

const Tick = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>;
const Down = () => <svg className="hqcp-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6" /></svg>;
const Out = () => <svg className="hqcp-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 16L16 8M9.5 8H16v6.5" /></svg>;

const OUTCOMES = ["Measures RAM and GPU", "Uses what is already installed", "Chooses a local model that fits", "Verifies before it finishes"];

const STEPS = [
  { title: "Measure your machine", text: "Detects macOS, Windows or Linux, memory, accelerators, Ollama and the local services it can reach.", shot: "panel-memory", alt: "Hangar measuring GPU memory and system RAM", w: 736, h: 474 },
  { title: "Choose models that fit", text: "Creates a profile for this computer and wires only the models it can prove are available.", shot: "panel-canrun", alt: "Hangar's Can it run? check: predicted VRAM and RAM for the model to load", w: 736, h: 618 },
  { title: "Run your private console", text: "Runs the tests, starts the console at localhost:8003 and checks that a local model answers.", shot: "panel-workstreams", alt: "Hangar workstreams: Chat & Code, Image Studio, Speech, Vision & 3D", w: 736, h: 584 },
];

// Workstream profiles and the GPU size, as the console showed them on the captured workstation.
const GPU_GB = 32;
const FITS = [
  { name: "Chat & Code", model: "Qwen2.5-7B", gb: 7.6 },
  { name: "Image Studio", model: "Qwen-Image", gb: 20.0 },
  { name: "Speech", model: "Whisper STT + Kokoro TTS", gb: 1.5 },
  { name: "Vision & 3D", model: "SAM 3 + SAM 3D Body", gb: 8.1 },
];

// The services list on the captured workstation (config/hosts/betenshi.json), running at capture time marked on.
const GROUPS: { name: string; items: [string, boolean?][] }[] = [
  { name: "Language models", items: [["vLLM (Qwen3-Coder 30B)"], ["vLLM (Qwen2.5-7B)"], ["PrismML Bonsai 2 27B"], ["Ollama (Gemma 4 / Qwen3-VL)", true], ["AI Router"]] },
  { name: "Voice and music", items: [["Whisper STT"], ["Kokoro TTS"], ["Chatterbox Voice"], ["ACE-Step Music"]] },
  { name: "Images, video and 3D", items: [["Qwen-Image"], ["ComfyUI"], ["SAM 3D Body"], ["SAM 3"], ["TRELLIS.2"], ["TripoSR"], ["Laya decisions"]] },
  { name: "Apps and monitoring", items: [["Hangar project engine", true], ["Open WebUI", true], ["SearXNG (web search)", true], ["Process engine (Operaton)"], ["Process lab"], ["Grafana", true], ["Prometheus", true], ["Service Manager", true]] },
];

export default function ConsolePathPage() {
  return (
    <>
      <HqQuestbar
        product={<span className="hqcp-name">Hangar<small>Console</small></span>}
        logo="/icons/icon-192.png"
        href="/path"
        territory="pattern"
        links={[
          { label: "How it works", href: "#how" },
          { label: "The console", href: "#console" },
          { label: "Install", href: "#install" },
          { label: "GitHub", href: REPO, external: true },
        ]}
        cta={{ label: "Get the prompt", href: "#start" }}
      />

      <main>
        <HqHero
          territory="pattern"
          eyebrow={<>Hangar Console · open source</>}
          title={<>Local AI, fitted to your <em>machine</em>.</>}
          lede={<>Give one setup skill to Codex or Claude Code. It measures your Mac, Windows PC or Linux box, chooses a local model that fits, and opens your private console at <code className="hqcp-host">localhost:8003</code>.</>}
          actions={<>
            <a className="hqp-btn hqp-btn-ember" href="#start">Get the setup prompt <Down /></a>
            <a className="hqp-btn hqp-btn-ghost" href={REPO} target="_blank" rel="noreferrer">View source <Out /></a>
          </>}
          art={
            <div className="hqcp-rig">
              <div className="hqp-screen hqcp-screen">
                <div className="hqp-chrome"><i /><i /><i /><span className="hqcp-url"><b />localhost:8003</span></div>
                <Shot name="console-engine" alt="The Hangar console's engine room: what is running, what fits this machine, and what to try" w={1920} h={1200} eager />
              </div>
              <div className="hqp-phone hqcp-phone"><Shot name="console-phone" alt="The same console on a phone" w={640} h={1376} eager /></div>
            </div>
          }
        >
          <p className="hqcp-fine">Open source · local by default · no account needed</p>
        </HqHero>

        <section id="start" className="hqp-section hqp-tint hqcp-start">
          <div className="hqp-inner hqcp-start-grid">
            <div className="hqcp-start-copy">
              <p className="hqp-eyebrow">Start here</p>
              <h2 className="hqp-display">One prompt. Your agent does the <em>setup</em>.</h2>
              <p className="hqp-lede">Paste it into Codex or Claude Code on the computer you want to use.</p>
              <ul className="hqcp-checks">{OUTCOMES.map((o) => <li key={o}><Tick />{o}</li>)}</ul>
            </div>
            <ConsolePrompt />
          </div>
          <p className="hqcp-start-note">This website is the launch point, not the console running on your computer.</p>
        </section>

        <section id="how" className="hqp-section hqcp-how">
          <div className="hqp-inner">
            <div className="hqp-head">
              <div><p className="hqp-eyebrow">How it works</p><h2 className="hqp-display">Measured first, <em>then</em> fitted.</h2></div>
              <p className="hqp-lede">Hangar changes with the hardware it finds, so a Mac and a GPU workstation never pretend to run the same things.</p>
            </div>
            <div className="hqp-stones hqcp-stones">
              {STEPS.map((s, n) => (
                <div className="hqp-stone hqcp-stone" key={s.title}>
                  <b>{n + 1}</b>
                  <h3>{s.title}</h3>
                  <p>{s.text}</p>
                  <figure className="hqcp-pic"><Shot name={s.shot} alt={s.alt} w={s.w} h={s.h} /></figure>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="console" className="hqp-section hqp-nightband hqcp-band">
          <div className="hqcp-sky" aria-hidden="true"><span className="hqcp-moon" /></div>
          <div className="hqp-inner">
            <div className="hqp-head">
              <div><p className="hqp-eyebrow">The local console</p><h2 className="hqp-display">Everything your machine runs, on <em>one screen</em>.</h2></div>
              <p className="hqp-lede">Real captures from a configured NVIDIA workstation. Yours shows what your machine has.</p>
            </div>
            <ConsoleGallery />

            <div className="hqcp-board">
              <div className="hqcp-board-head">
                <h3 className="hqp-display">24 services, one <em>switchboard</em>.</h3>
                <p>That workstation&apos;s list: 7 running, 17 that start on demand. Start, stop and hand each one to your coding agent from the console.</p>
              </div>
              <div className="hqcp-board-grid">
                <article className="hqcp-fit">
                  <header><b>Sized before it starts</b><span>Workstream profiles on a {GPU_GB} GB GPU</span></header>
                  <ul>
                    {FITS.map((f) => (
                      <li key={f.name} style={{ ["--fit" as string]: `${(f.gb / GPU_GB) * 100}%` }}>
                        <div><b>{f.name}</b><span>{f.model}</span><em>{f.gb.toFixed(1)} GB</em></div>
                        <i aria-hidden="true"><s /></i>
                      </li>
                    ))}
                  </ul>
                  <div className="hqcp-fit-scale" aria-hidden="true"><span>0</span><span>8</span><span>16</span><span>24</span><span>{GPU_GB} GB</span></div>
                </article>
                {GROUPS.map((g) => {
                  const on = g.items.filter(([, r]) => r).length;
                  return (
                    <article className="hqcp-group" key={g.name}>
                      <header><b>{g.name}</b><span>{on} running · {g.items.length}</span></header>
                      <ul>{g.items.map(([name, running]) => <li key={name} data-on={running ? "" : undefined}><i aria-hidden="true" />{name}{running && <span className="hqcp-sr"> (running)</span>}</li>)}</ul>
                    </article>
                  );
                })}
              </div>
            </div>
          </div>
        </section>

        <section id="install" className="hqp-section hqcp-close">
          <div className="hqp-inner hqcp-close-grid">
            <div>
              <p className="hqp-eyebrow">Private by design</p>
              <h2 className="hqp-display">Your models stay on your <em>machine</em>.</h2>
              <p className="hqp-lede">This site is only the setup guide. The console and its machine APIs run on your computer, and the public Human Quest domains cannot reach them.</p>
              <div className="hqp-ctas">
                <a className="hqp-btn hqp-btn-ember" href="#start">Get the setup prompt</a>
                <a className="hqp-btn hqp-btn-ghost" href={REPO} target="_blank" rel="noreferrer">View source <Out /></a>
              </div>
            </div>
            <div className="hqcp-close-art">
              <div className="hqcp-wall" aria-label="Where things run">
                <div className="hqcp-zone hqcp-zone-web">
                  <span className="hqcp-zone-k">console.humanquest.net</span>
                  <b>The setup guide</b>
                  <small>Machine and model APIs answer 404 here</small>
                </div>
                <div className="hqcp-cut" aria-hidden="true"><i /><span>no way in</span><i /></div>
                <div className="hqcp-zone hqcp-zone-home">
                  <span className="hqcp-zone-k">Your computer · localhost:8003</span>
                  <ul>
                    <li><img src="/icons/icon-64.png" alt="" width={22} height={22} />Hangar console</li>
                    <li><span className="hqcp-zdot" />Local models</li>
                    <li><span className="hqcp-zdot" />Machine APIs</li>
                    <li><span className="hqcp-zdot" />Your requests and usage</li>
                  </ul>
                </div>
              </div>
              <ConsoleManual />
            </div>
          </div>
        </section>
      </main>

      <HqSunset />
      <HqFamilyFooter
        current="Console"
        label="Hangar Console"
        territory="pattern"
        extra={[
          { label: "Source on GitHub", href: REPO, external: true },
          { label: "Codex setup skill", href: SKILL_CODEX, external: true },
          { label: "Claude Code setup skill", href: SKILL_CLAUDE, external: true },
        ]}
      />
    </>
  );
}
