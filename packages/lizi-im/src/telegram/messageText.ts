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
  function visit(value: unknown, depth = 0, separator = ''): string {
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
    if (item.text !== undefined) return visit(item.text, depth + 1);
    if (item.type === 'mathematical_expression') return visit(item.expression, depth + 1);
    if (item.type === 'custom_emoji') return visit(item.alternative_text, depth + 1);
    // Nested blocks, lists, tables and media captions. Unknown fields are ignored.
    const parts: string[] = [];
    for (const key of ['blocks', 'items', 'rows', 'cells', 'caption', 'credit']) {
      const text = visit(item[key], depth + 1, key === 'cells' ? '\t' : '\n');
      if (text) parts.push(text);
    }
    return parts.join('\n');
  }
  return visit(message.rich_message?.blocks, 0, '\n').slice(0, MAX_TEXT).trim();
}

/** The selected quote is more specific than the full parent. Protection is
 * checked by the caller before projecting either form of the reference. */
export function telegramReplyText(message: {
  reply_to_message?: TelegramTextContent;
  quote?: { text?: unknown };
}): string {
  const quote = message.quote?.text;
  if (typeof quote === 'string' && quote.trim()) return quote.slice(0, MAX_TEXT).trim();
  const reply = message.reply_to_message;
  if (!reply) return '';
  return telegramMessageText(reply);
}
