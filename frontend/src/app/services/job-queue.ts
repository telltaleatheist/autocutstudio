import { Injectable, signal, effect } from '@angular/core';
import { InputItem } from './inputs-state';

export type ItemStatus = 'pending' | 'transcribing' | 'transcribed' | 'generating' | 'completed' | 'failed';

export interface ItemProgress {
  status: ItemStatus;
  progress: number;
}

export interface QueuedJob {
  id: string;
  name: string;
  inputs: InputItem[];
  promptSet: string; // ID of the prompt set to use
  mode: 'individual' | 'compilation';
  // 'held' = transcribed and the prompt is assembled, waiting for the user to send
  // it to the AI (the "Transcribe only" two-stage flow). The main process holds the
  // transcript so sending reuses it without re-transcribing.
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'held';
  createdAt: Date;
  completedAt?: Date;
  progress: number;
  currentlyProcessing: string;
  error?: string;
  outputFiles?: string[];
  processingTime?: number;
  heldPrompt?: string; // Assembled prompt captured when the job reaches 'held' (view-only)
  // Titling jobs only (one 'subject' item, individual mode): the candidate titles the local
  // headline model produced. Filled in as they stream, so the row shows them one by one.
  titles?: string[];
  itemProgress: ItemProgress[];
  currentItemIndex: number;
}

// See the note on the inputs-state key: distinct from ContentStudio's 'contentstudio-jobs'.
const STORAGE_KEY = 'autocutstudio-metadata-jobs';

@Injectable({
  providedIn: 'root'
})
export class JobQueueService {
  jobs = signal<QueuedJob[]>([]);
  isProcessing = signal(false);

  constructor() {
    this.loadFromStorage();

    effect(() => {
      const jobs = this.jobs();
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(jobs));
    });
  }

  private loadFromStorage() {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY);
      if (stored) {
        const jobs = JSON.parse(stored) as QueuedJob[];
        const restoredJobs = jobs.map(job => ({
          ...job,
          createdAt: new Date(job.createdAt),
          completedAt: job.completedAt ? new Date(job.completedAt) : undefined,
          // Reset interrupted 'processing' jobs to pending. Also reset 'held' jobs:
          // their transcript lived only in the (now-restarted) main process, so the
          // prompt can't be sent anymore — they must be re-transcribed.
          status: (job.status === 'processing' || job.status === 'held') ? 'pending' as const : job.status,
          currentlyProcessing: (job.status === 'processing' || job.status === 'held') ? '' : job.currentlyProcessing,
          heldPrompt: job.status === 'held' ? undefined : job.heldPrompt
        }));
        this.jobs.set(restoredJobs);
      }
    } catch (error) {
      console.error('Failed to load jobs from storage:', error);
    }
  }

  addJob(name: string, inputs: InputItem[], promptSet: string, mode: 'individual' | 'compilation'): string {
    const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    const newJob: QueuedJob = {
      id: jobId,
      name,
      inputs: [...inputs],
      promptSet,
      mode,
      status: 'pending',
      createdAt: new Date(),
      progress: 0,
      currentlyProcessing: '',
      itemProgress: inputs.map(() => ({ status: 'pending', progress: 0 })),
      currentItemIndex: -1
    };

    this.jobs.update(jobs => [...jobs, newJob]);
    return jobId;
  }

  removeJob(jobId: string) {
    this.jobs.update(jobs => jobs.filter(job => job.id !== jobId));
  }

  clearCompletedJobs() {
    this.jobs.update(jobs => jobs.filter(job =>
      job.status !== 'completed' && job.status !== 'failed'
    ));

    if (this.jobs().length === 0 || !this.hasProcessingJob()) {
      this.isProcessing.set(false);
    }
  }

  updateJob(jobId: string, updates: Partial<QueuedJob>) {
    this.jobs.update(jobs =>
      jobs.map(job => job.id === jobId ? { ...job, ...updates } : job)
    );
  }

  getJob(jobId: string): QueuedJob | undefined {
    return this.jobs().find(job => job.id === jobId);
  }

  getPendingJobs(): QueuedJob[] {
    return this.jobs().filter(job => job.status === 'pending');
  }

  getNextPendingJob(): QueuedJob | undefined {
    return this.jobs().find(job => job.status === 'pending');
  }

  getHeldJobs(): QueuedJob[] {
    return this.jobs().filter(job => job.status === 'held');
  }

  getNextHeldJob(): QueuedJob | undefined {
    return this.jobs().find(job => job.status === 'held');
  }

  hasProcessingJob(): boolean {
    return this.jobs().some(job => job.status === 'processing');
  }

  updateItemProgress(jobId: string, itemIndex: number, progress: number, status: ItemStatus) {
    this.jobs.update(jobs =>
      jobs.map(job => {
        if (job.id === jobId && job.itemProgress[itemIndex]) {
          const newItemProgress = [...job.itemProgress];
          newItemProgress[itemIndex] = { status, progress };
          const isActiveStatus = status === 'transcribing' || status === 'generating';
          return {
            ...job,
            itemProgress: newItemProgress,
            currentItemIndex: isActiveStatus ? itemIndex : job.currentItemIndex
          };
        }
        return job;
      })
    );
  }
}
