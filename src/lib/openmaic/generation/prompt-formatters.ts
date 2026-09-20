/**
 * Prompt and context building utilities for the generation pipeline.
 */

import type { PdfImage } from '@openmaic/lib/types/generation';
import type { AgentInfo, SceneGenerationContext } from './pipeline-types';

/** Build a course context string for injection into action prompts */
export function buildCourseContext(ctx?: SceneGenerationContext): string {
  if (!ctx) return '';

  const lines: string[] = [];

  // Course outline with position marker
  lines.push('Course Outline:');
  ctx.allTitles.forEach((t, i) => {
    const marker = i === ctx.pageIndex - 1 ? ' ← current' : '';
    lines.push(`  ${i + 1}. ${t}${marker}`);
  });

  // Position information
  lines.push('');
  lines.push(
    'IMPORTANT: All pages belong to the SAME class session. A new section may receive a brief section opening, but must not restart or re-introduce the whole course. When referencing content from earlier pages, say "we just covered" or "as mentioned on page N" — NEVER say "last class" or "previous session" because there is no previous session.',
  );
  lines.push('');
  if (ctx.narrationMode === 'embedded-segment') {
    lines.push('Position: This classroom is an INSERTED SEGMENT inside an ongoing main lesson, even when this is page 1 of the generated segment.');
    lines.push('Continuity: Start directly with the knowledge or task. Never greet, welcome learners, introduce a new course, or describe this as a separate lesson. Never use “last class/previous lesson” for the immediately preceding main-course page.');
    lines.push('Ending: Do not thank the audience, say goodbye, or formally close a course. End with a concise learning takeaway or a natural bridge such as “Now let us continue with the next part.”');
  } else if (ctx.pageIndex === 1) {
    lines.push(`Position: This is the FIRST${ctx.totalPages === 1 ? ' AND LAST' : ''} page of the standalone AI course resource.`);
    if (ctx.courseTitle) lines.push(`Course title for a natural welcome: ${ctx.courseTitle}`);
    lines.push('Opening: Give a brief natural greeting, then use the planned familiar experience, observable contrast, object, or question as a real knowledge entry. Guide attention to its relevant feature and explicitly bridge into the first idea. The resource must make sense on its own even if a teacher introduced the wider lesson earlier. Do not merely attach a greeting to a definition, recite objectives, or invent learner responses.');
    if (ctx.totalPages === 1) {
      lines.push('Ending: After the page responsibility is complete, synthesize what learners can now explain or do, connect it to later use, and formally thank the class and say goodbye.');
    }
  } else if (ctx.sectionPosition === 'section-first') {
    lines.push('Position: This is the FIRST page of a new section. Briefly open the section and connect it to prior learning; do not restart the whole course.');
  } else if (ctx.pageIndex === ctx.totalPages) {
    lines.push('Position: This is the LAST page. Complete the page responsibility, synthesize what learners can now explain or do without mechanically repeating every point, connect it to a plausible later use, and formally close the course with thanks and a farewell.');
    lines.push(
      'Transition: Continue naturally from the previous page. Do NOT greet or re-introduce.',
    );
  } else {
    lines.push(`Position: Page ${ctx.pageIndex} of ${ctx.totalPages} (middle of the course).`);
    lines.push(
      'Transition: Continue naturally from the previous page. Do NOT greet or re-introduce.',
    );
  }

  // Previous page speech for transition reference
  if (ctx.previousSpeeches.length > 0) {
    lines.push('');
    lines.push('Previous page speech (for transition reference):');
    const lastSpeech = ctx.previousSpeeches[ctx.previousSpeeches.length - 1];
    lines.push(`  "...${lastSpeech.slice(-150)}"`);
  }

  if (ctx.previousPageTitle || ctx.previousPageSummary || ctx.currentTeachingObjective) {
    lines.push('');
    lines.push('Narration continuity context (authoritative):');
    lines.push(`- Section position: ${ctx.sectionPosition || 'continuation'}`);
    lines.push(`- Narration mode: ${ctx.narrationMode || 'standalone-course'}`);
    if (ctx.previousPageTitle) lines.push(`- Previous page topic: ${ctx.previousPageTitle}`);
    if (ctx.previousPageSummary) lines.push(`- Previous page content summary: ${ctx.previousPageSummary}`);
    if (ctx.currentTeachingObjective) lines.push(`- Current page teaching objective: ${ctx.currentTeachingObjective}`);
    if (ctx.sectionPosition === 'section-first') {
      lines.push('- A brief section opening is allowed. Connect it to prior learning and do not greet as if the whole course were starting again.');
    } else if (ctx.sectionPosition === 'continuation') {
      lines.push('- Start by briefly carrying forward the previous idea only when useful, then teach the current objective. Never restart the lesson, greet the class, welcome learners, or repeat the course introduction.');
    }
  }

  return lines.join('\n');
}

/** Format agent list for injection into action prompts */
export function formatAgentsForPrompt(agents?: AgentInfo[]): string {
  if (!agents || agents.length === 0) return '';

  const lines = ['Classroom Agents:'];
  for (const a of agents) {
    const personaPart = a.persona ? ` — ${a.persona}` : '';
    lines.push(`- id: "${a.id}", name: "${a.name}", role: ${a.role}${personaPart}`);
  }
  return lines.join('\n');
}

/** Extract the teacher agent's persona for injection into outline/content prompts */
export function formatTeacherPersonaForPrompt(agents?: AgentInfo[]): string {
  if (!agents || agents.length === 0) return '';

  const teacher = agents.find((a) => a.role === 'teacher');
  if (!teacher?.persona) return '';

  return `Teacher Persona:\nName: ${teacher.name}\n${teacher.persona}\n\nAdapt the content style and tone to match this teacher's personality. IMPORTANT: The teacher's name and identity must NOT appear on the slides — no "Teacher ${teacher.name}'s tips", no "Teacher's message", etc. Slides should read as neutral, professional visual aids.`;
}

/**
 * Format a single PdfImage description for prompt inclusion.
 * Includes dimension/aspect-ratio info when available.
 */
export function formatImageDescription(img: PdfImage): string {
  let dimInfo = '';
  if (img.width && img.height) {
    const ratio = (img.width / img.height).toFixed(2);
    dimInfo = ` | size: ${img.width}×${img.height} (aspect ratio ${ratio})`;
  }
  const desc = img.description ? ` | ${img.description}` : '';
  return `- **${img.id}**: from PDF page ${img.pageNumber}${dimInfo}${desc}`;
}

/**
 * Format a short image placeholder for vision mode.
 * Only ID + page + dimensions + aspect ratio (no description), since the model can see the actual image.
 */
export function formatImagePlaceholder(img: PdfImage): string {
  let dimInfo = '';
  if (img.width && img.height) {
    const ratio = (img.width / img.height).toFixed(2);
    dimInfo = ` | size: ${img.width}×${img.height} (aspect ratio ${ratio})`;
  }
  return `- **${img.id}**: image from PDF page ${img.pageNumber}${dimInfo} [see attached]`;
}

/**
 * Build a multimodal user content array for the AI SDK.
 * Interleaves text and images so the model can associate img_id with actual image.
 * Each image label includes dimensions when available so the model knows the size
 * before seeing the image (important for layout decisions).
 */
export function buildVisionUserContent(
  userPrompt: string,
  images: Array<{ id: string; src: string; width?: number; height?: number }>,
): Array<{ type: 'text'; text: string } | { type: 'image'; image: string; mimeType?: string }> {
  const parts: Array<
    { type: 'text'; text: string } | { type: 'image'; image: string; mimeType?: string }
  > = [{ type: 'text', text: userPrompt }];
  if (images.length > 0) {
    parts.push({ type: 'text', text: '\n\n--- Attached Images ---' });
    for (const img of images) {
      let dimInfo = '';
      if (img.width && img.height) {
        const ratio = (img.width / img.height).toFixed(2);
        dimInfo = ` (${img.width}×${img.height}, aspect ratio ${ratio})`;
      }
      parts.push({ type: 'text', text: `\n**${img.id}**${dimInfo}:` });
      // Strip data URI prefix — AI SDK only accepts http(s) URLs or raw base64
      const dataUriMatch = img.src.match(/^data:([^;]+);base64,(.+)$/);
      if (dataUriMatch) {
        parts.push({
          type: 'image',
          image: dataUriMatch[2],
          mimeType: dataUriMatch[1],
        });
      } else {
        parts.push({ type: 'image', image: img.src });
      }
    }
  }
  return parts;
}

/**
 * Build language instruction text from course-level directive and optional per-scene note.
 * Used by scene content and action generators to inject into prompt templates.
 */
export function buildLanguageText(directive?: string, sceneNote?: string): string {
  if (!directive && !sceneNote) return '';
  let text = directive || '';
  if (sceneNote) {
    text += (text ? '\n\n' : '') + `Additional language note for this scene: ${sceneNote}`;
  }
  return text;
}
