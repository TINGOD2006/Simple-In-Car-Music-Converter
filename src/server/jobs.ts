/**
 * In-process job registry for long-running batch runs.
 *
 * The HTTP API starts a batch and returns immediately with a job id; the UI
 * polls for progress. Jobs live only in memory: a batch is a foreground user
 * action, and a restart legitimately loses it (the manifest on disk is the
 * durable record).
 */

import { randomUUID } from 'node:crypto';

export type JobState = 'queued' | 'running' | 'done' | 'failed';

export interface JobProgress {
  stage: string;
  done: number;
  total: number;
  path?: string;
}

export interface Job<Report = unknown> {
  id: string;
  state: JobState;
  progress: JobProgress;
  report: Report | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

const jobs = new Map<string, Job>();

/** How many finished jobs to keep for polling before evicting the oldest. */
const KEEP_FINISHED = 20;

function evict(): void {
  const finished = [...jobs.values()]
    .filter((j) => j.state === 'done' || j.state === 'failed')
    .sort((a, b) => (a.finishedAt ?? '').localeCompare(b.finishedAt ?? ''));
  while (finished.length > KEEP_FINISHED) {
    const victim = finished.shift();
    if (victim) jobs.delete(victim.id);
  }
}

/**
 * Create a job and run `work` in the background.
 *
 * `work` receives a progress reporter; its resolved value becomes the job
 * report. A rejection marks the job failed — it never escapes as an unhandled
 * rejection.
 */
export function startJob<Report>(
  work: (report: (p: JobProgress) => void) => Promise<Report>,
): Job<Report> {
  const job: Job<Report> = {
    id: randomUUID(),
    state: 'queued',
    progress: { stage: 'queued', done: 0, total: 0 },
    report: null,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  jobs.set(job.id, job as Job);

  const report = (p: JobProgress): void => {
    job.state = 'running';
    job.progress = p;
  };

  void (async () => {
    try {
      job.state = 'running';
      job.report = await work(report);
      job.state = 'done';
    } catch (err) {
      job.state = 'failed';
      job.error = (err as Error).message;
    } finally {
      job.finishedAt = new Date().toISOString();
      evict();
    }
  })();

  return job;
}

export function getJob(id: string): Job | null {
  return (jobs.get(id) as Job | undefined) ?? null;
}

export function listJobs(): Job[] {
  return [...jobs.values()];
}
