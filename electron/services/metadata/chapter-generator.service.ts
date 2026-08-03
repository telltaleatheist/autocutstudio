/**
 * Chapter Generator Service — shared transcript/timestamp utilities
 *
 * Chapters themselves are no longer built here. The single "read the whole video and
 * return its chapters" call this file used to serve was replaced by the staged local
 * pipeline in chapter-pipeline.service.ts (see CHAPTERING.md), which does its own
 * word-stream quote mapping against the full caption stream.
 *
 * What remains is what the EPISODE SPLITTER still needs — SRT time conversion, budget
 * sampling, sparse-timestamp transcripts and the phrase matcher — plus the `Chapter`
 * shape both paths emit.
 */

import { SRTSegment } from './whisper.service';

export interface Chapter {
  timestamp: string;
  title: string;
  sequence: number;
  endTimestamp?: string;
}

/**
 * Utility class for SRT time conversions
 */
export class TimeUtils {
  /**
   * Convert SRT time format (hh:mm:ss,ms) to seconds
   */
  static srtTimeToSeconds(srtTime: string): number {
    const [timePart, msPart] = srtTime.split(',');
    const [hours, minutes, seconds] = timePart.split(':').map(Number);
    const milliseconds = Number(msPart) || 0;
    return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000.0;
  }

  /**
   * Convert seconds to YouTube chapter format (M:SS or H:MM:SS)
   */
  static secondsToYoutubeTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    } else {
      return `${minutes}:${secs.toString().padStart(2, '0')}`;
    }
  }

  /**
   * Convert YouTube time format to seconds
   */
  static youtubeTimeToSeconds(timeStr: string): number {
    const parts = timeStr.split(':').map(Number);

    if (parts.length === 3) {
      const [hours, minutes, seconds] = parts;
      return hours * 3600 + minutes * 60 + seconds;
    } else if (parts.length === 2) {
      const [minutes, seconds] = parts;
      return minutes * 60 + seconds;
    } else {
      return parts[0];
    }
  }
}

/**
 * Build plain text transcript without timestamps
 * Saves tokens - timestamps are recovered via phrase matching
 */
export function buildPlainTranscript(srtSegments: SRTSegment[]): string {
  const lines: string[] = [];

  for (const segment of srtSegments) {
    const text = segment.text.trim();
    if (text.length > 0) {
      lines.push(text);
    }
  }

  return lines.join(' ').trim();
}

/**
 * Build transcript with sparse timestamps (every N minutes)
 * Balances token savings with temporal context for AI
 */
export function buildSparseTimestampTranscript(
  srtSegments: SRTSegment[],
  intervalMinutes: number = 15
): string {
  const lines: string[] = [];
  let lastMarkerMinute = -intervalMinutes; // Ensure first marker at 0

  for (const segment of srtSegments) {
    const seconds = TimeUtils.srtTimeToSeconds(segment.start);
    const minute = Math.floor(seconds / 60);

    // Add marker every N minutes
    if (minute >= lastMarkerMinute + intervalMinutes) {
      lastMarkerMinute = Math.floor(minute / intervalMinutes) * intervalMinutes;
      const timeStr = TimeUtils.secondsToYoutubeTime(lastMarkerMinute * 60);
      lines.push(`\n[${timeStr}]`);
    }

    const text = segment.text.trim();
    if (text.length > 0) {
      lines.push(text);
    }
  }

  return lines.join(' ').trim();
}

/**
 * Build full transcript with timestamp for every segment
 * Format: [0:00] text [0:05] text [0:10] text...
 */
export function buildFullTimestampTranscript(srtSegments: SRTSegment[]): string {
  const lines: string[] = [];

  for (const segment of srtSegments) {
    const seconds = TimeUtils.srtTimeToSeconds(segment.start);
    const timeStr = TimeUtils.secondsToYoutubeTime(seconds);
    const text = segment.text.trim();

    if (text.length > 0) {
      lines.push(`[${timeStr}] ${text}`);
    }
  }

  return lines.join('\n');
}

/**
 * Evenly sample segments so the built transcript fits a character budget.
 * Keeps whole segments verbatim (never truncates text), so any phrase the AI
 * quotes from the sampled transcript still exists in the full SRT and maps to
 * a timestamp. Sampling stride grows until the total fits the budget.
 */
export function sampleSegmentsToBudget(srtSegments: SRTSegment[], budgetChars: number): SRTSegment[] {
  const totalChars = srtSegments.reduce((n, s) => n + (s.text?.length || 0), 0);
  if (totalChars <= budgetChars) {
    return srtSegments;
  }

  let stride = Math.ceil(totalChars / budgetChars);
  let sampled = srtSegments.filter((_, i) => i % stride === 0);

  // Uneven segment lengths can leave us over budget — widen the stride until we fit
  while (
    sampled.reduce((n, s) => n + (s.text?.length || 0), 0) > budgetChars &&
    stride < srtSegments.length
  ) {
    stride++;
    sampled = srtSegments.filter((_, i) => i % stride === 0);
  }

  return sampled;
}

/**
 * Normalize text for comparison: lowercase, remove punctuation, normalize whitespace
 */
function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '')  // Remove punctuation
    .replace(/\s+/g, ' ')      // Normalize whitespace
    .trim();
}

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(str1: string, str2: string): number {
  const m = str1.length;
  const n = str2.length;

  // Create DP matrix
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  // Initialize base cases
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  // Fill the matrix
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(
          dp[i - 1][j],     // deletion
          dp[i][j - 1],     // insertion
          dp[i - 1][j - 1]  // substitution
        );
      }
    }
  }

  return dp[m][n];
}

/**
 * Calculate string similarity (0-1 scale)
 */
function stringSimilarity(str1: string, str2: string): number {
  if (str1.length === 0 && str2.length === 0) return 1;
  if (str1.length === 0 || str2.length === 0) return 0;

  const distance = levenshteinDistance(str1, str2);
  const maxLength = Math.max(str1.length, str2.length);
  return 1 - (distance / maxLength);
}

// Common words to filter out when doing distinctive word matching
const COMMON_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'need',
  'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them', 'their',
  'we', 'us', 'our', 'you', 'your', 'he', 'him', 'his', 'she', 'her',
  'i', 'me', 'my', 'so', 'if', 'then', 'than', 'as', 'just', 'also',
  'like', 'well', 'now', 'here', 'there', 'when', 'where', 'what', 'who',
  'how', 'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other',
  'some', 'such', 'no', 'not', 'only', 'own', 'same', 'very', 'just',
  'about', 'into', 'over', 'after', 'before', 'between', 'under', 'again',
  'going', 'know', 'think', 'right', 'really', 'actually', 'gonna', 'yeah'
]);

/**
 * Find the timestamp for a phrase in the transcript
 * Uses 5-strategy matching (like ClipChimp):
 * 1. Direct substring match
 * 2. Shorter prefix match
 * 3. Fuzzy matching with Levenshtein
 * 4. Distinctive word matching
 * 5. Cross-segment matching
 *
 * NOTE: `threshold` is currently unused — fuzzy matching uses a fixed internal
 * threshold (see FUZZY_THRESHOLD below). It is retained only for call-site
 * compatibility (callers pass it positionally before `minTimestamp`).
 * `minTimestamp` is a lower bound in seconds: segments before it are ignored,
 * which callers use to enforce chronological order across successive lookups.
 */
export function findPhraseTimestamp(
  phrase: string,
  srtSegments: SRTSegment[],
  threshold: number = 0.5,
  minTimestamp: number = 0
): number | null {
  if (!phrase || !srtSegments || srtSegments.length === 0) {
    return null;
  }

  const normalizedPhrase = normalizeForComparison(phrase);
  if (normalizedPhrase.length === 0) {
    return null;
  }

  // Build segment index for matching
  interface SegmentEntry {
    text: string;
    normalizedText: string;
    timestamp: number;
  }
  const segments: SegmentEntry[] = [];

  for (const segment of srtSegments) {
    const timestampSeconds = TimeUtils.srtTimeToSeconds(segment.start);
    if (timestampSeconds < minTimestamp) continue;

    const text = (segment.text || '').trim();
    if (text.length > 0) {
      segments.push({
        text,
        normalizedText: normalizeForComparison(text),
        timestamp: timestampSeconds
      });
    }
  }

  if (segments.length === 0) return null;

  // Use first ~50 chars for matching
  const searchPhrase = normalizedPhrase.substring(0, 50);

  // STRATEGY 1: Direct substring match
  for (const seg of segments) {
    if (seg.normalizedText.includes(searchPhrase)) {
      return seg.timestamp;
    }
  }

  // STRATEGY 2: Shorter prefix match (first 25 chars)
  if (searchPhrase.length > 25) {
    const shortPhrase = normalizedPhrase.substring(0, 25);
    for (const seg of segments) {
      if (seg.normalizedText.includes(shortPhrase)) {
        return seg.timestamp;
      }
    }
  }

  // STRATEGY 3: Fuzzy matching with Levenshtein (65% threshold)
  const FUZZY_THRESHOLD = 0.65;
  let bestFuzzyMatch: { segment: SegmentEntry; score: number } | null = null;

  for (const seg of segments) {
    // Compare against a window of similar length
    const compareText = seg.normalizedText.substring(0, searchPhrase.length + 10);
    const similarity = stringSimilarity(searchPhrase, compareText);

    if (similarity > FUZZY_THRESHOLD) {
      if (!bestFuzzyMatch || similarity > bestFuzzyMatch.score) {
        bestFuzzyMatch = { segment: seg, score: similarity };
      }
    }
  }

  if (bestFuzzyMatch) {
    return bestFuzzyMatch.segment.timestamp;
  }

  // STRATEGY 4: Distinctive word matching
  const phraseWords = normalizedPhrase
    .split(/\s+/)
    .filter(w => w.length > 2 && !COMMON_WORDS.has(w));

  if (phraseWords.length > 0) {
    let bestMatch: { segment: SegmentEntry; score: number } | null = null;

    for (const seg of segments) {
      const segWords = seg.normalizedText.split(/\s+/);
      let matchCount = 0;

      for (const phraseWord of phraseWords) {
        // Exact match
        if (segWords.includes(phraseWord)) {
          matchCount++;
          continue;
        }
        // Fuzzy word match (75% similarity)
        for (const segWord of segWords) {
          if (stringSimilarity(phraseWord, segWord) > 0.75) {
            matchCount += 0.75;
            break;
          }
        }
      }

      const score = matchCount / phraseWords.length;
      if (score > 0.4 && (!bestMatch || score > bestMatch.score)) {
        bestMatch = { segment: seg, score };
      }
    }

    if (bestMatch) {
      return bestMatch.segment.timestamp;
    }
  }

  // STRATEGY 5: Cross-segment matching (for quotes spanning segments)
  for (let i = 0; i < segments.length - 1; i++) {
    const combinedText = segments[i].normalizedText + ' ' + segments[i + 1].normalizedText;

    // Try exact match on combined
    if (combinedText.includes(searchPhrase)) {
      return segments[i].timestamp;
    }

    // Try fuzzy match on combined
    const compareText = combinedText.substring(0, searchPhrase.length + 20);
    if (stringSimilarity(searchPhrase, compareText) > FUZZY_THRESHOLD) {
      return segments[i].timestamp;
    }
  }

  return null;
}
