import { CustomEditor, type EditorFactory, type ExtensionAPI, type ExtensionContext, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

import { loadConfig } from "./config.js";
import { AudioCapture } from "./audio.js";
import { TranscriptionEngine } from "./recognizer.js";
import { DictationSession } from "./dictation.js";

/** Number of rapid spaces needed to trigger recording */
const SPACE_TRIGGER_COUNT = 3;
/** Max time between spaces to count as "holding" (ms) */
const SPACE_GAP_MS = 150;
/** Time after last space to consider key released (ms) */
const SPACE_RELEASE_MS = 200;

export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  let audioCapture: AudioCapture | null = null;
  let dictation: DictationSession | null = null;
  let pvrecorderAvailable = true;
  let currentCtx: ExtensionContext | null = null;
  /** Editor factory configured before we installed ours — restored on shutdown */
  let previousEditorFactory: EditorFactory | undefined;

  // Check pvrecorder availability (deferred to session_start via dynamic import)

  // --- Session lifecycle ---

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;

    // Check pvrecorder availability via dynamic import
    try {
      await import("@picovoice/pvrecorder-node");
    } catch {
      pvrecorderAvailable = false;
    }

    if (!pvrecorderAvailable) {
      ctx.ui.notify(
        "pi-transcribe: @picovoice/pvrecorder-node not available. Dictation disabled.",
        "error"
      );
      return;
    }

    // Check transcriber availability — auto-detect tries platform-optimal backends
    const engine = new TranscriptionEngine(config);
    const checkError = await engine.check();
    if (checkError) {
      ctx.ui.notify(`pi-transcribe: ${checkError}`, "error");
      return;
    }


    // Install our custom editor that detects spacebar hold.
    // Remember whatever factory was configured before us (another extension,
    // or undefined for the default editor) so we can restore it on shutdown.
    previousEditorFactory = ctx.ui.getEditorComponent();
    ctx.ui.setEditorComponent((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
      const editor = new DictationEditor(tui, theme, keybindings, {
        onRecordingStart: () => startDictation(ctx, editor),
        onRecordingStop: () => stopDictation(ctx, editor),
        onRecordingCancel: () => {
          if (!dictation?.isActive) return;
          dictation.cancel(ctx);
          ctx.ui.setWidget("pi-transcribe", undefined);
          ctx.ui.setStatus("pi-transcribe", undefined);
          dictation = null;
        },
        pvrecorderAvailable,
      });
      return editor;
    });
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (dictation?.isActive) {
      dictation.cancel(ctx);
    }
    audioCapture = null;
    dictation = null;
    ctx.ui.setStatus("pi-transcribe", undefined);
    ctx.ui.setWidget("pi-transcribe", undefined);
    // Restore the previously configured editor (undefined = default editor)
    ctx.ui.setEditorComponent(previousEditorFactory);
    previousEditorFactory = undefined;
    currentCtx = null;
  });

  // --- Ctrl+Shift+R shortcut (still works as toggle) ---

  pi.registerShortcut("ctrl+shift+r", {
    description: "Toggle speech-to-text dictation",
    handler: async (ctx) => {
      if (!pvrecorderAvailable) {
        ctx.ui.notify("pi-transcribe: Audio capture not available.", "error");
        return;
      }

      if (dictation?.isActive) {
        await stopDictation(ctx);
        return;
      }

      await startDictation(ctx);
    },
  });

  // --- Dictation control ---

  async function startDictation(ctx: ExtensionContext, editor?: DictationEditor) {
    if (dictation?.isActive) return;

    try {
      const engine = new TranscriptionEngine(config);
      const checkErr = await engine.check();
      if (checkErr) {
        ctx.ui.notify(`pi-transcribe: ${checkErr}`, "error");
        return;
      }

      if (!audioCapture) {
        audioCapture = new AudioCapture(config);
      }
      await audioCapture.ensureLoaded();

      dictation = new DictationSession(audioCapture, engine, config);
      dictation.start(ctx);

      ctx.ui.setStatus("pi-transcribe", "🎤 Recording");

      // Widget shows live waveform
      ctx.ui.setWidget("pi-transcribe", (tui: TUI, theme: Theme) => {
        if (dictation) {
          dictation.setTui(tui);
        }

        return {
          render: (width: number) => {
            if (!dictation) return [""];

            const elapsed = dictation.getElapsedTime();
            const label = "🎤 ";
            const time = ` ${elapsed} `;
            const hint = " ␣ release to transcribe · Esc cancel";

            const fixedWidth = label.length + time.length + hint.length + 2;
            const barCount = Math.max(10, Math.min(50, width - fixedWidth));
            const bars = dictation.getWaveformBars(barCount);

            const waveStr = bars.map(bar =>
              bar === " "
                ? theme.fg("dim", bar)
                : theme.fg("accent", bar)
            ).join("");

            const line = theme.fg("accent", label)
              + waveStr
              + theme.fg("muted", time)
              + theme.fg("dim", hint);

            return [line];
          },
          invalidate: () => {},
        };
      }, { placement: "belowEditor" });
    } catch (e: any) {
      ctx.ui.notify(`Failed to start recording: ${e.message}`, "error");
      ctx.ui.setWidget("pi-transcribe", undefined);
      ctx.ui.setStatus("pi-transcribe", undefined);
      dictation = null;
    }
  }

  async function stopDictation(ctx: ExtensionContext, editor?: DictationEditor) {
    if (!dictation?.isActive) return;

    ctx.ui.setStatus("pi-transcribe", "✨ Transcribing...");
    ctx.ui.setWidget("pi-transcribe", (_tui: TUI, theme: Theme) => ({
      render: () => [theme.fg("accent", "✨ Transcribing audio...")],
      invalidate: () => {},
    }), { placement: "belowEditor" });

    try {
      const text = await dictation.stop(ctx);

      // Insert transcribed text at cursor position (instead of appending to editor)
      if (text && text.length > 0 && editor) {
        editor.insertTextAtCursor(text);
      }
    } catch (e: any) {
      ctx.ui.notify(`Transcription error: ${e.message}`, "error");
    }

    ctx.ui.setWidget("pi-transcribe", undefined);
    ctx.ui.setStatus("pi-transcribe", undefined);
    dictation = null;
  }


}

/**
 * Custom editor that detects spacebar hold-to-record.
 *
 * When the user holds spacebar, rapid auto-repeat generates a stream of space characters.
 * After SPACE_TRIGGER_COUNT rapid spaces (within SPACE_GAP_MS of each other),
 * we switch to recording mode and consume further spaces.
 * When spaces stop arriving (SPACE_RELEASE_MS timeout), we stop recording.
 */
class DictationEditor extends CustomEditor {
  private lastSpaceTime = 0;
  private rapidCount = 0;
  private consecutiveSpaces = 0;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  private isRecording = false;
  private callbacks: {
    onRecordingStart: () => void;
    onRecordingStop: () => void;
    onRecordingCancel?: () => void;
    pvrecorderAvailable: boolean;
  };

  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, callbacks: {
    onRecordingStart: () => void;
    onRecordingStop: () => void;
    onRecordingCancel?: () => void;
    pvrecorderAvailable: boolean;
  }) {
    super(tui, theme, keybindings);
    this.callbacks = callbacks;
  }

  handleInput(data: string): void {
    // Escape cancels active recording
    // (matchesKey handles both legacy \x1b and Kitty-protocol escape sequences)
    if (matchesKey(data, "escape") && this.isRecording) {
      this.onSpaceRelease();
      this.callbacks.onRecordingCancel?.();
      return;
    }

    const now = Date.now();

    if (data === " ") {
      const gap = now - this.lastSpaceTime;
      this.lastSpaceTime = now;

      if (this.isRecording) {
        // Already recording — consume space, reset release timer
        this.clearReleaseTimer();
        this.releaseTimer = setTimeout(() => this.onSpaceRelease(), SPACE_RELEASE_MS);
        return;
      }

      // Track rapid spaces for trigger detection
      if (gap <= SPACE_GAP_MS && this.consecutiveSpaces > 0) {
        this.rapidCount++;
      } else {
        this.rapidCount = 1;
      }

      // Always insert the space immediately — no delay
      super.handleInput(data);
      this.consecutiveSpaces++;

      if (this.rapidCount >= SPACE_TRIGGER_COUNT) {
        // Trigger! Remove ALL consecutive trailing spaces and start recording
        const text = this.getText();
        const toRemove = Math.min(this.consecutiveSpaces, text.length);
        if (toRemove > 0 && text.slice(-toRemove) === " ".repeat(toRemove)) {
          this.setText(text.slice(0, -toRemove));
        }

        this.isRecording = true;
        this.consecutiveSpaces = 0;
        this.rapidCount = 0;

        this.callbacks.onRecordingStart();
        this.releaseTimer = setTimeout(() => this.onSpaceRelease(), SPACE_RELEASE_MS);
        return;
      }

      return;
    }

    // Non-space input — reset space tracking
    if (this.isRecording) {
      this.onSpaceRelease();
      return;
    }

    this.consecutiveSpaces = 0;
    this.rapidCount = 0;
    super.handleInput(data);
  }

  private onSpaceRelease(): void {
    if (!this.isRecording) return;
    this.isRecording = false;
    this.consecutiveSpaces = 0;
    this.rapidCount = 0;
    this.clearReleaseTimer();
    this.callbacks.onRecordingStop();
  }

  private clearReleaseTimer(): void {
    if (this.releaseTimer) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
  }
}
