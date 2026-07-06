export function normalizeUnicode(str) {
    return str
        .toLowerCase()
        .trim()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ');
}
const HTML_ENTITIES = {
    '&nbsp;': ' ',
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
};
export function stripHtml(html) {
    if (!html)
        return '';
    return html
        .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\s*\/?>/gi, '\n')
        .replace(/<li[^>]*>/gi, '- ')
        .replace(/<[^>]+>/g, '')
        .replace(/&[a-z#0-9]+;/gi, (m) => HTML_ENTITIES[m.toLowerCase()] ?? m)
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .split('\n')
        .map((line) => line.trim())
        .join('\n')
        .trim();
}
export function sanitizeFilename(name) {
    const cleaned = (name || '')
        .trim()
        .replace(/[\\/:*?"<>|]/g, '')
        .replace(/\s+/g, '_');
    return cleaned || 'export';
}
export function buildContentDisposition(filenameBase, ext) {
    const asciiFallback = filenameBase.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7E]/g, '_');
    const encoded = encodeURIComponent(`${filenameBase}.${ext}`);
    return `attachment; filename="${asciiFallback}.${ext}"; filename*=UTF-8''${encoded}`;
}
export function generateAccessCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}
