/**
 * Queue Manager Service
 * Manages concurrent task execution with bounded pools
 * - Main pool: 5 concurrent tasks (Whisper, FFmpeg, etc.)
 * - AI pool: 1 concurrent task (LLM analysis)
 */

import * as log from 'electron-log';
import { EventEmitter } from 'events';

export type TaskType = 'main' | 'ai';
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface QueueTask {
  id: string;
  type: TaskType;
  name: string;
  execute: () => Promise<any>;
  onProgress?: (percent: number, message: string) => void;
  status: TaskStatus;
  result?: any;
  error?: string;
  startTime?: number;
  endTime?: number;
  /**
   * Overrides the pool's watchdog limit for this task. Needed for work that is one
   * long task rather than one long request — the chapter pipeline makes hundreds of
   * short model calls back to back, so it legitimately outlives a limit sized for a
   * single stalled connection.
   */
  timeoutMs?: number;
}

interface ActiveTask {
  task: QueueTask;
  startTime: number;
}

export class QueueManagerService extends EventEmitter {
  private static instance: QueueManagerService;

  // Task pools
  private mainPool = new Map<string, ActiveTask>();
  private aiPool: ActiveTask | null = null;

  // Task queues
  private mainQueue: QueueTask[] = [];
  private aiQueue: QueueTask[] = [];

  // Concurrency limits
  private readonly MAX_MAIN_CONCURRENT = 5;
  private readonly MAX_AI_CONCURRENT = 1;

  // Watchdog settings
  private readonly WATCHDOG_INTERVAL_MS = 60000; // Check every 60 seconds
  // The watchdog force-fails tasks past these limits, so they must exceed the longest
  // LEGITIMATE run: transcribing a multi-hour livestream can take well over an hour
  // on slow hardware. AI requests self-timeout at the HTTP layer (<=10 min), so the
  // AI limit only backstops stalled-but-alive connections.
  private readonly MAIN_TASK_TIMEOUT_MS = 3 * 60 * 60 * 1000; // 3 hours
  private readonly AI_TASK_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

  private watchdogTimer: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private cancelledTasks = new Set<string>();
  // Tasks the watchdog force-failed on timeout. Lets executeTask's completion/failure
  // path skip double-emitting and double-freeing when the orphaned execute() settles.
  private timedOutTasks = new Set<string>();

  private constructor() {
    super();
    // queueTranscription/queueAITask each add 2 listeners per task on this singleton
    // emitter; with concurrent + queued tasks that can exceed the default cap of 10.
    this.setMaxListeners(100);
    this.startWatchdog();
  }

  static getInstance(): QueueManagerService {
    if (!QueueManagerService.instance) {
      QueueManagerService.instance = new QueueManagerService();
    }
    return QueueManagerService.instance;
  }

  /**
   * Add a task to the queue
   */
  enqueue(task: QueueTask): string {
    task.status = 'pending';

    if (task.type === 'ai') {
      this.aiQueue.push(task);
      log.info(`[QueueManager] Enqueued AI task: ${task.name} (queue: ${this.aiQueue.length})`);
    } else {
      this.mainQueue.push(task);
      log.info(`[QueueManager] Enqueued main task: ${task.name} (queue: ${this.mainQueue.length})`);
    }

    // Start processing if not already running
    this.processQueue();

    return task.id;
  }

  /**
   * Cancel a task by ID
   */
  cancel(taskId: string): boolean {
    // Check if task is in queue (not yet started)
    const mainIndex = this.mainQueue.findIndex(t => t.id === taskId);
    if (mainIndex !== -1) {
      this.mainQueue[mainIndex].status = 'cancelled';
      this.mainQueue.splice(mainIndex, 1);
      log.info(`[QueueManager] Cancelled queued main task: ${taskId}`);
      // Settle the awaiting queueTranscription/queueAITask promise so it doesn't hang.
      this.emit('taskFailed', { taskId, error: 'Task cancelled' });
      return true;
    }

    const aiIndex = this.aiQueue.findIndex(t => t.id === taskId);
    if (aiIndex !== -1) {
      this.aiQueue[aiIndex].status = 'cancelled';
      this.aiQueue.splice(aiIndex, 1);
      log.info(`[QueueManager] Cancelled queued AI task: ${taskId}`);
      // Settle the awaiting queueTranscription/queueAITask promise so it doesn't hang.
      this.emit('taskFailed', { taskId, error: 'Task cancelled' });
      return true;
    }

    // Mark as cancelled (for running tasks)
    this.cancelledTasks.add(taskId);
    log.info(`[QueueManager] Marked task for cancellation: ${taskId}`);
    return true;
  }

  /**
   * Check if a task is cancelled
   */
  isCancelled(taskId: string): boolean {
    return this.cancelledTasks.has(taskId);
  }

  /**
   * Get current queue status
   */
  getStatus(): {
    mainPoolSize: number;
    mainQueueSize: number;
    aiPoolSize: number;
    aiQueueSize: number;
    activeTasks: string[];
  } {
    return {
      mainPoolSize: this.mainPool.size,
      mainQueueSize: this.mainQueue.length,
      aiPoolSize: this.aiPool ? 1 : 0,
      aiQueueSize: this.aiQueue.length,
      activeTasks: [
        ...Array.from(this.mainPool.values()).map(t => t.task.name),
        ...(this.aiPool ? [this.aiPool.task.name] : [])
      ]
    };
  }

  /**
   * Process the queue - fills pools up to limits
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      while (true) {
        // Fill main pool (up to 5 concurrent)
        while (this.mainPool.size < this.MAX_MAIN_CONCURRENT && this.mainQueue.length > 0) {
          const task = this.mainQueue.shift()!;
          this.executeTask(task, 'main').catch(err => {
            log.error(`[QueueManager] Main task error: ${err}`);
          });
        }

        // Fill AI pool (up to 1 concurrent)
        if (!this.aiPool && this.aiQueue.length > 0) {
          const task = this.aiQueue.shift()!;
          this.executeTask(task, 'ai').catch(err => {
            log.error(`[QueueManager] AI task error: ${err}`);
          });
        }

        // Check if done
        if (this.mainQueue.length === 0 && this.aiQueue.length === 0 &&
            this.mainPool.size === 0 && !this.aiPool) {
          break;
        }

        // Small delay to prevent tight loop
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Execute a single task
   */
  private async executeTask(task: QueueTask, poolType: 'main' | 'ai'): Promise<void> {
    const now = Date.now();
    const activeTask: ActiveTask = {
      task,
      startTime: now
    };

    // Add to pool
    if (poolType === 'main') {
      this.mainPool.set(task.id, activeTask);
    } else {
      this.aiPool = activeTask;
    }

    task.status = 'running';
    task.startTime = now;

    log.info(`[QueueManager] Starting ${poolType} task: ${task.name} (${task.id})`);
    this.emit('taskStarted', { taskId: task.id, type: poolType, name: task.name });

    try {
      // Check if already cancelled
      if (this.cancelledTasks.has(task.id)) {
        throw new Error('Task cancelled');
      }

      // Execute the task
      const result = await task.execute();

      task.status = 'completed';
      task.result = result;
      task.endTime = Date.now();

      log.info(`[QueueManager] Completed ${poolType} task: ${task.name} (${task.endTime - task.startTime}ms)`);
      // If the watchdog already force-failed this task on timeout, don't double-emit.
      if (!this.timedOutTasks.has(task.id)) {
        this.emit('taskCompleted', { taskId: task.id, result });
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      task.status = this.cancelledTasks.has(task.id) ? 'cancelled' : 'failed';
      task.error = errorMessage;
      task.endTime = Date.now();

      log.error(`[QueueManager] Failed ${poolType} task: ${task.name} - ${errorMessage}`);
      // If the watchdog already force-failed this task on timeout, don't double-emit.
      if (!this.timedOutTasks.has(task.id)) {
        this.emit('taskFailed', { taskId: task.id, error: errorMessage });
      }

    } finally {
      // The watchdog frees the slot itself on timeout; only free it here if it didn't,
      // otherwise a late-settling orphan would clobber a slot a newer task now owns.
      const wasTimedOut = this.timedOutTasks.delete(task.id);
      if (!wasTimedOut) {
        // Remove from pool
        if (poolType === 'main') {
          this.mainPool.delete(task.id);
        } else {
          this.aiPool = null;
        }
      }

      // Clean up cancelled set
      this.cancelledTasks.delete(task.id);

      // Continue processing queue
      this.processQueue();
    }
  }

  /**
   * Watchdog timer to detect stuck tasks
   */
  private startWatchdog(): void {
    this.watchdogTimer = setInterval(() => {
      const now = Date.now();

      // Check main pool tasks
      for (const [taskId, activeTask] of this.mainPool) {
        const runtime = now - activeTask.startTime;
        const limit = activeTask.task.timeoutMs ?? this.MAIN_TASK_TIMEOUT_MS;

        if (runtime > limit) {
          const errorMessage = `Task timed out after ${Math.round(runtime / 1000)}s`;
          log.warn(`[QueueManager] Main task timeout: ${activeTask.task.name} (${taskId}) - ${Math.round(runtime / 1000)}s`);
          this.emit('taskTimeout', { taskId, type: 'main', runtime });
          this.failTimedOutTask(taskId, activeTask, 'main', errorMessage);
        }
      }

      // Check AI pool task
      if (this.aiPool) {
        const runtime = now - this.aiPool.startTime;
        const limit = this.aiPool.task.timeoutMs ?? this.AI_TASK_TIMEOUT_MS;

        if (runtime > limit) {
          const timedOut = this.aiPool;
          const errorMessage = `Task timed out after ${Math.round(runtime / 1000)}s`;
          log.warn(`[QueueManager] AI task timeout: ${timedOut.task.name} (${timedOut.task.id}) - ${Math.round(runtime / 1000)}s`);
          this.emit('taskTimeout', { taskId: timedOut.task.id, type: 'ai', runtime });
          this.failTimedOutTask(timedOut.task.id, timedOut, 'ai', errorMessage);
        }
      }

      // Log queue status periodically
      const status = this.getStatus();
      if (status.mainPoolSize > 0 || status.aiPoolSize > 0 || status.mainQueueSize > 0 || status.aiQueueSize > 0) {
        log.info(`[QueueManager] Status - Main: ${status.mainPoolSize}/${this.MAX_MAIN_CONCURRENT} running, ${status.mainQueueSize} queued | AI: ${status.aiPoolSize}/${this.MAX_AI_CONCURRENT} running, ${status.aiQueueSize} queued`);
      }
    }, this.WATCHDOG_INTERVAL_MS);
  }

  /**
   * Force-fail a task the watchdog found past its timeout: mark it failed, free its pool
   * slot, reject the awaiting promise via 'taskFailed', and keep processing the queue.
   * The task is recorded in timedOutTasks so that when the orphaned execute() promise
   * eventually settles, executeTask skips its own emit/pool-cleanup (avoids double-free).
   */
  private failTimedOutTask(taskId: string, activeTask: ActiveTask, poolType: 'main' | 'ai', errorMessage: string): void {
    this.timedOutTasks.add(taskId);
    activeTask.task.status = 'failed';
    activeTask.task.error = errorMessage;
    activeTask.task.endTime = Date.now();

    // Free the pool slot so the queue can advance
    if (poolType === 'main') {
      this.mainPool.delete(taskId);
    } else {
      this.aiPool = null;
    }

    this.emit('taskFailed', { taskId, error: errorMessage });
    this.processQueue();
  }

  /**
   * Stop the watchdog timer
   */
  stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  /**
   * Clear all queues and cancel running tasks
   */
  clearAll(): void {
    // Settle any queued (not-yet-started) tasks so their awaiting promises reject
    // instead of hanging forever with leaked listeners.
    for (const task of [...this.mainQueue, ...this.aiQueue]) {
      task.status = 'cancelled';
      this.emit('taskFailed', { taskId: task.id, error: 'Task cancelled' });
    }

    // Clear queues
    this.mainQueue = [];
    this.aiQueue = [];

    // Cancel running tasks
    for (const taskId of this.mainPool.keys()) {
      this.cancelledTasks.add(taskId);
    }
    if (this.aiPool) {
      this.cancelledTasks.add(this.aiPool.task.id);
    }

    log.info('[QueueManager] Cleared all queues and marked running tasks for cancellation');
  }
}

// Export singleton instance
export const queueManager = QueueManagerService.getInstance();

/**
 * Helper to create a main pool task (for Whisper, FFmpeg, etc.)
 */
export function createMainTask(
  id: string,
  name: string,
  execute: () => Promise<any>,
  onProgress?: (percent: number, message: string) => void
): QueueTask {
  return {
    id,
    type: 'main',
    name,
    execute,
    onProgress,
    status: 'pending'
  };
}

/**
 * Helper to create an AI pool task (for LLM analysis)
 */
export function createAITask(
  id: string,
  name: string,
  execute: () => Promise<any>,
  onProgress?: (percent: number, message: string) => void,
  timeoutMs?: number
): QueueTask {
  return {
    id,
    type: 'ai',
    name,
    execute,
    onProgress,
    status: 'pending',
    timeoutMs
  };
}

/**
 * Queue a transcription task and wait for completion
 */
export function queueTranscription<T>(
  id: string,
  name: string,
  execute: () => Promise<T>,
  onProgress?: (percent: number, message: string) => void
): Promise<T> {
  return new Promise((resolve, reject) => {
    const task = createMainTask(id, name, execute, onProgress);

    const onComplete = (event: { taskId: string; result: T }) => {
      if (event.taskId === id) {
        queueManager.off('taskCompleted', onComplete);
        queueManager.off('taskFailed', onFail);
        resolve(event.result);
      }
    };

    const onFail = (event: { taskId: string; error: string }) => {
      if (event.taskId === id) {
        queueManager.off('taskCompleted', onComplete);
        queueManager.off('taskFailed', onFail);
        reject(new Error(event.error));
      }
    };

    queueManager.on('taskCompleted', onComplete);
    queueManager.on('taskFailed', onFail);
    queueManager.enqueue(task);
  });
}

/**
 * Queue an AI task and wait for completion
 */
export function queueAITask<T>(
  id: string,
  name: string,
  execute: () => Promise<T>,
  onProgress?: (percent: number, message: string) => void,
  timeoutMs?: number
): Promise<T> {
  return new Promise((resolve, reject) => {
    const task = createAITask(id, name, execute, onProgress, timeoutMs);

    const onComplete = (event: { taskId: string; result: T }) => {
      if (event.taskId === id) {
        queueManager.off('taskCompleted', onComplete);
        queueManager.off('taskFailed', onFail);
        resolve(event.result);
      }
    };

    const onFail = (event: { taskId: string; error: string }) => {
      if (event.taskId === id) {
        queueManager.off('taskCompleted', onComplete);
        queueManager.off('taskFailed', onFail);
        reject(new Error(event.error));
      }
    };

    queueManager.on('taskCompleted', onComplete);
    queueManager.on('taskFailed', onFail);
    queueManager.enqueue(task);
  });
}
