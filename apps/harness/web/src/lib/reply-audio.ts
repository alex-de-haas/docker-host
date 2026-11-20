/** Use the rendered response and original Markdown heading ranks, including nested subsections. */
export function readableReplyText(root: HTMLElement, section?: HTMLElement): string {
  const range = document.createRange();
  range.selectNodeContents(root);
  if (section) {
    if (!root.contains(section)) return "";
    const headings = Array.from(root.querySelectorAll<HTMLElement>("[data-speech-level]"));
    const index = headings.indexOf(section);
    if (index < 0) return "";
    const end = headings.slice(index + 1).find(h => Number(h.dataset.speechLevel) <= Number(section.dataset.speechLevel));
    range.setStartBefore(section);
    if (end) range.setEndBefore(end);
  }
  const body = range.cloneContents();
  body.querySelectorAll("button, svg, input, [hidden], [aria-hidden=true], .sr-only, script, style").forEach(el => el.remove());
  for (const block of body.querySelectorAll("[data-slot=code-block]")) {
    const lines = Array.from(block.querySelectorAll("[data-slot=code-block-line-content]"), line => line.textContent ?? "");
    block.replaceWith(document.createTextNode("\n" + lines.join("\n") + "\n"));
  }
  body.querySelectorAll("br").forEach(el => el.replaceWith("\n"));
  body.querySelectorAll("p,h1,h2,h3,h4,h5,h6,li,tr,blockquote").forEach(el => el.append("\n"));
  body.querySelectorAll("th,td").forEach(el => el.append(" "));
  return (body.textContent ?? "").replace(/[^\S\n]*\n(?:\s*\n)*/g, "\n").trim();
}

/** Keep source characters and prefer a paragraph or word boundary between provider requests. */
export function* speechChunks(text: string, limit: number): Generator<string> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("The provider has no usable text limit.");
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + limit, text.length);
    if (end < text.length) {
      if (/[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
      if (end === start) throw new Error("The provider limit is too small for this character.");
      const piece = text.slice(start, end);
      const boundary = Math.max(piece.lastIndexOf("\n"), piece.lastIndexOf(" "));
      if (boundary >= piece.length / 2) end = start + boundary + 1;
    }
    yield text.slice(start, end);
    start = end;
  }
}

/** Schedule short PCM buffers as bytes arrive, retaining at most about one second ahead of playback. */
export async function playPcm(response: Response, audio: AudioContext, signal: AbortSignal): Promise<void> {
  if (!response.body) throw new Error("The provider returned no audio.");
  const reader = response.body.getReader();
  let at = audio.currentTime, lastByte: number | null = null, count = 0, received = false;
  const samples = new Float32Array(2400);
  const pause = () => new Promise<void>(resolve => setTimeout(resolve, 40));
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  async function schedule() {
    while (at > audio.currentTime + 1) { signal.throwIfAborted(); await pause(); }
    signal.throwIfAborted();
    const buffer = audio.createBuffer(1, count, 24000);
    buffer.getChannelData(0).set(samples.subarray(0, count));
    const source = audio.createBufferSource(); source.buffer = buffer; source.connect(audio.destination);
    source.onended = () => source.disconnect();
    at = Math.max(at, audio.currentTime + 0.008);
    source.start(at); at += count / 24000; count = 0; received = true;
  }
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      for (const byte of value) {
        if (lastByte === null) { lastByte = byte; continue; }
        const signed = (lastByte | (byte << 8)) << 16 >> 16;
        samples[count++] = signed / 32768; lastByte = null;
        if (count === samples.length) await schedule();
      }
    }
    signal.throwIfAborted();
    if (lastByte !== null) throw new Error("The audio stream ended mid-sample.");
    if (count) await schedule();
    if (!received) throw new Error("The provider returned no audio.");
    while (at > audio.currentTime) { signal.throwIfAborted(); await pause(); }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
}
