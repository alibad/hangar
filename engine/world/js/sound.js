// Soft interface sounds, synthesised (no files): a pluck when you pick something, a click for lenses, a whoosh for
// flights, a chime for night. Off until the person turns them on; the choice is remembered in this browser.

let ctx = null, master = null;
let on = false;
try { on = localStorage.getItem("atlas.sound") === "1"; } catch {}

function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.22;
    master.connect(ctx.destination);
  }
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

function tone(type, from, to, ms, peak = 0.5, delay = 0) {
  const a = audio();
  if (!a) return;
  const t = a.currentTime + delay, o = a.createOscillator(), g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(from, t);
  o.frequency.exponentialRampToValueAtTime(to, t + ms / 1000);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + ms / 1000 + 0.02);
}

function whoosh(ms = 520) {
  const a = audio();
  if (!a) return;
  const t = a.currentTime, n = Math.floor(a.sampleRate * ms / 1000);
  const buf = a.createBuffer(1, n, a.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  const src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
  src.buffer = buf;
  f.type = "bandpass";
  f.Q.value = 0.8;
  f.frequency.setValueAtTime(260, t);
  f.frequency.exponentialRampToValueAtTime(1400, t + ms / 2000);
  f.frequency.exponentialRampToValueAtTime(380, t + ms / 1000);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.16, t + ms / 3000);
  g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
  src.connect(f).connect(g).connect(master);
  src.start(t);
}

export const sound = {
  get on() { return on; },
  toggle() {
    on = !on;
    try { localStorage.setItem("atlas.sound", on ? "1" : "0"); } catch {}
    if (on) this.pick();
    return on;
  },
  pick() { if (on) { tone("sine", 620, 930, 110, 0.45); tone("triangle", 1240, 1860, 90, 0.12); } },
  click() { if (on) tone("triangle", 1500, 1100, 45, 0.18); },
  fly() { if (on) whoosh(); },
  night(dark) { if (on) { tone("sine", dark ? 523 : 659, dark ? 392 : 784, 260, 0.25); tone("sine", dark ? 784 : 988, dark ? 587 : 1175, 320, 0.12, 0.09); } },
};
