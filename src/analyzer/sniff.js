/*
 * Identify a file by its first bytes (never trust the file name alone).
 */
'use strict';

function sniff(buf) {
  if (!buf || buf.length < 8) return null;
  // PDF: "%PDF-" may appear after a little junk at the very start (allowed by spec)
  const head = buf.subarray(0, 1024).toString('latin1');
  if (head.indexOf('%PDF-') !== -1) return 'pdf';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'png';
  if (buf[0] === 0x50 && buf[1] === 0x4b) return 'zip'; // docx/xlsx/pptx are zip files
  if (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) return 'ole'; // old .doc/.xls/.ppt
  return 'unknown';
}

/** Map a file name to the kind its extension claims. */
function kindFromName(name) {
  const ext = String(name || '').toLowerCase().split('.').pop();
  if (ext === 'pdf') return 'pdf';
  if (ext === 'jpg' || ext === 'jpeg') return 'jpg';
  if (ext === 'png') return 'png';
  if (['doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'odt', 'ods', 'odp', 'rtf', 'txt'].includes(ext)) return 'office';
  return 'other';
}

module.exports = { sniff, kindFromName };
