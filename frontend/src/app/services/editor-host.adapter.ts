// src/app/services/editor-host.adapter.ts
//
// AutoCutStudio's implementation of the editor's port (components/editor/editor-host.ts).
// This is the ONLY place the editor and this application's service layer meet.
//
// Thin pass-throughs only. Anything with logic in it belongs on one side or the other, not
// here: a fat adapter is behaviour the next host would have to reimplement from scratch,
// which is exactly what the port exists to prevent.
//
// This file stays OUTSIDE components/editor/ — it is host code, and it does not travel.

import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';

import { EditorManifest } from '../models/editor-manifest';
import { ElectronService } from './electron.service';
import { ProcessingService } from './processing.service';
import {
  EditorHost, ProcessingJob, ProjectScanResult, ProjectsRegistry, TitleHandoff
} from '../components/editor/editor-host';

@Injectable()
export class EditorHostAdapter implements EditorHost {
  constructor(
    private electron: ElectronService,
    private processing: ProcessingService
  ) {}

  // ── Environment ─────────────────────────────────────────────────────────────

  isElectron(): boolean {
    return this.electron.isElectron();
  }

  // ── Session payload & manifest ──────────────────────────────────────────────

  getEditorPayload(): Promise<{ zipPath: string } | null> {
    return this.electron.getEditorPayload();
  }

  onEditorPayload(callback: (payload: { zipPath: string }) => void): void {
    this.electron.onEditorPayload(callback);
  }

  removeEditorListeners(): void {
    this.electron.removeEditorListeners();
  }

  getEditorManifest(zipPath: string): Promise<EditorManifest> {
    return this.electron.getEditorManifest(zipPath);
  }

  // ── Edit state ──────────────────────────────────────────────────────────────

  loadEditorEdits(payload: { zipPath: string }): Promise<any | null> {
    return this.electron.loadEditorEdits(payload);
  }

  saveEditorEdits(payload: { zipPath: string; edits: any }): Promise<{ path: string }> {
    return this.electron.saveEditorEdits(payload);
  }

  // ── Export ──────────────────────────────────────────────────────────────────

  exportEditorCuts(payload: Parameters<ElectronService['exportEditorCuts']>[0]): Promise<any> {
    return this.electron.exportEditorCuts(payload);
  }

  // ── Transcription ───────────────────────────────────────────────────────────

  transcribeSession(payload: { zipPath: string }): Promise<{ jobId: string }> {
    return this.electron.transcribeSession(payload);
  }

  cancelTranscription(payload: { jobId: string }): Promise<any> {
    return this.electron.cancelTranscription(payload);
  }

  onTranscribeProgress(callback: (data: { jobId: string; progress: number; message: string }) => void): void {
    this.electron.onTranscribeProgress(callback);
  }

  onTranscribeComplete(
    callback: (data: { jobId: string; exitCode: number; result: any; errorMessage?: string }) => void
  ): void {
    this.electron.onTranscribeComplete(callback);
  }

  removeTranscribeListeners(): void {
    this.electron.removeTranscribeListeners();
  }

  loadTranscript(payload: { zipPath: string }): Promise<any> {
    return this.electron.loadTranscript(payload);
  }

  // ── Story analysis ──────────────────────────────────────────────────────────

  ollamaListModels(host?: string): Promise<{ connected: boolean; models: Array<{ id: string; name: string }> }> {
    return this.electron.ollamaListModels(host);
  }

  analyzeStoryChapters(payload: Parameters<ElectronService['analyzeStoryChapters']>[0]) {
    return this.electron.analyzeStoryChapters(payload);
  }

  suggestStoryTitle(payload: { text: string | string[]; model: string; host?: string }): Promise<{ title: string }> {
    return this.electron.suggestStoryTitle(payload);
  }

  cancelStoryAnalysis(): Promise<{ stopped: boolean }> {
    return this.electron.cancelStoryAnalysis();
  }

  unloadStoryModel(payload: { model: string; host?: string }): Promise<{ ok: boolean }> {
    return this.electron.unloadStoryModel(payload);
  }

  onStoryAnalyzeProgress(callback: (p: { phase: string; done: number; total: number }) => void): void {
    this.electron.onStoryAnalyzeProgress(callback);
  }

  removeStoryAnalyzeProgressListener(): void {
    this.electron.removeStoryAnalyzeProgressListener();
  }

  // ── Media ───────────────────────────────────────────────────────────────────

  alignmentExtractPeaks(opts: { filePath: string; startSec: number; durationSec: number; buckets: number }) {
    return this.electron.alignmentExtractPeaks(opts);
  }

  // ── Files & dialogs ─────────────────────────────────────────────────────────

  selectFile(options?: { title?: string; filters?: any[]; properties?: any[] }):
    Promise<{ canceled: boolean; filePaths: string[] }> {
    return this.electron.selectFile(options);
  }

  selectDirectory(options?: { title?: string }): Promise<{ canceled: boolean; filePaths: string[] }> {
    return this.electron.selectDirectory(options);
  }

  readDirectory(dirPath: string): Promise<{ success: boolean; directories?: any[]; files?: any[] }> {
    return this.electron.readDirectory(dirPath);
  }

  checkFileExists(filePath: string): Promise<{ exists: boolean }> {
    return this.electron.checkFileExists(filePath);
  }

  showInFolder(filePath: string): Promise<any> {
    return this.electron.showInFolder(filePath);
  }

  getPathForFile(file: File): string {
    return this.electron.getPathForFile(file);
  }

  // ── Projects registry ───────────────────────────────────────────────────────

  readProjectsRegistry(): Promise<ProjectsRegistry> {
    return this.electron.readProjectsRegistry();
  }

  writeProjectsRegistry(registry: ProjectsRegistry): Promise<{ success: boolean }> {
    return this.electron.writeProjectsRegistry(registry);
  }

  scanProjectFolder(folderPath: string): Promise<ProjectScanResult> {
    return this.electron.scanProjectFolder(folderPath);
  }

  // ── Processing ──────────────────────────────────────────────────────────────

  autoDetectAudio(masterVideoPath: string): Promise<{
    success: boolean;
    audioFiles?: { [key: string]: string };
    videoFiles?: { [key: string]: string };
    error?: string;
  }> {
    return this.electron.autoDetectAudio(masterVideoPath);
  }

  listAssets(): Promise<{ success: boolean; components?: any[]; error?: string }> {
    return this.electron.listAssets();
  }

  startWorkflow(options: any): Promise<void> {
    return this.processing.startWorkflow(options);
  }

  getCurrentJob(): Observable<ProcessingJob | null> {
    return this.processing.getCurrentJob();
  }

  cancelJob(): Promise<void> {
    return this.processing.cancelJob();
  }

  sendSkipSignal(): Promise<void> {
    return this.electron.sendSkipSignal();
  }

  // ── Host handoffs ───────────────────────────────────────────────────────────

  // AutoCutStudio HAS the Metadata tab, so the optional member is implemented here.
  sendSubjectsToTitles(payload: { handoffs: TitleHandoff[] }): Promise<{ success: boolean }> {
    return this.electron.sendSubjectsToTitles(payload);
  }
}
