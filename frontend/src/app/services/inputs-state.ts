import { Injectable, signal, effect } from '@angular/core';

/**
 * The Metadata page's item list, held outside the component so leaving the tab and
 * coming back does not throw away a list the user spent real time assembling.
 *
 * Ported from ContentStudio's inputs-state service. The field names are part of the
 * `generate-metadata` payload contract (the main process reads `path`, `notes` and the
 * item type), so they are kept verbatim even where a different name would read better.
 */
export interface InputItem {
  /** 'subject' | 'video' | 'transcript' | 'transcript-import' | 'directory' | 'file' */
  type: string;
  /** Filesystem path — EXCEPT for text subjects, where the typed text itself is the path.
   *  That doubles as the dedup key, which is why adding the same text twice is a no-op. */
  path: string;
  displayName: string;
  /** A single emoji. AutoCutStudio has no icon font, so the row glyph is the string itself. */
  icon: string;
  selected: boolean;
  /** ID of the prompt set this item is generated with (e.g. "youtube-telltale"). */
  promptSet: string;
  /** Free-text steer for the AI on this one item ("focus on the deposition"). */
  notes?: string;
  /** Video/transcript items only: generate YouTube chapter markers (default on). */
  generateChapters?: boolean;
  /** Text subjects only: the actual text. Kept in sync with `path` for the dedup key. */
  textContent?: string;
  /** Which trained title prompt a queued titling run uses for this item. Carried over from the
   *  editor handoff so a livestream send keeps its format; absent means 'normal'. */
  titleFormat?: 'normal' | 'livestream';
  /** The story's chapter list, timestamped against the story's OWN exported video. Carried over
   *  from the editor handoff and written into the saved title report; NEVER model input — the
   *  titling model only ever sees `textContent`. Absent on hand-typed subjects. */
  chapters?: { timestamp: string; title: string }[];
}

export interface GenerationState {
  isGenerating: boolean;
  generationStartTime: number;
  elapsedTime: string;
  generationProgress: number;
  currentlyProcessing: string;
}

// Renamed from ContentStudio's 'contentstudio-inputs': this is a DIFFERENT app writing to
// the same origin-less file:// storage. Sharing the key would let one app's list surface
// in the other's.
const STORAGE_KEY = 'autocutstudio-metadata-inputs';

@Injectable({
  providedIn: 'root'
})
export class InputsStateService {
  inputItems = signal<InputItem[]>([]);

  // Master controls
  compilationMode = signal(false); // If true, all items are generated as ONE compilation job
  // Must name a prompt set that actually ships in electron/services/metadata/assets/. The ported
  // default ('sample-youtube') was ContentStudio's sample and does NOT exist here — generation
  // fails outright with a set that isn't installed. The page reconciles this against
  // list-prompt-sets on load, so this is only the value used before that returns.
  masterPromptSet = signal('youtube-telltale');

  generationState = signal<GenerationState>({
    isGenerating: false,
    generationStartTime: 0,
    elapsedTime: '0s',
    generationProgress: 0,
    currentlyProcessing: ''
  });

  private settingsLoaded = false;

  constructor() {
    this.loadFromStorage();

    // sessionStorage, not localStorage: a list of dropped video paths is worthless after the
    // machine has been rebooted and the volumes are gone.
    effect(() => {
      const state = {
        inputItems: this.inputItems(),
        compilationMode: this.compilationMode(),
        masterPromptSet: this.masterPromptSet()
      };
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    });
  }

  private loadFromStorage() {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEY);
      if (stored) {
        const state = JSON.parse(stored);
        if (state.inputItems) this.inputItems.set(state.inputItems);
        if (state.compilationMode !== undefined) this.compilationMode.set(state.compilationMode);
        if (state.masterPromptSet) this.masterPromptSet.set(state.masterPromptSet);
      }
    } catch (error) {
      console.error('Failed to load inputs state from storage:', error);
    }
  }

  addItem(item: InputItem) {
    // Dedup by path. For text subjects the path IS the content, so adding the same text
    // twice is a no-op — which also keeps the template's track-by-path keys unique.
    this.inputItems.update(items =>
      items.some(existing => existing.path === item.path) ? items : [...items, item]
    );
  }

  removeItem(index: number) {
    this.inputItems.update(items => items.filter((_, i) => i !== index));
  }

  clearItems() {
    this.inputItems.set([]);
  }

  reorderItems(previousIndex: number, currentIndex: number) {
    this.inputItems.update(items => {
      const result = [...items];
      const [removed] = result.splice(previousIndex, 1);
      result.splice(currentIndex, 0, removed);
      return result;
    });
  }

  updateGenerationState(state: Partial<GenerationState>) {
    this.generationState.update(current => ({ ...current, ...state }));
  }

  hasLoadedSettings(): boolean {
    return this.settingsLoaded;
  }

  markSettingsLoaded() {
    this.settingsLoaded = true;
  }
}
