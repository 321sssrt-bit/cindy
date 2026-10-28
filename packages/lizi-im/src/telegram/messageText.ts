/** Bot API incoming RichMessage uses blocks, unlike outgoing markdown/html.
 * Keep visible text aligned with telegram-hook-server/telegram/messageText.ts;
 * media-only labels are a personal-bot extension, not attachment delivery.
 * Only visible content is read; media IDs, callback data and metadata stay out.
 */
export interface TelegramTextContent {
  text?: string;
  caption?: string;
  rich_message?: { blocks?: unknown };
}

const MAX_TEXT = 16_384;
const MAX_BLOCKS = 500;
const MAX_COLUMNS = 20;
// Bot API permits 16 semantic nesting levels. JSON arrays/objects add levels
// of their own; budget work independently of the visible output length.
const MAX_DEPTH = 64;
const MAX_NODES = 32_768 * MAX_DEPTH;
const RICH_MEDIA_LABELS = new Map([
  ['document', '文件'],
  ['photo', '图片'],
  ['audio', '音频'],
  ['video', '视频'],
  ['animation', '动画'],
  ['voice_note', '语音消息'],
]);

export function telegramMessageText(message: TelegramTextContent): string {
  if (message.text?.trim()) return message.text;
  if (message.caption?.trim()) return message.caption;
  let remaining = MAX_TEXT;
  let nodes = MAX_NODES;
  function visit(value: unknown, depth = 0, separator = ''): string {
    if (depth > MAX_DEPTH || --nodes < 0 || remaining <= 0) return '';
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') {
      const text = value.slice(0, remaining);
      remaining -= text.length;
      return text;
    }
    if (Array.isArray(value)) {
      const parts: string[] = [];
      const items = separator === '\n' ? value.slice(0, MAX_BLOCKS) : value;
      for (const item of items) {
        if (nodes <= 0 || remaining <= 0) break;
        const text = visit(item, depth + 1);
        if (text) parts.push(text);
      }
      return parts.join(separator);
    }
    if (!value || typeof value !== 'object') return '';
    const item = value as Record<string, unknown>;
    if (item.type === 'url') {
      const label = visit(item.text, depth + 1);
      const url = visit(item.url, depth + 1);
      return url && url !== label ? `${label} (${url})` : label || url;
    }
    if (item.type === 'mathematical_expression') return visit(item.expression, depth + 1);
    if (item.type === 'custom_emoji') return visit(item.alternative_text, depth + 1);
    if (item.type === 'button') return visit(item.button, depth + 1);
    // Tables use HTML-style spans: reserve covered columns/rows, including
    // empty cells, rather than sliding subsequent values into the wrong column.
    if (item.type === 'table') {
      const rows: string[] = [];
      const occupiedUntil: number[] = Array(MAX_COLUMNS).fill(0);
      if (Array.isArray(item.cells)) {
        for (const [rowIndex, row] of item.cells.slice(0, MAX_BLOCKS).entries()) {
          if (nodes <= 0 || remaining <= 0) break;
          if (!Array.isArray(row)) continue;
          const cells: string[] = [];
          for (const cell of row) {
            while (cells.length < MAX_COLUMNS && occupiedUntil[cells.length] > rowIndex) {
              cells.push('');
            }
            if (cells.length >= MAX_COLUMNS || nodes <= 0 || remaining <= 0) break;
            const column = cells.length;
            const span = (key: 'colspan' | 'rowspan', limit: number): number => {
              const value = cell && typeof cell === 'object' ? cell[key] : undefined;
              return Number.isInteger(value) && value > 1 ? Math.min(value, limit) : 1;
            };
            const columns = span('colspan', MAX_COLUMNS - column);
            const until = rowIndex + span('rowspan', MAX_BLOCKS - rowIndex);
            cells.push(visit(cell, depth + 3), ...Array(columns - 1).fill(''));
            occupiedUntil.fill(until, column, column + columns);
          }
          for (let column = cells.length; column < MAX_COLUMNS; column++) {
            if (occupiedUntil[column] > rowIndex) {
              while (cells.length <= column) cells.push('');
            }
          }
          rows.push(cells.join('\t'));
        }
      }
      return [rows.join('\n'), visit(item.caption, depth + 1)].filter(Boolean).join('\n');
    }
    if (typeof item.label === 'string' && Array.isArray(item.blocks)) {
      const checkbox = item.has_checkbox === true ? (item.is_checked === true ? '[x]' : '[ ]') : '';
      return [visit(item.label, depth + 1), checkbox, visit(item.blocks, depth + 1, '\n')]
        .filter(Boolean)
        .join(' ');
    }
    // RichText stays inline; block collections, captions and credits retain
    // their boundaries. Do not return early on text: captions/quotes have credit.
    const parts: string[] = [];
    for (const key of ['text', 'summary', 'blocks', 'items', 'caption', 'credit', 'buttons']) {
      // Missing optional fields do not consume the traversal budget.
      if (item[key] === undefined || item[key] === null) continue;
      const separator = key === 'blocks' || key === 'items' || key === 'buttons' ? '\n' : '';
      const text = visit(item[key], depth + 1, separator);
      if (text) parts.push(text);
    }
    const text = parts.join('\n');
    if (text.trim()) return text;
    const label = typeof item.type === 'string' ? RICH_MEDIA_LABELS.get(item.type) : undefined;
    if (label) {
      // Only the visible filename is allowed out of the media object. Never
      // recurse into it: file IDs, thumbnails, MIME and other metadata stay out.
      const media = item[item.type as string];
      const name =
        media && typeof media === 'object' && 'file_name' in media ? media.file_name : undefined;
      return visit(
        `[${label}${typeof name === 'string' && name.trim() ? `: ${name}` : ''}]`,
        depth + 1,
      );
    }
    return text;
  }
  const text = visit(message.rich_message?.blocks, 0, '\n').slice(0, MAX_TEXT);
  return text.trim() ? text : '';
}

/** The selected quote is more specific than the full parent. Protection is
 * checked by the caller before projecting either form of the reference. */
export function telegramReplyText(message: {
  reply_to_message?: TelegramTextContent;
  quote?: { text?: unknown };
}): string {
  const quote = message.quote?.text;
  if (typeof quote === 'string' && quote.trim()) return quote.slice(0, MAX_TEXT);
  const reply = message.reply_to_message;
  if (!reply) return '';
  return telegramMessageText(reply);
}
