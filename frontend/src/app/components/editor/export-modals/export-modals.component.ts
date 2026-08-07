import { Component, EventEmitter, Input, Output } from '@angular/core';

/**
 * The editor's two export dialogs: the chooser (pick what to export) and the result modal
 * (exported path + Show in Folder, or the verbatim Python error).
 *
 * Presentational only. It runs no export, owns no export state and never saves — the shell keeps
 * `exporting`, `exportResultPath`, `exportError`, `exportMicMuteBlocks`, `exportChooserOpen` and
 * `muteMicDuringScreen`, and decides what a choice or a dismissal does.
 *
 * `muteMic` is a banana-box because the same flag is written from the top bar. Note the
 * asymmetry the editor deliberately keeps: ticking the box HERE does not persist, while the
 * top-bar toggle calls scheduleEditsSave(). The shell's (muteMicChange) handler is therefore a
 * bare assignment — routing it through toggleMuteMicDuringScreen() would silently change that.
 */
@Component({
  selector: 'app-editor-export-modals',
  templateUrl: './export-modals.component.html',
  styleUrls: ['./export-modals.component.scss'],
  standalone: false
})
export class ExportModalsComponent {
  @Input() chooserOpen = false;

  @Input() resultPath: string | null = null;
  @Input() error: string | null = null;
  /** Mic blocks disabled under screen audio; null when the pass did not run. 0 is meaningful. */
  @Input() micMuteBlocks: number | null = null;

  @Input() cutCount = 0;
  @Input() storyCount = 0;
  @Input() hasStories = false;
  @Input() transcriptReady = false;
  @Input() canMuteMic = false;

  @Input() muteMic = true;
  @Output() muteMicChange = new EventEmitter<boolean>();

  @Output() chooserClosed = new EventEmitter<void>();
  @Output() choice = new EventEmitter<'fcpxml' | 'transcripts'>();
  @Output() showInFolder = new EventEmitter<void>();
  /** The result/error modal was dismissed (backdrop, Done or Close). */
  @Output() dismissed = new EventEmitter<void>();
}
