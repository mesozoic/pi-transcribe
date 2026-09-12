import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { TranscribeConfig } from "./config.js";
import type { AudioCapture } from "./audio.js";
import type { TranscriptionEngine } from "./recognizer.js";

/**
 * Unicode block characters for waveform rendering, from empty to full.
 * Using lower-block elements: ▁▂▃▄▅▆▇█
 */
const WAVEFORM_BLOCKS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/** Number of RMS samples to keep for waveform display */
const WAVEFORM_HISTORY = 60;

/** How often to push a new waveform sample (ms) */
const WAVEFORM_INTERVAL = 100;

export class DictationSession {
  private audioCapture: AudioCapture;
  private engine: TranscriptionEngine;
  private config: TranscribeConfig;

  private _isActive = false;

  /** Raw audio buffer — accumulates all recorded PCM data */
  private audioChunks: Int16Array[] = [];
  private totalSamples = 0;

  /** Waveform state */
  private rmsHistory: number[] = [];
  private rmsAccum: number[] = [];
  private waveformTimer: ReturnType<typeof setInterval> | null = null;
  private startTime = 0;

  /** UI refs */
  private tui: TUI | null = null;

  constructor(
    audioCapture: AudioCapture,
    engine: TranscriptionEngine,
    config: TranscribeConfig
  ) {
    this.audioCapture = audioCapture;
    this.engine = engine;
    this.config = config;
  }

  get isActive(): boolean {
    return this._isActive;
  }

  /** Set the TUI reference for triggering re-renders */
  setTui(tui: TUI): void {
    this.tui = tui;
  }

  /** Get waveform bars for rendering. Returns array of block characters. */
  getWaveformBars(maxBars: number): string[] {
    const history = this.rmsHistory;
    const start = Math.max(0, history.length - maxBars);
    const slice = history.slice(start);

    const bars: string[] = [];
    for (let i = 0; i < maxBars - slice.length; i++) {
      bars.push(WAVEFORM_BLOCKS[0]);
    }

    for (const rms of slice) {
      // Map RMS to block index using sqrt scale for better dynamic range.
      // Speech RMS is typically 0.01-0.15; sqrt compresses the range so
      // normal speech fills the full bar height instead of staying in the bottom half.
      const normalized = Math.min(1, Math.sqrt(rms) * 3);
      const idx = Math.round(normalized * (WAVEFORM_BLOCKS.length - 1));
      bars.push(WAVEFORM_BLOCKS[idx]);
    }

    return bars;
  }

  /** Get elapsed time as MM:SS */
  getElapsedTime(): string {
    if (!this._isActive) return "00:00";
    const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
    const mins = String(Math.floor(elapsed / 60)).padStart(2, "0");
    const secs = String(elapsed % 60).padStart(2, "0");
    return `${mins}:${secs}`;
  }

  /** Start a dictation session */
  start(ctx: ExtensionContext): void {
    if (this._isActive) return;

    this._isActive = true;
    this.audioChunks = [];
    this.totalSamples = 0;
    this.rmsHistory = [];
    this.rmsAccum = [];
    this.startTime = Date.now();

    // Periodically average accumulated RMS values into a single waveform sample
    this.waveformTimer = setInterval(() => {
      if (this.rmsAccum.length > 0) {
        const avg = this.rmsAccum.reduce((a, b) => a + b, 0) / this.rmsAccum.length;
        this.rmsHistory.push(avg);
        this.rmsAccum = [];
      } else {
        this.rmsHistory.push(0);
      }
      if (this.rmsHistory.length > WAVEFORM_HISTORY * 2) {
        this.rmsHistory = this.rmsHistory.slice(-WAVEFORM_HISTORY);
      }
      this.requestRender();
    }, WAVEFORM_INTERVAL);

    // Start audio capture
    this.audioCapture.start(
      (samples: Int16Array, rms: number) => {
        this.audioChunks.push(new Int16Array(samples));
        this.totalSamples += samples.length;
        this.rmsAccum.push(rms);
      },
      (err: Error) => {
        ctx.ui.notify(`Microphone error: ${err.message}`, "error");
        this.cleanup();
        ctx.ui.setWidget("pi-transcribe", undefined);
        ctx.ui.setStatus("pi-transcribe", undefined);
      }
    );
  }

  /**
   * Stop dictation — finalize and batch-transcribe.
   * Returns the transcribed text (caller handles insertion).
   */
  async stop(ctx: ExtensionContext): Promise<string> {
    if (!this._isActive) return "";

    this.audioCapture.stop();
    this._isActive = false;
    this.stopWaveformTimer();

    const audioBuffer = this.buildAudioBuffer();
    const duration = this.totalSamples / this.config.sampleRate;

    if (duration < 0.3) {
      ctx.ui.notify("Recording too short", "info");
      this.cleanup();
      return "";
    }

    const text = await this.engine.transcribe(audioBuffer);
    this.cleanup();
    return text;
  }

  /** Cancel dictation — discard audio */
  cancel(_ctx: ExtensionContext): void {
    if (!this._isActive) return;
    this.audioCapture.stop();
    this._isActive = false;
    this.cleanup();
  }

  /** Build a single Buffer from accumulated audio chunks */
  private buildAudioBuffer(): Buffer {
    const result = new Int16Array(this.totalSamples);
    let offset = 0;
    for (const chunk of this.audioChunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return Buffer.from(result.buffer, result.byteOffset, result.byteLength);
  }

  private stopWaveformTimer(): void {
    if (this.waveformTimer) {
      clearInterval(this.waveformTimer);
      this.waveformTimer = null;
    }
  }

  private cleanup(): void {
    this.stopWaveformTimer();
    this.audioChunks = [];
    this.totalSamples = 0;
    this.rmsHistory = [];
    this.rmsAccum = [];
  }

  private requestRender(): void {
    if (this.tui?.requestRender) {
      this.tui.requestRender();
    }
  }
}
