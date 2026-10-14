import { encodeAudioWav, peakAndRms, validateAudioRecipe, type AudioRecipe } from "./audio-project";

export async function decodeAudio(url: string, ctx: BaseAudioContext) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Audio source unavailable (${response.status})`);
  return ctx.decodeAudioData(await response.arrayBuffer());
}

/** CPU-only browser render. No provider, model loading or GPU service changes. */
export async function renderAudio(recipe: AudioRecipe) {
  if (!validateAudioRecipe(recipe)) throw new Error("Check the layer ranges and render length before rendering.");
  const sr = 48000, context = new OfflineAudioContext(2, Math.ceil(recipe.length * sr), sr);
  const solo = recipe.layers.some(l => l.solo && !l.muted);
  const active = recipe.layers.filter(l => !l.muted && (!solo || l.solo));
  if (!active.length) throw new Error("Unmute a layer before rendering.");
  for (const layer of active) {
    const buffer = await decodeAudio(layer.url, context);
    const source = context.createBufferSource(); source.buffer = buffer;
    source.playbackRate.value = 2 ** (layer.pitch / 12);
    const gain = context.createGain(), filter = context.createBiquadFilter(), pan = context.createStereoPanner();
    filter.type = "lowpass"; filter.frequency.value = layer.lowpass; pan.pan.value = layer.pan;
    const duration = Math.min((layer.end - layer.start) / source.playbackRate.value, recipe.length - layer.offset);
    if (duration <= 0) continue;
    const level = 10 ** (layer.gainDb / 20), t = layer.offset;
    const fi = Math.min(layer.fadeIn, duration / 2), fo = Math.min(layer.fadeOut, duration / 2);
    gain.gain.setValueAtTime(fi ? 0 : level, t);
    if (fi) gain.gain.linearRampToValueAtTime(level, t + fi);
    gain.gain.setValueAtTime(level, t + duration - fo);
    if (fo) gain.gain.linearRampToValueAtTime(0, t + duration);
    source.connect(filter).connect(pan).connect(gain).connect(context.destination);
    source.start(t, layer.start, duration * source.playbackRate.value);
  }
  const mixed = await context.startRendering();
  const channels = [mixed.getChannelData(0).slice(), mixed.getChannelData(1).slice()];
  // Apply gain reduction only; never boost silence or normalise away layer edits.
  const before = peakAndRms(channels), reduction = Math.min(1, 10 ** ((-2 - before.peakDb) / 20));
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) ch[i] *= reduction;
    if (recipe.loop) {
      const cross = Math.min(Math.floor(sr * .025), Math.floor(ch.length / 4));
      const first = ch[0];
      for (let i = 0; i < cross; i++) {
        const blend = .5 - .5 * Math.cos(Math.PI * (i + 1) / cross);
        const index = ch.length - cross + i;
        ch[index] = ch[index] * (1 - blend) + first * blend;
      }
    }
  }
  return { wav: encodeAudioWav(channels, sr), ...peakAndRms(channels), reductionDb: 20 * Math.log10(reduction) };
}
