/**
 * Metadata Field Registry
 *
 * Single source of truth for the AI-returned metadata fields. This registry
 * drives both the response normalizer (ai-manager.service.ts) and the
 * human-readable .txt writer (output-handler.service.ts), so adding a future
 * field is a single entry here.
 *
 * NOTE: `chapters` is intentionally NOT in this registry. It is a typed object
 * array handled specially by both consumers (in the .txt it is injected right
 * after `thumbnail_text`).
 *
 * The ORDER of METADATA_FIELDS drives the .txt layout and matches the current
 * output so existing files don't churn.
 */

export interface MetadataFieldDef {
  /** Canonical key in MetadataResult */
  key: string;
  /** Alternate keys models might return */
  aliases: string[];
  /** How the raw value is normalized */
  kind: 'string' | 'stringArray' | 'tags' | 'hashtags';
  /** Section header in the readable .txt */
  txtLabel: string;
  /** numbered list / raw block / comma-joined line */
  txtStyle: 'numbered' | 'block' | 'inline';
  /**
   * When true, a stringArray field that comes out empty becomes `undefined`
   * instead of `[]`. Only applies to 'stringArray' kind.
   */
  emptyToUndefined?: boolean;
}

export const METADATA_FIELDS: MetadataFieldDef[] = [
  {
    key: 'titles',
    aliases: ['titleOptions', 'title_options', 'titleSuggestions'],
    kind: 'stringArray',
    txtLabel: 'TITLES',
    txtStyle: 'numbered',
  },
  {
    key: 'description',
    aliases: [
      'episode_description',
      'episodeDescription',
      'show_description',
      'showDescription',
      'podcast_description',
      'podcastDescription',
    ],
    kind: 'string',
    txtLabel: 'DESCRIPTION',
    txtStyle: 'block',
  },
  {
    key: 'tags',
    aliases: [],
    kind: 'tags',
    txtLabel: 'TAGS',
    txtStyle: 'inline',
  },
  {
    key: 'thumbnail_text',
    aliases: ['thumbnailText', 'thumbnailTextOptions', 'thumbnail_text_options', 'thumbnailOptions'],
    kind: 'stringArray',
    txtLabel: 'THUMBNAIL TEXT OPTIONS',
    txtStyle: 'numbered',
  },
  // chapters injected here (between thumbnail_text and hashtags) — handled specially
  {
    key: 'hashtags',
    aliases: [],
    kind: 'hashtags',
    txtLabel: 'HASHTAGS',
    txtStyle: 'block',
  },
  {
    key: 'pinned_comment',
    aliases: ['pinnedComment', 'pinned_comments'],
    kind: 'stringArray',
    txtLabel: 'PINNED COMMENT OPTIONS',
    txtStyle: 'numbered',
    emptyToUndefined: true,
  },
  {
    key: 'spoken_keywords',
    aliases: ['spokenKeywords'],
    kind: 'stringArray',
    txtLabel: 'SPOKEN KEYWORDS (say these aloud in the clip)',
    txtStyle: 'inline',
    emptyToUndefined: true,
  },
  {
    key: 'clip_suggestions',
    aliases: ['clipSuggestions', 'clips'],
    kind: 'stringArray',
    txtLabel: 'CLIP SUGGESTIONS (Shorts-able moments)',
    txtStyle: 'numbered',
    emptyToUndefined: true,
  },
];
