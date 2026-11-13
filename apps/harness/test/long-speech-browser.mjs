// Standalone Web Audio unit fixture. This origin does not verify Hosty login, embedding,
// microphone capture, managed-child routing, speech recognition, or a deployed proxy deadline.
import assert from "node:assert/strict";
import { build } from "esbuild";

const { chromium } = await import(process.env.HOSTY_SPEECH_PLAYWRIGHT_MODULE || process.env.HOSTY_QUEUE_PLAYWRIGHT_MODULE || "playwright");
const bundle = await build({ entryPoints: [new URL("../web/src/lib/speech-audio.ts", import.meta.url).pathname],
  bundle: true, write: false, format: "iife", globalName: "SpeechAudio", platform: "browser" });
const browser = await chromium.launch({ headless: true,
  channel: process.env.HOSTY_SPEECH_BROWSER_CHANNEL || process.env.HOSTY_QUEUE_BROWSER_CHANNEL || "chrome" });
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
try {
  const context = await browser.newContext();
  await context.route("http://speech-fixture.localhost/**", route => route.fulfill({
    contentType: "text/html", body: "<!doctype html><title>Long speech Web Audio unit fixture</title>",
  }));
  const page = await context.newPage(); await page.goto("http://speech-fixture.localhost/");
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const cdp = await context.newCDPSession(page); await cdp.send("Performance.enable");
  const samples = [];
  const sample = async () => {
    const [performance, heap] = await Promise.all([
      cdp.send("Performance.getMetrics"), cdp.send("Runtime.getHeapUsage"),
    ]);
    const metrics = Object.fromEntries(performance.metrics.map(metric => [metric.name, metric.value]));
    const value = { jsHeapBytes: metrics.JSHeapUsedSize, backingStorageBytes: heap.backingStorageSize,
      embedderHeapBytes: heap.embedderHeapUsedSize };
    samples.push(value); return value;
  };
  await cdp.send("HeapProfiler.collectGarbage");
  const empty = await sample();
  const fixture = await page.evaluate(() => {
    const samples = new Float32Array(600 * 16000);
    // Deterministic low-volume square wave: all audio is generated in memory, without an
    // operating-system microphone, stored audio, user speech, or provider credentials.
    for (let at = 0; at < samples.length; at++) samples[at] = at % 16000 < 8000 ? 0.125 : -0.125;
    globalThis.longSpeechFixture = globalThis.SpeechAudio.pcmWave(samples);
    return { seconds: samples.length / 16000, bytes: globalThis.longSpeechFixture.size };
  });
  assert.deepEqual(fixture, { seconds: 600, bytes: 19_200_044 });
  await cdp.send("HeapProfiler.collectGarbage");
  const before = await sample();
  let measuring = true;
  const sampling = (async () => {
    while (measuring) { await sample(); if (measuring) await pause(20); }
  })();
  let conversion;
  try {
    conversion = await page.evaluate(async () => {
      const started = performance.now();
      const wave = await globalThis.SpeechAudio.recordingWave(globalThis.longSpeechFixture,
        { maxDurationSeconds: 600, maxBytes: 19_200_044 });
      globalThis.longSpeechOutput = wave;
      const elapsedMs = performance.now() - started, view = new DataView(await wave.arrayBuffer());
      return { bytes: wave.size, seconds: view.getUint32(40, true) / 2 / 16000, elapsedMs,
        channels: view.getUint16(22, true), sampleRate: view.getUint32(24, true), bits: view.getUint16(34, true),
        riffBytes: view.getUint32(4, true) + 8 };
    });
    await sample();
  } finally { measuring = false; await sampling; }
  const after = await sample();
  assert.equal(conversion.bytes, 19_200_044); assert.equal(conversion.riffBytes, conversion.bytes);
  assert.equal(conversion.seconds, 600); assert.equal(conversion.sampleRate, 16000);
  assert.equal(conversion.channels, 1); assert.equal(conversion.bits, 16);
  assert.ok(samples.length >= 3); assert.ok(Number.isFinite(before.jsHeapBytes));
  await page.evaluate(() => {
    let refused = false;
    try { globalThis.SpeechAudio.pcmWave(new Float32Array(600 * 16000 + 1)); }
    catch (error) { refused = String(error.message).includes("10:00"); }
    if (!refused) throw new Error("One PCM sample above the ten-minute limit was accepted.");
    delete globalThis.longSpeechFixture; delete globalThis.longSpeechOutput;
  });
  const peak = Object.fromEntries(Object.keys(before).map(key => [key,
    samples.some(value => Number.isFinite(value[key])) ? Math.max(...samples.map(value => value[key] ?? 0)) : null]));
  console.log(JSON.stringify({ fixture: "Standalone Chromium Web Audio unit check", browser: await browser.version(),
    platform: process.platform, architecture: process.arch, fixtureSeconds: fixture.seconds, outputBytes: conversion.bytes,
    conversionMs: Math.round(conversion.elapsedMs), samples: samples.length, sampleIntervalMs: 20,
    memory: { empty, beforeConversion: before, sampledPeak: peak, afterConversion: after },
    limits: "Sampled CDP JS heap/backing/embedder metrics are partial; they exclude total renderer/native audio/process RSS and can miss short peaks. No microphone, cancellation or managed Hosty verification." }, null, 2));
  await context.close();
  console.log("PASS: actual Chromium recordingWave converts 600 seconds to 16 kHz mono PCM16 WAV and rejects one extra PCM sample.");
} finally { await browser.close(); }
