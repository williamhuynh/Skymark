/**
 * Audio capture pipeline (renderer).
 *
 * Pulls system audio via Electron's desktopCapturer (loopback on Windows)
 * and mic via getUserMedia, mixes them through the Web Audio API, and
 * emits 16 kHz mono Int16 PCM chunks to the caller.
 *
 * Chunks are sent at ~100 ms cadence (1600 samples @ 16 kHz). Main process
 * forwards them as-is to the Deepgram WebSocket.
 */

export type AudioCaptureHandle = {
  stop: () => Promise<void>;
};

export type AudioCaptureCallbacks = {
  onChunk: (pcm: ArrayBuffer) => void;
  onError: (err: Error) => void;
};

const TARGET_SAMPLE_RATE = 16000;
const CHUNK_MS = 100;

async function getSystemAudioStream(): Promise<MediaStream | null> {
  // Electron >= 27: desktopCapturer lives in main but we can use getDisplayMedia
  // with 'chromeMediaSource: desktop' in renderer when a session handler is set.
  // Simpler: ask for audio-only display capture.
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: false,
      audio: true,
    });
    // If the user declines screen+audio prompt, this rejects.
    return stream;
  } catch (err) {
    console.warn('[audio] system audio capture failed:', err);
    return null;
  }
}

async function getMicStream(): Promise<MediaStream | null> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        channelCount: 1,
      },
    });
  } catch (err) {
    console.warn('[audio] mic capture failed:', err);
    return null;
  }
}

export async function startAudioCapture(
  cb: AudioCaptureCallbacks,
): Promise<AudioCaptureHandle> {
  const [systemStream, micStream] = await Promise.all([getSystemAudioStream(), getMicStream()]);
  if (!systemStream && !micStream) {
    throw new Error('No audio sources available — grant mic and/or screen-audio permission');
  }

  // AudioContext at target rate so we skip manual resampling. Chromium honours this.
  const ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
  const mixer = ctx.createGain();
  mixer.gain.value = 1.0;

  const sources: MediaStreamAudioSourceNode[] = [];
  if (systemStream) {
    const src = ctx.createMediaStreamSource(systemStream);
    src.connect(mixer);
    sources.push(src);
  }
  if (micStream) {
    const src = ctx.createMediaStreamSource(micStream);
    src.connect(mixer);
    sources.push(src);
  }

  // ScriptProcessor is deprecated but works today and avoids AudioWorklet file loading.
  // Buffer size 1600 @ 16 kHz = 100 ms frames.
  const bufferSize = Math.round((TARGET_SAMPLE_RATE * CHUNK_MS) / 1000);
  // ScriptProcessor buffer must be a power of 2 between 256 and 16384; nearest is 2048.
  const spBufferSize = 2048;
  const processor = ctx.createScriptProcessor(spBufferSize, 1, 1);
  mixer.connect(processor);
  processor.connect(ctx.destination);

  let pending = new Float32Array(0);
  processor.onaudioprocess = (event) => {
    try {
      const input = event.inputBuffer.getChannelData(0);
      const combined = new Float32Array(pending.length + input.length);
      combined.set(pending, 0);
      combined.set(input, pending.length);

      const fullFrames = Math.floor(combined.length / bufferSize);
      for (let i = 0; i < fullFrames; i++) {
        const frame = combined.subarray(i * bufferSize, (i + 1) * bufferSize);
        const int16 = floatToInt16(frame);
        cb.onChunk(int16.buffer as ArrayBuffer);
      }
      pending = combined.subarray(fullFrames * bufferSize);
    } catch (err) {
      cb.onError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  return {
    async stop() {
      processor.disconnect();
      for (const s of sources) s.disconnect();
      mixer.disconnect();
      for (const track of [...(systemStream?.getTracks() ?? []), ...(micStream?.getTracks() ?? [])]) {
        track.stop();
      }
      await ctx.close();
    },
  };
}

function floatToInt16(f: Float32Array): Int16Array {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const s = Math.max(-1, Math.min(1, f[i]));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}
