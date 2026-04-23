/**
 * Audio capture pipeline (renderer).
 *
 * Captures mic and system audio as TWO separate channels (mic on ch 0,
 * system on ch 1) and emits them as interleaved stereo Int16 PCM. Deepgram
 * is told channels=2 + multichannel=true, so it runs an independent ASR
 * pass on each channel and returns per-channel results. Effect: "you vs.
 * everyone else on the call" is correctly attributed without relying on
 * diarization alone.
 *
 * If only one stream is available (permission denied for the other), that
 * channel is filled with silence so Deepgram still gets a valid stereo
 * stream. A fully-silent channel simply produces no transcripts.
 *
 * No JS resampling: Deepgram is told the actual device rate and accepts it
 * natively.
 *
 * Chunks are sent at ~100 ms cadence. Main forwards them as-is.
 */

export type AudioCaptureHandle = {
  stop: () => Promise<void>;
  getSources: () => { mic: string | null; system: string | null };
  sampleRate: number;
  channelCount: number;
};

export type AudioCaptureCallbacks = {
  onChunk: (pcm: ArrayBuffer) => void;
  onError: (err: Error) => void;
};

const CHUNK_MS = 100;
const OUTPUT_CHANNELS = 2;

/**
 * Probe the device's native sample rate without starting full capture.
 * Call before session.start() so Deepgram gets the correct rate.
 */
export async function probeSampleRate(): Promise<number> {
  const ctx = new AudioContext();
  const rate = ctx.sampleRate;
  await ctx.close();
  return rate;
}

async function getSystemAudioStream(): Promise<MediaStream | null> {
  try {
    console.info('[audio] requesting getDisplayMedia (video+audio; video discarded)');
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });
    for (const track of stream.getVideoTracks()) {
      track.stop();
      stream.removeTrack(track);
    }
    const audio = stream.getAudioTracks();
    console.info('[audio] getDisplayMedia returned', audio.length, 'audio track(s)');
    if (audio.length === 0) return null;
    return stream;
  } catch (err) {
    console.warn('[audio] getDisplayMedia failed:', err);
    return null;
  }
}

async function getMicStream(): Promise<MediaStream | null> {
  try {
    console.info('[audio] requesting getUserMedia (mic)');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    console.info('[audio] getUserMedia returned', stream.getAudioTracks().length, 'audio track(s)');
    return stream;
  } catch (err) {
    console.warn('[audio] getUserMedia failed:', err);
    return null;
  }
}

export async function startAudioCapture(
  cb: AudioCaptureCallbacks,
): Promise<AudioCaptureHandle> {
  const [systemStream, micStream] = await Promise.all([getSystemAudioStream(), getMicStream()]);
  console.info(
    '[audio] sources — system:',
    systemStream ? 'ok' : 'none',
    'mic:',
    micStream ? 'ok' : 'none',
  );
  if (!systemStream && !micStream) {
    throw new Error('No audio sources available — grant mic and/or screen-audio permission');
  }

  // Use the device's native sample rate. Deepgram accepts any rate up to
  // 48 kHz; sending native avoids JS resampling + aliasing.
  const ctx = new AudioContext();
  if (ctx.state === 'suspended') {
    await ctx.resume();
  }
  console.info('[audio] context state:', ctx.state, 'sampleRate:', ctx.sampleRate);

  // Route each source to its own ChannelMerger input: mic → ch 0, system → ch 1.
  // For any missing source, feed a silent ConstantSource so the merger always
  // has two inputs (prevents a 1-channel output from taking over).
  const merger = ctx.createChannelMerger(2);

  const silentSource = ctx.createConstantSource();
  silentSource.offset.value = 0;
  silentSource.start();

  const sources: MediaStreamAudioSourceNode[] = [];
  if (micStream) {
    const src = ctx.createMediaStreamSource(micStream);
    src.connect(merger, 0, 0);
    sources.push(src);
  } else {
    silentSource.connect(merger, 0, 0);
  }
  if (systemStream) {
    const src = ctx.createMediaStreamSource(systemStream);
    src.connect(merger, 0, 1);
    sources.push(src);
  } else {
    silentSource.connect(merger, 0, 1);
  }

  // Silent sink so we don't echo the mix back through the speakers (would
  // cause feedback with system-audio capture).
  const silentSink = ctx.createGain();
  silentSink.gain.value = 0;
  silentSink.connect(ctx.destination);

  const spBufferSize = 4096;
  const processor = ctx.createScriptProcessor(spBufferSize, 2, 2);
  merger.connect(processor);
  processor.connect(silentSink);

  // Re-chunk to ~100 ms frames at native rate. "frame" = one sample per
  // channel (so 2 Int16s = 4 bytes in stereo).
  const framesPerChunk = Math.round((ctx.sampleRate * CHUNK_MS) / 1000);
  // Per-channel pending buffers: we keep them separate until we have enough
  // frames to emit, then interleave at emit time.
  let pending0 = new Float32Array(0);
  let pending1 = new Float32Array(0);
  let chunkCount = 0;

  processor.onaudioprocess = (event) => {
    try {
      const in0 = event.inputBuffer.getChannelData(0); // mic (or silence)
      const in1 = event.inputBuffer.getChannelData(1); // system (or silence)

      // Append inputs to per-channel pending buffers.
      const merged0 = new Float32Array(pending0.length + in0.length);
      merged0.set(pending0);
      merged0.set(in0, pending0.length);
      const merged1 = new Float32Array(pending1.length + in1.length);
      merged1.set(pending1);
      merged1.set(in1, pending1.length);

      // Input channels always arrive in lock-step from a single ScriptProcessor
      // callback, so frame counts match. Guard anyway.
      const available = Math.min(merged0.length, merged1.length);
      const fullChunks = Math.floor(available / framesPerChunk);
      for (let c = 0; c < fullChunks; c++) {
        const offset = c * framesPerChunk;
        const frame0 = merged0.subarray(offset, offset + framesPerChunk);
        const frame1 = merged1.subarray(offset, offset + framesPerChunk);
        const interleaved = interleaveToInt16(frame0, frame1);
        cb.onChunk(interleaved.buffer as ArrayBuffer);
        chunkCount++;
        if (chunkCount === 1) console.info('[audio] first stereo PCM chunk dispatched');
        else if (chunkCount % 100 === 0) console.info('[audio] dispatched', chunkCount, 'chunks');
      }
      const consumed = fullChunks * framesPerChunk;
      pending0 = merged0.slice(consumed);
      pending1 = merged1.slice(consumed);
    } catch (err) {
      cb.onError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  return {
    sampleRate: ctx.sampleRate,
    channelCount: OUTPUT_CHANNELS,
    async stop() {
      processor.disconnect();
      silentSink.disconnect();
      merger.disconnect();
      try {
        silentSource.stop();
      } catch {
        // already stopped
      }
      silentSource.disconnect();
      for (const s of sources) s.disconnect();
      for (const track of [...(systemStream?.getTracks() ?? []), ...(micStream?.getTracks() ?? [])]) {
        track.stop();
      }
      await ctx.close();
      console.info('[audio] capture stopped; total chunks:', chunkCount);
    },
    getSources() {
      return {
        mic: micStream?.getAudioTracks()[0]?.label ?? null,
        system: systemStream?.getAudioTracks()[0]?.label ?? null,
      };
    },
  };
}

/**
 * Interleave two mono Float32 frames (same length) into a single Int16Array
 * of stereo samples: [L0, R0, L1, R1, ...]. Clips to [-1, 1] before scaling.
 */
function interleaveToInt16(left: Float32Array, right: Float32Array): Int16Array {
  const frames = left.length;
  const out = new Int16Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    const l = Math.max(-1, Math.min(1, left[i]));
    const r = Math.max(-1, Math.min(1, right[i]));
    out[i * 2] = l < 0 ? Math.round(l * 0x8000) : Math.round(l * 0x7fff);
    out[i * 2 + 1] = r < 0 ? Math.round(r * 0x8000) : Math.round(r * 0x7fff);
  }
  return out;
}
