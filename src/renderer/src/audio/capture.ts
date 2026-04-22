/**
 * Audio capture pipeline (renderer).
 *
 * Pulls system audio via Electron's desktopCapturer (auto-picked loopback)
 * and mic via getUserMedia, mixes them through the Web Audio API, and
 * emits native-rate mono Int16 PCM chunks to the caller.
 *
 * No JS resampling: Deepgram is told the actual rate (via StartSessionArgs)
 * and accepts it natively. Avoids aliasing from naive linear interpolation
 * and saves CPU. The session probes the rate via probeSampleRate() before
 * session.start() so main knows what to tell Deepgram.
 *
 * Chunks are sent at ~100 ms cadence. Main forwards them as-is.
 */

export type AudioCaptureHandle = {
  stop: () => Promise<void>;
  getSources: () => { mic: string | null; system: string | null };
  sampleRate: number;
};

export type AudioCaptureCallbacks = {
  onChunk: (pcm: ArrayBuffer) => void;
  onError: (err: Error) => void;
};

const CHUNK_MS = 100;

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
  // 48 kHz; sending native avoids the aliasing caused by naive JS
  // downsampling.
  const ctx = new AudioContext();
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

  const spBufferSize = 4096;
  const processor = ctx.createScriptProcessor(spBufferSize, 1, 1);
  mixer.connect(processor);
  processor.connect(silentSink);

  // Re-chunk to ~100 ms frames at the native rate (e.g. 4800 samples @ 48 kHz).
  const targetFrameSamples = Math.round((ctx.sampleRate * CHUNK_MS) / 1000);
  let pendingTarget = new Float32Array(0);
  let chunkCount = 0;

  processor.onaudioprocess = (event) => {
    try {
      const input = event.inputBuffer.getChannelData(0);

      const merged = new Float32Array(pendingTarget.length + input.length);
      merged.set(pendingTarget);
      merged.set(input, pendingTarget.length);

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
    sampleRate: ctx.sampleRate,
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
