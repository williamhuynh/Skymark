/**
 * Audio capture pipeline (renderer).
 *
 * Pulls system audio via Electron's desktopCapturer (auto-picked loopback)
 * and mic via getUserMedia, mixes them through the Web Audio API, and
 * emits 16 kHz mono Int16 PCM chunks to the caller.
 *
 * Chunks are sent at ~100 ms cadence (1600 samples @ 16 kHz). Main
 * forwards them as-is to the Deepgram WebSocket.
 */

export type AudioCaptureHandle = {
  stop: () => Promise<void>;
  getSources: () => { mic: string | null; system: string | null };
};

export type AudioCaptureCallbacks = {
  onChunk: (pcm: ArrayBuffer) => void;
  onError: (err: Error) => void;
};

const TARGET_SAMPLE_RATE = 16000;
const CHUNK_MS = 100;

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

  // Create the AudioContext. Chromium may or may not honour the requested
  // sampleRate; resamples to device rate if not. We check the actual value
  // and log any mismatch so debugging is fast when transcripts look off.
  let ctx: AudioContext;
  try {
    ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
  } catch (err) {
    console.warn('[audio] AudioContext(16k) failed, falling back to default:', err);
    ctx = new AudioContext();
  }
  if (ctx.sampleRate !== TARGET_SAMPLE_RATE) {
    console.warn(
      `[audio] context sample rate is ${ctx.sampleRate}Hz, not ${TARGET_SAMPLE_RATE}Hz — resampling in JS`,
    );
  }
  if (ctx.state === 'suspended') {
    await ctx.resume();
  }
  console.info('[audio] context state:', ctx.state, 'sampleRate:', ctx.sampleRate);

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

  // Route processor output through a silent sink so we don't echo the mix
  // back through the speakers (would cause feedback with system-audio capture).
  const silentSink = ctx.createGain();
  silentSink.gain.value = 0;
  silentSink.connect(ctx.destination);

  const ratio = TARGET_SAMPLE_RATE / ctx.sampleRate;
  const spBufferSize = 4096;
  const processor = ctx.createScriptProcessor(spBufferSize, 1, 1);
  mixer.connect(processor);
  processor.connect(silentSink);

  const targetFrameSamples = Math.round((TARGET_SAMPLE_RATE * CHUNK_MS) / 1000); // 1600 @16k
  let resampleLeftover = new Float32Array(0);
  let pendingTarget = new Float32Array(0);
  let chunkCount = 0;

  processor.onaudioprocess = (event) => {
    try {
      const input = event.inputBuffer.getChannelData(0);

      // Resample from ctx.sampleRate → 16 kHz using simple linear interpolation.
      // Low CPU cost; quality is fine for ASR on speech.
      let resampled: Float32Array;
      if (ratio === 1) {
        resampled = input;
      } else {
        const combined = new Float32Array(resampleLeftover.length + input.length);
        combined.set(resampleLeftover);
        combined.set(input, resampleLeftover.length);

        const outLen = Math.floor(combined.length * ratio);
        resampled = new Float32Array(outLen);
        for (let i = 0; i < outLen; i++) {
          const srcIdx = i / ratio;
          const i0 = Math.floor(srcIdx);
          const i1 = Math.min(i0 + 1, combined.length - 1);
          const frac = srcIdx - i0;
          resampled[i] = combined[i0] * (1 - frac) + combined[i1] * frac;
        }

        const consumedSrc = Math.floor(outLen / ratio);
        resampleLeftover = combined.slice(consumedSrc);
      }

      // Re-chunk to fixed 100ms frames at 16 kHz.
      const merged = new Float32Array(pendingTarget.length + resampled.length);
      merged.set(pendingTarget);
      merged.set(resampled, pendingTarget.length);

      const fullFrames = Math.floor(merged.length / targetFrameSamples);
      for (let i = 0; i < fullFrames; i++) {
        const frame = merged.subarray(i * targetFrameSamples, (i + 1) * targetFrameSamples);
        const int16 = floatToInt16(frame);
        cb.onChunk(int16.buffer as ArrayBuffer);
        chunkCount++;
        if (chunkCount === 1) console.info('[audio] first PCM chunk dispatched');
        else if (chunkCount % 100 === 0) console.info('[audio] dispatched', chunkCount, 'chunks');
      }
      pendingTarget = merged.slice(fullFrames * targetFrameSamples);
    } catch (err) {
      cb.onError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  return {
    async stop() {
      processor.disconnect();
      silentSink.disconnect();
      for (const s of sources) s.disconnect();
      mixer.disconnect();
      for (const track of [...(systemStream?.getTracks() ?? []), ...(micStream?.getTracks() ?? [])]) {
        track.stop();
      }
      await ctx.close();
      console.info('[audio] capture stopped; total chunks:', chunkCount);
    },
    getSources() {
      // Labels only populate after permission is granted. Fall back to empty
      // strings rather than null-confusing the UI.
      return {
        mic: micStream?.getAudioTracks()[0]?.label ?? null,
        system: systemStream?.getAudioTracks()[0]?.label ?? null,
      };
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
