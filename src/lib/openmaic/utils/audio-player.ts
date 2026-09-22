/**
 * Audio Player - Audio player interface
 *
 * Handles audio playback, pause, stop, and other operations
 * Loads pre-generated TTS audio files from IndexedDB
 *
 */

import { db } from '@openmaic/lib/utils/database';
import { createLogger } from '@openmaic/lib/logger';
import { hasWavHeader, normalizePlayableWav } from '@openmaic/lib/audio/wav-container';

const log = createLogger('AudioPlayer');
const PLAYBACK_WARMUP_MS = 320;
const PLAYBACK_WARMUP_VOLUME = 0.001;

function isWavAudio(blob: Blob, format?: string): boolean {
  const lowerFormat = format?.toLowerCase();
  return lowerFormat === 'wav' || blob.type.includes('audio/wav') || blob.type.includes('audio/x-wav');
}

async function normalizeAudioBlob(blob: Blob, format?: string): Promise<Blob> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (!isWavAudio(blob, format) && !hasWavHeader(bytes)) return blob;
  const normalized = normalizePlayableWav(bytes);
  const normalizedBuffer = normalized.buffer.slice(
    normalized.byteOffset,
    normalized.byteOffset + normalized.byteLength,
  ) as ArrayBuffer;
  return new Blob([normalizedBuffer], { type: 'audio/wav' });
}

async function describeAudioBlob(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  const signature = Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join(' ');
  return `type=${blob.type || 'unknown'}, size=${blob.size}, signature=${signature}`;
}

/**
 * Audio player implementation
 */
export class AudioPlayer {
  private audio: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;
  private onEndedCallback: (() => void) | null = null;
  private muted: boolean = false;
  private volume: number = 1;
  private playbackRate: number = 1;
  private warmupNextPlayback: boolean = true;
  private warmupAudio: HTMLAudioElement | null = null;

  /**
   * Play audio (from URL or IndexedDB pre-generated cache)
   * @param audioId Audio ID
   * @param audioUrl Optional server-generated audio URL (takes priority over IndexedDB)
   * @returns true if audio started playing, false if no audio (TTS disabled or not generated)
   */
  public async play(
    audioId: string,
    audioUrl?: string,
    startRatio: number = 0,
  ): Promise<boolean> {
    try {
      // 1. Try audioUrl first (server-generated TTS)
      if (audioUrl) {
        this.stop();
        this.audio = new Audio();
        this.audio.src = audioUrl;
        if (this.muted) this.audio.volume = 0;
        else this.audio.volume = this.volume;
        this.audio.defaultPlaybackRate = this.playbackRate;
        this.audio.playbackRate = this.playbackRate;
        await this.seekToRatioWhenReady(this.audio, startRatio);
        const audio = this.audio;
        audio.addEventListener('ended', () => {
          if (this.warmupAudio === audio || this.audio !== audio) return;
          this.onEndedCallback?.();
        });
        if (!await this.warmupIfNeeded(audio, startRatio)) return false;
        try {
          await audio.play();
          return true;
        } catch (playError) {
          this.stop();
          const response = await fetch(audioUrl);
          if (!response.ok) throw playError;
          const sourceBlob = await response.blob();
          const normalizedBlob = await normalizeAudioBlob(sourceBlob, audioUrl.split('.').pop());
          const blobUrl = URL.createObjectURL(normalizedBlob);
          this.objectUrl = blobUrl;
          this.audio = new Audio();
          this.audio.src = blobUrl;
          if (this.muted) this.audio.volume = 0;
          else this.audio.volume = this.volume;
          this.audio.defaultPlaybackRate = this.playbackRate;
          this.audio.playbackRate = this.playbackRate;
          await this.seekToRatioWhenReady(this.audio, startRatio);
          const fallbackAudio = this.audio;
          fallbackAudio.addEventListener('ended', () => {
            if (this.warmupAudio === fallbackAudio || this.audio !== fallbackAudio) return;
            this.revokeObjectUrl();
            this.onEndedCallback?.();
          });
          if (!await this.warmupIfNeeded(fallbackAudio, startRatio)) return false;
          try {
            await fallbackAudio.play();
          } catch (retryError) {
            this.revokeObjectUrl();
            log.error(
              `Retry failed for audioUrl=${audioUrl}; ${await describeAudioBlob(normalizedBlob)}`,
              retryError,
            );
            throw retryError;
          }
          return true;
        }
      }

      // 2. Fall back to IndexedDB (client-generated TTS)
      const audioRecord = await db.audioFiles.get(audioId);

      if (!audioRecord) {
        // Pre-generated audio does not exist (generation failed), skip silently
        return false;
      }

      // Stop current playback
      this.stop();

      // Create audio element
      this.audio = new Audio();

      // Set audio source
      const playableBlob = await normalizeAudioBlob(audioRecord.blob, audioRecord.format);
      const blobUrl = URL.createObjectURL(playableBlob);
      this.objectUrl = blobUrl;
      this.audio.src = blobUrl;
      if (this.muted) this.audio.volume = 0;
      else this.audio.volume = this.volume;

      // Apply playback rate
      this.audio.defaultPlaybackRate = this.playbackRate;
      this.audio.playbackRate = this.playbackRate;
      await this.seekToRatioWhenReady(this.audio, startRatio);
      const audio = this.audio;

      // Set ended callback
      audio.addEventListener('ended', () => {
        if (this.warmupAudio === audio || this.audio !== audio) return;
        this.revokeObjectUrl();
        this.onEndedCallback?.();
      });
      if (!await this.warmupIfNeeded(audio, startRatio)) return false;

      // Play. If play() rejects (autoplay policy, decode error, interrupted
      // load) the 'ended' listener never fires, so revoke the blob URL here to
      // avoid leaking it for the lifetime of the document.
      try {
        await audio.play();
      } catch (playError) {
        this.revokeObjectUrl();
        log.error(
          `IndexedDB audio failed for audioId=${audioId}; format=${audioRecord.format}; ${await describeAudioBlob(
            playableBlob,
          )}`,
          playError,
        );
        throw playError;
      }
      // Re-apply after play() — some browsers reset during load
      return true;
    } catch (error) {
      log.error('Failed to play audio:', error);
      throw error;
    }
  }

  /**
   * Pause playback
   */
  public pause(): void {
    if (this.audio && !this.audio.paused) {
      this.audio.pause();
      if (this.warmupAudio === this.audio) {
        this.audio.currentTime = 0;
        this.audio.volume = this.muted ? 0 : this.volume;
        this.warmupAudio = null;
        this.warmupNextPlayback = false;
      }
    }
  }

  /**
   * Stop playback
   */
  public stop(): void {
    if (this.audio) {
      this.audio.pause();
      this.audio.currentTime = 0;
      if (this.warmupAudio === this.audio) this.warmupAudio = null;
      this.audio = null;
    }
    this.revokeObjectUrl();
    // Note: onEndedCallback intentionally NOT cleared here because play()
    // calls stop() internally — clearing would break the callback chain.
    // Stale callbacks are harmless: engine mode check prevents processNext().
  }

  /**
   * Resume playback
   */
  public resume(): void {
    if (this.audio?.paused) {
      this.audio.playbackRate = this.playbackRate;
      this.audio.play().catch((error) => {
        log.error('Failed to resume audio:', error);
      });
    }
  }

  /**
   * Get current playback status (actively playing, not paused)
   */
  public isPlaying(): boolean {
    return this.audio !== null && !this.audio.paused;
  }

  /**
   * Whether there is active audio (playing or paused, but not ended)
   * Used to decide whether to resume playback or skip to the next line
   */
  public hasActiveAudio(): boolean {
    return this.audio !== null;
  }

  /**
   * Get current playback time (milliseconds)
   */
  public getCurrentTime(): number {
    return this.audio && this.warmupAudio !== this.audio ? this.audio.currentTime * 1000 : 0;
  }

  /**
   * Get audio duration (milliseconds)
   */
  public getDuration(): number {
    return this.audio && !isNaN(this.audio.duration) ? this.audio.duration * 1000 : 0;
  }

  /**
   * Set playback ended callback
   */
  public onEnded(callback: () => void): void {
    this.onEndedCallback = callback;
  }

  /**
   * Warm the media output before the next clip starts audibly. Laptop and
   * Bluetooth sinks can take a few hundred milliseconds to wake after a page
   * change; without a pre-roll that startup latency clips the first words.
   */
  public requestPlaybackWarmup(): void {
    this.warmupNextPlayback = true;
  }

  /**
   * Set mute state (takes effect immediately on currently playing audio)
   */
  public setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.audio) {
      this.audio.volume = muted ? 0 : this.volume;
    }
  }

  /**
   * Set volume (0-1)
   */
  public setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.audio && !this.muted) {
      this.audio.volume = this.volume;
    }
  }

  /**
   * Set playback speed (takes effect immediately on currently playing audio)
   */
  public setPlaybackRate(rate: number): void {
    this.playbackRate = Math.max(0.5, Math.min(2, rate));
    if (this.audio) {
      this.audio.playbackRate = this.playbackRate;
    }
  }

  /**
   * Destroy the player
   */
  public destroy(): void {
    this.stop();
    this.onEndedCallback = null;
  }

  private revokeObjectUrl(): void {
    if (!this.objectUrl) return;
    URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
  }

  private async warmupIfNeeded(
    audio: HTMLAudioElement,
    startRatio: number,
  ): Promise<boolean> {
    if (!this.warmupNextPlayback || startRatio > 0 || this.muted || this.volume <= 0) {
      this.warmupNextPlayback = false;
      return this.audio === audio;
    }

    audio.volume = Math.min(this.volume, PLAYBACK_WARMUP_VOLUME);
    this.warmupAudio = audio;
    await audio.play();
    await new Promise<void>((resolve) => window.setTimeout(resolve, PLAYBACK_WARMUP_MS));
    if (this.audio !== audio || this.warmupAudio !== audio) return false;

    audio.pause();
    audio.currentTime = 0;
    audio.volume = this.muted ? 0 : this.volume;
    this.warmupAudio = null;
    this.warmupNextPlayback = false;
    return true;
  }

  /** Seek after metadata is available so subtitle clicks start at that sentence. */
  private async seekToRatioWhenReady(audio: HTMLAudioElement, ratio: number): Promise<void> {
    const normalizedRatio = Math.max(0, Math.min(0.999, ratio));
    if (normalizedRatio <= 0) return;
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      audio.currentTime = audio.duration * normalizedRatio;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error('Timed out while loading audio metadata for subtitle seek'));
      }, 8_000);
      const cleanup = () => {
        window.clearTimeout(timeout);
        audio.removeEventListener('loadedmetadata', onMetadata);
        audio.removeEventListener('error', onError);
      };
      const onMetadata = () => {
        cleanup();
        if (Number.isFinite(audio.duration) && audio.duration > 0) {
          audio.currentTime = audio.duration * normalizedRatio;
        }
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error('Audio metadata could not be loaded for subtitle seek'));
      };
      audio.addEventListener('loadedmetadata', onMetadata, { once: true });
      audio.addEventListener('error', onError, { once: true });
      audio.load();
    });
  }
}

/**
 * Create an audio player instance
 */
export function createAudioPlayer(): AudioPlayer {
  return new AudioPlayer();
}
