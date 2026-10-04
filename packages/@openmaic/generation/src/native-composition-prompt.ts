/** Retain enabled native element/media syntax while removing the legacy page
 * recipes which compete with a host's model-authored native composition. The
 * compatibility path still receives its original prompts byte for byte. */
export function nativeCompositionPrompt(system: string, user: string): { system: string; user: string } {
  return {
    system: system
      .replace(/## Slide Content Philosophy[\s\S]*?(?=## Canvas Specifications)/u, '')
      .replace(/## Text Height Lookup Table[\s\S]*?(?=## Output Format)/u, '')
      .replace('**Must use value from Height Lookup Table**', 'Authored allocation; actual playback text is measured')
      .replace('- For multiple lines, use separate `<p>` tags (one per line)',
        '- Use separate `<p>` tags for distinct semantic paragraphs; automatic line wrapping does not require one paragraph per visible line'),
    user: user.replace(/^5\. All TextElement `height` values[^\n]*\n/mu, '')
      .replace(/^7\. Present the selected core meaning[^\n]*$/mu,
        '7. Render accurate selected core meanings, explanations, necessary conditions and relationships in readable native regions. A concise label alone cannot satisfy a definition or explanation duty. Preserve source ownership and required evidence; independent spoken expansion remains in narration.'),
  };
}
