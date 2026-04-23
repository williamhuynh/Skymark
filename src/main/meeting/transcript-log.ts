/**
 * Local write-ahead log for meeting transcripts.
 *
 * Each final transcript event is appended as JSONL under Skymark's userData
 * directory BEFORE we attempt to push it to MC. If MC is unreachable, the
 * renderer crashes, or the laptop hangs mid-meeting, the transcript still
 * exists on disk and reconciliation on Stop replays the delta to MC.
 *
 * Layout:
 *   <userData>/meetings/<meetingId>/transcript.jsonl
 *
 * Writes are serialized through a promise chain so concurrent Deepgram
 * events can never interleave mid-line.
 */

import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { log } from '../log';
import type { TranscriptEvent, TranscriptRecord } from '../../shared/types';

function meetingsDir(): string {
  return path.join(app.getPath('userData'), 'meetings');
}

export function transcriptLogPath(meetingId: string): string {
  return path.join(meetingsDir(), meetingId, 'transcript.jsonl');
}

// Single chain shared across all meetings: Skymark only ever runs one at a
// time, and this guarantees append ordering for the active meeting.
let writeChain: Promise<void> = Promise.resolve();

export function appendTranscriptEvent(
  meetingId: string,
  ev: TranscriptEvent | TranscriptRecord,
): Promise<void> {
  const target = transcriptLogPath(meetingId);
  const line = JSON.stringify(ev) + '\n';
  writeChain = writeChain
    .then(async () => {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.appendFile(target, line, 'utf8');
    })
    .catch((err) => {
      // Swallow so a single write failure doesn't poison every subsequent
      // write in the chain. Still log it.
      log.warn('[transcript-log] append failed:', err);
    });
  return writeChain;
}

export async function readTranscriptEvents(
  meetingId: string,
): Promise<TranscriptRecord[]> {
  const target = transcriptLogPath(meetingId);
  let raw: string;
  try {
    raw = await fs.readFile(target, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: TranscriptRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as TranscriptRecord);
    } catch {
      // Skip corrupt lines (e.g. partial write from a crash) — don't block
      // the whole file over one bad record.
    }
  }
  return out;
}

/**
 * Delete meeting transcript directories older than `keepDays` days.
 * Fire-and-forget; failures are logged but don't throw.
 */
export async function pruneOldTranscripts(keepDays = 30): Promise<number> {
  const root = meetingsDir();
  let removed = 0;
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    log.warn('[transcript-log] prune readdir failed:', err);
    return 0;
  }
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  for (const name of entries) {
    const dir = path.join(root, name);
    try {
      const stat = await fs.stat(dir);
      if (!stat.isDirectory()) continue;
      if (stat.mtimeMs >= cutoff) continue;
      await fs.rm(dir, { recursive: true, force: true });
      removed++;
    } catch (err) {
      log.warn('[transcript-log] prune remove failed for', dir, err);
    }
  }
  if (removed > 0) log.info(`[transcript-log] pruned ${removed} old meeting(s)`);
  return removed;
}
