import { EventEmitter } from 'node:events';
import { exec } from 'node:child_process';
import type { DetectedMeeting } from '../../shared/types';

const POLL_INTERVAL_MS = 5_000;
const RETRIGGER_COOLDOWN_MS = 60_000;

const TEAMS_PROCESS_NAMES = new Set(['ms-teams.exe', 'Teams.exe']);
const MEET_TITLE_HINTS = [/\bMeet\b.*\bGoogle Chrome\b/i, /\bGoogle Meet\b/i, /\bMeet\b.*\bEdge\b/i];

type TaskRow = {
  imageName: string;
  pid: string;
  windowTitle: string;
};

function runTasklist(): Promise<TaskRow[]> {
  return new Promise((resolve) => {
    // /v: verbose (includes window titles). /fo csv: parseable. /nh: no header.
    exec('tasklist /v /fo csv /nh', { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) {
        resolve([]);
        return;
      }
      const rows = parseTasklistCsv(stdout);
      resolve(rows);
    });
  });
}

function parseTasklistCsv(csv: string): TaskRow[] {
  const rows: TaskRow[] = [];
  for (const line of csv.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // Minimal CSV: tasklist double-quotes every field and comma-separates.
    const fields = parseCsvLine(line);
    if (fields.length < 9) continue;
    rows.push({
      imageName: fields[0],
      pid: fields[1],
      // fields: imageName, pid, sessionName, sessionNumber, memUsage, status, username, cpuTime, windowTitle
      windowTitle: fields[8] ?? '',
    });
  }
  return rows;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function detectFromTasks(rows: TaskRow[]): DetectedMeeting | null {
  for (const row of rows) {
    if (TEAMS_PROCESS_NAMES.has(row.imageName)) {
      return { platform: 'teams', detectedAt: Date.now(), evidence: `${row.imageName} (pid ${row.pid})` };
    }
  }
  for (const row of rows) {
    if (!row.windowTitle || row.windowTitle === 'N/A') continue;
    if (MEET_TITLE_HINTS.some((re) => re.test(row.windowTitle))) {
      return {
        platform: 'meet',
        detectedAt: Date.now(),
        evidence: `window title "${row.windowTitle}"`,
      };
    }
  }
  return null;
}

export class MeetingDetector extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private current: DetectedMeeting | null = null;
  private lastTriggerAt = 0;
  private readonly enabled: boolean;

  constructor() {
    super();
    this.enabled = process.platform === 'win32';
  }

  start(): void {
    if (!this.enabled) return;
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.current = null;
  }

  private async tick(): Promise<void> {
    const rows = await runTasklist();
    const detected = detectFromTasks(rows);

    if (!detected) {
      if (this.current) {
        this.emit('ended', this.current);
        this.current = null;
      }
      return;
    }

    if (!this.current) {
      this.current = detected;
      const now = Date.now();
      if (now - this.lastTriggerAt < RETRIGGER_COOLDOWN_MS) return;
      this.lastTriggerAt = now;
      this.emit('detected', detected);
    }
  }
}
