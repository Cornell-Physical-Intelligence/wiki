// Lightweight format checks, not a malware scanner or full media parser.
// A file must begin as the format it claims; what follows is not checked,
// because real files carry extra bytes after their end marker (phone cameras
// append data to JPEGs, some PDF writers pad after %%EOF).
export function detectFileType(data) {
  const starts = (bytes) => data.length >= bytes.length && data.subarray(0, bytes.length).equals(Buffer.from(bytes));
  if (data.length >= 33 && starts([137,80,78,71,13,10,26,10]) && data.toString('ascii',12,16) === 'IHDR') return 'image/png';
  if (data.length >= 4 && starts([255,216,255])) return 'image/jpeg';
  if (data.length >= 14 && ['GIF87a','GIF89a'].includes(data.toString('ascii',0,6))) return 'image/gif';
  if (data.length >= 20 && data.toString('ascii',0,4) === 'RIFF' && data.toString('ascii',8,12) === 'WEBP' && data.readUInt32LE(4) + 8 <= data.length) return 'image/webp';
  // Readers accept a PDF header anywhere in the first kilobyte.
  if (/%PDF-\d\.\d/.test(data.subarray(0, 1024).toString('latin1'))) return 'application/pdf';
  return null;
}
export function matchesFileType(data, type) {
  return detectFileType(data) === type;
}
