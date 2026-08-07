import { Component, ElementRef, EventEmitter, Input, Output, ViewChild } from '@angular/core';
import { TranscriptGroupView, TranscriptState } from '../model/editor-types';
import { EPS } from '../model/editor-math';
import { prettyLabel } from '../model/editor-format';

/**
 * The editor's transcript pane body — the four lifecycle states (Transcribe button, running
 * progress, verbatim error, read-only preview). The `.pane-tabs` row and the `.transcript-pane`
 * wrapper stay in the editor: they switch between Edit and Stories, which is not this pane's
 * business.
 *
 * Deliberately dumb. It owns NO transcript data: the words, the groups, the visible projection,
 * the source filter and the search query all live in the editor, because `recomputeVisibleGroups()`
 * runs from `rebuildEditedModel()` on every cut/undo/reorder and `transcriptState` gates the
 * export chooser, the mic-mute pass and the analyzer. Child-owned copies would go stale behind
 * this component's *ngIf.
 *
 * The karaoke scroll is IMPERATIVE on purpose: `scrollGroupIntoView` is called synchronously by
 * the editor from its rAF tick, so the list moves in the same frame the highlight does. Routing
 * it through an Input would defer the scroll by a change-detection pass and change the feel.
 */
@Component({
  selector: 'app-transcript-pane',
  templateUrl: './transcript-pane.component.html',
  styleUrls: ['./transcript-pane.component.scss'],
  standalone: false
})
export class TranscriptPaneComponent {
  @Input() state: TranscriptState = 'none';
  @Input() error = '';
  @Input() progress = 0;
  @Input() message = '';
  /**
   * The already-formatted "about N min left" string. Computed by the editor rather than here
   * because the activity dock renders the same label — one getter, two consumers, no duplicate
   * formatting rules.
   */
  @Input() etaLabel = '';

  @Input() tracks: { id: string; label: string }[] = [];
  @Input() sourceFilter = 'merged';
  @Input() searchQuery = '';

  @Input() groups: TranscriptGroupView[] = [];
  @Input() activeGroupIdx = -1;
  @Input() selectedGroupStart: number | null = null;
  @Input() selectedGroupEnd: number | null = null;

  @Output() transcribeRequested = new EventEmitter<void>();
  @Output() cancelRequested = new EventEmitter<void>();
  @Output() sourceFilterChanged = new EventEmitter<string>();
  @Output() searchChanged = new EventEmitter<string>();
  @Output() searchCleared = new EventEmitter<void>();
  @Output() groupSelected = new EventEmitter<TranscriptGroupView>();

  @ViewChild('txGroupsEl') txGroupsRef?: ElementRef<HTMLElement>;

  /** Friendly DISPLAY name for a track/speaker id — template-callable delegate (see
   *  model/editor-format.ts for the rules). */
  prettyLabel(raw: string): string {
    return prettyLabel(raw);
  }

  /** True when this group is exactly the timeline's current group selection. */
  isGroupSelected(g: TranscriptGroupView): boolean {
    return this.selectedGroupStart !== null
      && Math.abs(this.selectedGroupStart - g.originalStart) <= EPS
      && this.selectedGroupEnd !== null
      && Math.abs(this.selectedGroupEnd - g.originalEnd) <= EPS;
  }

  /** How many lines the current search matches (the visible list IS the result set). */
  get searchResultCount(): number {
    return this.groups.length;
  }

  /** Scroll the transcript list so line `idx` sits ~a third from the top (only its container). */
  scrollGroupIntoView(idx: number): void {
    const cont = this.txGroupsRef?.nativeElement;
    if (!cont) return;
    const child = cont.children[idx] as HTMLElement | undefined;
    if (!child) return;
    const top = child.offsetTop;
    const bottom = top + child.offsetHeight;
    if (top < cont.scrollTop || bottom > cont.scrollTop + cont.clientHeight) {
      cont.scrollTop = Math.max(0, top - cont.clientHeight * 0.35);
    }
  }
}
