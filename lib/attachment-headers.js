// Response headers for member-uploaded attachments. The stored type is what
// the uploader claimed, so it is never allowed to make the browser run script
// on the wiki origin: known media renders inline, everything else downloads,
// and every response is nosniff. SVG renders inline (pages embed it) but under
// a CSP sandbox, so opening it directly gives it an opaque origin with no
// access to the wiki's cookies or DOM. PDFs skip the sandbox so the built-in
// viewer still works.
const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/svg+xml',
  'application/pdf', 'video/mp4', 'video/webm', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg', 'text/plain']);

export function attachmentHeaders(file) {
  const type = String(file.type || '').toLowerCase().split(';')[0].trim();
  const name = encodeURIComponent(String(file.name || 'file'));
  const inline = INLINE.has(type);
  const headers = {
    'content-type': inline ? type : 'application/octet-stream',
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${name}"; filename*=UTF-8''${name}`,
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, max-age=31536000, immutable',
  };
  if (type !== 'application/pdf') headers['content-security-policy'] = 'sandbox';
  return headers;
}
