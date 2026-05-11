const CODE_BLOCK = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
const INLINE_CODE = /`([^`\n]+)`/g;
const BOLD = /\*\*([^*\n]+)\*\*/g;
const STRIKE = /~~([^~\n]+)~~/g;
const LINK = /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const HEADER = /^(#{1,6})\s+(.+?)\s*$/gm;
const UNORDERED = /^(\s*)[*+-]\s+/gm;
const ORDERED = /^(\s*)(\d+)\.\s+/gm;
const HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm;
const TABLE_BLOCK = /(?:^\|[^\n]*\|\s*$\n?){2,}/gm;
const TABLE_SEP_ROW = /^\|[\s:|-]+\|$/;

const parseTableRow = (line) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());

const renderTableAsCode = (block) => {
  const rows = block
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !TABLE_SEP_ROW.test(l))
    .map(parseTableRow);
  if (rows.length === 0) return block;

  const cols = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, i) =>
    Math.max(...rows.map((r) => (r[i] ?? '').length)),
  );
  const fmt = (row) =>
    row
      .map((c, i) => (c ?? '').padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();

  const lines = [fmt(rows[0])];
  if (rows.length > 1) lines.push('-'.repeat(lines[0].length));
  for (let i = 1; i < rows.length; i += 1) lines.push(fmt(rows[i]));

  return lines.join('\n');
};

export const toSlackMrkdwn = (md = '') => {
  if (!md) return '';

  const codeBlocks = [];
  const stashCode = (body) => {
    codeBlocks.push(body.replace(/\n+$/, ''));
    return ` CB${codeBlocks.length - 1} `;
  };

  let s = md.replace(CODE_BLOCK, (_, _lang, body) => stashCode(body));
  s = s.replace(TABLE_BLOCK, (block) => `${stashCode(renderTableAsCode(block))}\n`);

  const inlineCodes = [];
  s = s.replace(INLINE_CODE, (_, body) => {
    inlineCodes.push(body);
    return ` IC${inlineCodes.length - 1} `;
  });

  s = s.replace(BOLD, '*$1*');
  s = s.replace(STRIKE, '~$1~');
  s = s.replace(LINK, '<$2|$1>');
  s = s.replace(HEADER, (_, _hashes, text) => `*${text}*`);
  s = s.replace(UNORDERED, '$1• ');
  s = s.replace(ORDERED, '$1$2. ');
  s = s.replace(HR, '────────');

  s = s.replace(/ IC(\d+) /g, (_, i) => `\`${inlineCodes[Number(i)]}\``);
  s = s.replace(/ CB(\d+) /g, (_, i) => `\`\`\`\n${codeBlocks[Number(i)]}\n\`\`\``);

  return s;
};
