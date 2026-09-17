/** Source-derived text must remain one literal Markdown table cell. Escape
 * HTML first, then Markdown syntax; never add a backslash without escaping
 * pre-existing backslashes. Numeric entities also keep embedded newlines and
 * code fences from creating executable HTML or extra rows in the report.
 */
export function markdownCodeCell(value) {
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '|': '&#124;', '`': '&#96;', '\\': '&#92;', '\r': '&#13;', '\n': '&#10;' };
  return `<code>${Array.from(value, (character) => entities[character] ?? character).join('')}</code>`;
}
