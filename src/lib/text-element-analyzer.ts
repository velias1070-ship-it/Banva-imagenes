// ─────────────────────────────────────────────────────────────────────────────
// Text Element Analyzer — Detect and classify text elements in hero images
// ─────────────────────────────────────────────────────────────────────────────
// Uses Gemini Flash (text-only analysis) to identify all visible text in a
// hero image and classify each element by role, position, and size.
// ─────────────────────────────────────────────────────────────────────────────

import { analyzeImages } from '@/lib/gemini/client';

export type TextRole = 'title' | 'subtitle' | 'body' | 'feature' | 'label' | 'icon_label';
export type TextPosition = 'top' | 'center' | 'bottom';
export type TextSize = 'large' | 'medium' | 'small';

export interface TextElement {
  text: string;
  role: TextRole;
  position: TextPosition;
  size: TextSize;
}

export interface TextElementAnalysis {
  elements: TextElement[];
}

/**
 * Bounding box in pixel coordinates (image space).
 */
export interface TextBbox {
  text: string;
  // Pixel coords (top-left origin)
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Detect bounding boxes of all text in an image using Gemini Flash.
 * Returns pixel-space coordinates (converted from Gemini's 0-1000 normalized space).
 *
 * Used to determine if text overlaps a specific region (e.g. brand logo zone)
 * without false positives from product/scene edges.
 */
export async function detectTextBboxes(
  imageBase64: string,
  imageMimeType: string,
  imgWidth: number,
  imgHeight: number,
): Promise<TextBbox[] | null> {
  try {
    const result = await analyzeImages({
      images: [{ base64: imageBase64, mimeType: imageMimeType }],
      promptText: `For each text element visible in the image (titles, subtitles, captions, labels, watermarks, anything readable as text), return its bounding box.

Use Gemini's standard normalized coordinate space: numbers from 0 to 1000, in [ymin, xmin, ymax, xmax] order, where 0 is the top/left edge and 1000 is the bottom/right edge.

Group all letters that visually belong to the same text element (same line of a title, same paragraph) into one box. Two stacked words of the same title go in ONE box.

If there is NO text visible, respond with: { "boxes": [] }

Respond with ONLY a valid JSON object, no markdown:
{
  "boxes": [
    { "text": "<text content>", "box": [ymin, xmin, ymax, xmax] }
  ]
}`,
      temperature: 0,
    });

    if (!result.success || !result.textResponse) return null;

    let jsonStr = result.textResponse.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    // Try strict JSON parse first. If it fails (Gemini Flash sometimes returns
    // malformed JSON with stray characters or hallucinated cyrillic letters
    // mid-string), fall back to a regex extraction of individual entries.
    let entries: Array<{ text: string; box: number[] }> = [];
    try {
      const parsed = JSON.parse(jsonStr);
      if (parsed.boxes && Array.isArray(parsed.boxes)) {
        entries = parsed.boxes;
      }
    } catch {
      // Regex fallback: extract {"text": "...", "box": [y,x,y,x]} fragments.
      // Even if the surrounding JSON is broken, we can recover individual bboxes.
      const re = /"text"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"\s*,\s*"box"\s*:\s*\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(jsonStr)) !== null) {
        entries.push({
          text: m[1].replace(/\\(.)/g, '$1'),
          box: [Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])],
        });
      }
      if (entries.length > 0) {
        console.log(`[bbox-detector] Recovered ${entries.length} bboxes via regex fallback (JSON was malformed)`);
      } else {
        console.log('[bbox-detector] JSON parse failed and regex fallback found nothing');
        return null;
      }
    }

    const bboxes: TextBbox[] = [];
    for (const item of entries) {
      if (!Array.isArray(item.box) || item.box.length !== 4) continue;
      const [ymin, xmin, ymax, xmax] = item.box.map(Number);
      if ([ymin, xmin, ymax, xmax].some((n) => Number.isNaN(n))) continue;
      // Convert from 0-1000 normalized to pixel coords
      const x = Math.round((xmin / 1000) * imgWidth);
      const y = Math.round((ymin / 1000) * imgHeight);
      const width = Math.round(((xmax - xmin) / 1000) * imgWidth);
      const height = Math.round(((ymax - ymin) / 1000) * imgHeight);
      if (width <= 0 || height <= 0) continue;
      bboxes.push({ text: String(item.text || ''), x, y, width, height });
    }

    console.log(`[bbox-detector] Found ${bboxes.length} text bboxes`);
    return bboxes;
  } catch (err) {
    console.log('[bbox-detector] Error:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Analyze a hero image to detect and classify all visible text elements.
 * Uses Gemini Flash for fast, cheap analysis (~2s, ~$0.001).
 *
 * @returns Array of detected text elements or null if none found / analysis fails
 */
export async function analyzeTextElements(
  heroBase64: string,
  heroMimeType: string = 'image/png'
): Promise<TextElementAnalysis | null> {
  try {
    const result = await analyzeImages({
      images: [{ base64: heroBase64, mimeType: heroMimeType }],
      promptText: `You are analyzing a product image for an e-commerce photography pipeline.

Your job: Identify ALL visible text elements in the image and classify each one.

For EACH text element found, determine:

1. "text": The exact text content as it appears in the image.
2. "role": What role this text plays in the composition:
   - "title" — Main headline, largest/most prominent text
   - "subtitle" — Secondary headline, supports the title
   - "body" — Descriptive paragraph or longer text
   - "feature" — Product feature callout (e.g. "100% algodón", "Hipoalergénico")
   - "label" — Small label or tag text (e.g. brand name, size indicator)
   - "icon_label" — Text paired with an icon or symbol
3. "position": Vertical zone where the text appears:
   - "top" — Upper third of the image
   - "center" — Middle third of the image
   - "bottom" — Lower third of the image
4. "size": Relative size of the text:
   - "large" — Dominant, headline-sized text
   - "medium" — Mid-sized, clearly readable
   - "small" — Small, secondary text

If NO text is visible in the image, respond with: { "elements": [] }

Respond with ONLY a valid JSON object (no markdown, no backticks, no extra text):
{
  "elements": [
    { "text": "<exact text>", "role": "<role>", "position": "<position>", "size": "<size>" }
  ]
}`,
      temperature: 0.1,
    });

    if (!result.success || !result.textResponse) {
      console.log('[text-analyzer] Analysis failed:', result.error);
      return null;
    }

    // Parse JSON response (handle potential markdown wrapping)
    let jsonStr = result.textResponse.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    const parsed = JSON.parse(jsonStr);

    if (!parsed.elements || !Array.isArray(parsed.elements)) {
      console.log('[text-analyzer] Invalid response — missing elements array');
      return null;
    }

    // Return null if no text detected
    if (parsed.elements.length === 0) {
      console.log('[text-analyzer] No text elements detected in image');
      return null;
    }

    // Validate and normalize each element
    const validRoles: TextRole[] = ['title', 'subtitle', 'body', 'feature', 'label', 'icon_label'];
    const validPositions: TextPosition[] = ['top', 'center', 'bottom'];
    const validSizes: TextSize[] = ['large', 'medium', 'small'];

    const elements: TextElement[] = parsed.elements
      .filter((el: Record<string, unknown>) => el.text && typeof el.text === 'string')
      .map((el: Record<string, unknown>) => ({
        text: el.text as string,
        role: validRoles.includes(el.role as TextRole) ? (el.role as TextRole) : 'label',
        position: validPositions.includes(el.position as TextPosition) ? (el.position as TextPosition) : 'center',
        size: validSizes.includes(el.size as TextSize) ? (el.size as TextSize) : 'medium',
      }));

    if (elements.length === 0) {
      console.log('[text-analyzer] No valid text elements after filtering');
      return null;
    }

    console.log(`[text-analyzer] Detected ${elements.length} text element(s)`);

    return { elements };
  } catch (err) {
    console.log('[text-analyzer] Error:', err instanceof Error ? err.message : err);
    return null;
  }
}
