// A small terminal input decoder. Bracketed paste delimiters may arrive split
// across data events; never treat an embedded pasted newline as command submit.
export class SecretInput {
  value = '';
  escape = '';
  pasting = false;
  tooLong = false;
  finished = false;

  push(chunk) {
    if (this.finished) return;
    for (const char of chunk) {
      if (char === '\u0003' || char === '\u0004') return this.finish({ cancelled: true });
      if (this.escape) {
        this.escape += char;
        if (this.escape.length === 2 && char !== '[') { this.escape = ''; continue; }
        if (this.escape.length > 2 && /[@-~]/.test(char)) {
          if (this.escape === '\u001b[200~') this.pasting = true;
          if (this.escape === '\u001b[201~') this.pasting = false;
          this.escape = '';
        } else if (this.escape.length > 32) this.escape = '';
        continue;
      }
      if (char === '\u001b') { this.escape = char; continue; }
      if (char === '\r' || char === '\n') {
        if (!this.pasting) return this.finish(this.tooLong ? { error: '入力が長すぎます。発行画面のコピー用ボタンでキーだけをコピーしてください。' } : validateKey(this.value));
      }
      if (!this.pasting && (char === '\u007f' || char === '\b')) this.value = this.value.slice(0, -1);
      else if (this.value.length < 4096) this.value += char;
      else this.tooLong = true;
    }
  }
  finish(result) {
    this.finished = true; this.value = ''; this.escape = '';
    return result;
  }
}

export function validateKey(raw) {
  const value = raw.trim();
  if (/^key_/.test(value)) return { error: 'Tracking IDが入力されたようです。発行直後の画面にある、sk-で始まるキー全文をコピーしてください。' };
  if (value.includes('...') || value.includes('…')) return { error: '省略されたキー表示では接続できません。発行直後の画面のコピー用ボタンを使ってください。' };
  if (!/^sk-[A-Za-z0-9_-]{20,1000}$/.test(value)) return { error: 'キーの形式を確認できませんでした。発行直後の画面で、sk-で始まるキー全文をコピーしてください。入力内容は保存していません。' };
  return { value };
}
