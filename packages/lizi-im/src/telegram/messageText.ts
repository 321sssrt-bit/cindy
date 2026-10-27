/** Bot API incoming RichMessage uses blocks, unlike outgoing markdown/html.
 * Keep this projection aligned with telegram-hook-server/telegram/messageText.ts.
 * Only visible content is read; media IDs, callback data and metadata stay out.
 */
export interface TelegramTextContent {
  text?: string;
  caption?: string;
  rich_message?: { blocks?: unknown };
}

const MAX_TEXT = 16_384;

export function telegramMessageText(message: TelegramTextContent): string {
  if (message.text?.trim()) return message.text;
  if (message.caption?.trim()) return message.caption;
  let remaining = MAX_TEXT;
  let nodes = 2048;
  function visit(value: unknown, depth = 0, separator = '', childSeparator = ''): string {
    // Missing optional fields are not nodes in the incoming document.
    if (value === undefined || value === null) return '';
    if (depth > 20 || --nodes < 0 || remaining <= 0) return '';
    if (typeof value === 'string') {
      const text = value.slice(0, remaining);
      remaining -= text.length;
      return text;
    }
    if (Array.isArray(value)) {
      const parts: string[] = [];
      for (const item of value) {
        if (nodes <= 0 || remaining <= 0) break;
        const text = visit(item, depth + 1, childSeparator);
        // Empty cells still occupy a column in a table row.
        if (text || separator === '\t') parts.push(text);
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
    // https://core.telegram.org/bots/api#richblocktable: cells is a row matrix.
    if (item.type === 'table') {
      return [visit(item.cells, depth + 1, '\n', '\t'), visit(item.caption, depth + 1)]
        .filter(Boolean)
        .join('\n');
    }
    if (typeof item.label === 'string' && Array.isArray(item.blocks)) {
      return [visit(item.label, depth + 1), visit(item.blocks, depth + 1, '\n')]
        .filter(Boolean)
        .join(' ');
    }
    // RichText stays inline; block collections, captions and credits retain
    // their boundaries. Do not return early on text: captions/quotes have credit.
    const parts: string[] = [];
    for (const key of ['text', 'summary', 'blocks', 'items', 'caption', 'credit', 'buttons']) {
      const separator = key === 'blocks' || key === 'items' || key === 'buttons' ? '\n' : '';
      const text = visit(item[key], depth + 1, separator);
      if (text) parts.push(text);
    }
    return parts.join('\n');
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
