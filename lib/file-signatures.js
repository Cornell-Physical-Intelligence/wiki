// Lightweight format checks, not a malware scanner or full media parser.
export function matchesFileType(data, type) {
  const starts = (bytes) => data.length >= bytes.length && data.subarray(0, bytes.length).equals(Buffer.from(bytes));
  if (type === 'image/png') return data.length >= 33 && starts([137,80,78,71,13,10,26,10]) && data.toString('ascii',12,16) === 'IHDR';
  if (type === 'image/jpeg') return data.length >= 4 && starts([255,216,255]) && data[data.length - 2] === 255 && data[data.length - 1] === 217;
  if (type === 'image/gif') return data.length >= 14 && ['GIF87a','GIF89a'].includes(data.toString('ascii',0,6)) && data[data.length - 1] === 59;
  if (type === 'image/webp') return data.length >= 20 && data.toString('ascii',0,4) === 'RIFF' && data.toString('ascii',8,12) === 'WEBP' && data.readUInt32LE(4) + 8 === data.length;
  if (type === 'application/pdf') return /^%PDF-\d\.\d/.test(data.toString('ascii',0,8)) && /%%EOF\s*$/.test(data.subarray(-1024).toString('ascii'));
  return false;
}
