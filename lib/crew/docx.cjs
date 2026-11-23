// The text of a Word document (.docx), as Markdown, so agents can read rules and briefs people
// upload as Word files. A .docx is a zip holding word/document.xml; headings, lists, tables, tabs
// and line breaks are kept, while pictures, formatting and comments are not.

'use strict';

const { readZip } = require('./zip.cjs');

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** XML text with its entities turned back into characters. */
function unescapeXml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
    const code = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    try { return String.fromCodePoint(code); } catch { return m; }
  });
}

/** The words of one paragraph: its runs' text, tabs and breaks. */
function paragraphText(xml) {
  let out = '';
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:(?:br|cr)(?:\s[^>]*)?\/>|<w:noBreakHyphen\/>/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[1] !== undefined) out += unescapeXml(m[1]);
    else if (m[0].startsWith('<w:tab')) out += '\t';
    else if (m[0].startsWith('<w:noBreakHyphen')) out += '-';
    else out += '\n';
  }
  return out;
}

// Word names its heading styles in the document's language: Heading1, Ttulo1 (Título), Titre1…
const HEADING = /^(?:heading|ttulo|titulo|título|titre|berschrift|überschrift|kop|rubrik)\s*([1-6])$/i;
const TITLE = /^(?:title|ttulo|titulo|título|titre)$/i;

/** One paragraph as Markdown: a heading, a list item or plain text, or null when it is empty. */
function paragraph(xml) {
  const text = paragraphText(xml).trim();
  if (!text) return null;
  const style = (/<w:pStyle\s+w:val="([^"]+)"/.exec(xml) || [])[1] || '';
  if (TITLE.test(style)) return { text: `# ${text}` };
  const heading = HEADING.exec(style);
  if (heading) return { text: `${'#'.repeat(Number(heading[1]))} ${text}` };
  if (/<w:numPr>/.test(xml) || /^List/i.test(style)) {
    const level = Number((/<w:ilvl\s+w:val="(\d+)"/.exec(xml) || [])[1] || 0);
    return { text: `${'  '.repeat(Math.min(level, 8))}- ${text}`, item: true };
  }
  return { text };
}

/** A table as Markdown rows; a cell's paragraphs are joined with spaces. */
function table(xml) {
  const rows = [];
  for (const row of xml.match(/<w:tr[\s>][\s\S]*?<\/w:tr>/g) || []) {
    const cells = (row.match(/<w:tc[\s>][\s\S]*?<\/w:tc>/g) || []).map((c) =>
      (c.match(/<w:p[\s>][\s\S]*?<\/w:p>/g) || []).map((p) => paragraphText(p).trim()).filter(Boolean)
        .join(' ').replace(/\s+/g, ' ').replace(/\|/g, '\\|'));
    rows.push(`| ${cells.join(' | ')} |`);
    if (rows.length === 1) rows.push(`|${cells.map(() => ' --- |').join('')}`);
  }
  return rows.join('\n');
}

/**
 * The text of a .docx, as Markdown.
 *
 * @param {Buffer} buf
 * @returns {string}
 */
function docxToMarkdown(buf) {
  const { files } = readZip(buf);
  const doc = files.find((f) => f.name === 'word/document.xml');
  if (!doc) throw new Error('This is not a Word document (.docx): it has no word/document.xml.');
  const body = doc.data.toString('utf8');
  let out = '';
  let lastItem = false;
  // A table is taken whole where it starts, so its paragraphs are not read a second time.
  const re = /<w:tbl>[\s\S]*?<\/w:tbl>|<w:p[\s>][\s\S]*?<\/w:p>/g;
  let m;
  while ((m = re.exec(body))) {
    const block = m[0].startsWith('<w:tbl>') ? { text: table(m[0]) } : paragraph(m[0]);
    if (!block || !block.text) continue;
    // List items sit on consecutive lines; everything else is a paragraph of its own.
    out += out ? (block.item && lastItem ? '\n' : '\n\n') : '';
    out += block.text;
    lastItem = !!block.item;
  }
  return `${out}\n`;
}

module.exports = { docxToMarkdown };
