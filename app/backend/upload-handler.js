const http = require('http');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { randomBytes } = require('crypto');

const writeFile = promisify(fs.writeFile);
const unlink = promisify(fs.unlink);

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const MAX_FIELD_SIZE = 1024 * 1024; // 1MB for fields
const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB for files

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

/**
 * Parse multipart/form-data request with streaming support
 */
async function parseMultipart(req, opts = {}) {
  return new Promise((resolve, reject) => {
    const boundary = getBoundary(req.headers['content-type']);
    if (!boundary) {
      return reject(new Error('Invalid content-type'));
    }

    const boundaryBuffer = Buffer.from(`--${boundary}`);
    const endBoundary = Buffer.from(`--${boundary}--`);
    const crlfBuffer = Buffer.from('\r\n');
    const headerEndBuffer = Buffer.from('\r\n\r\n');

    let buffer = Buffer.alloc(0);
    let state = 'BOUNDARY'; // BOUNDARY, HEADERS, CONTENT
    let currentPart = null;
    let currentHeaders = null;
    let fileStream = null;
    let fileSize = 0;
    let currentFilePath = null;
    let finished = false;
    const pendingFileWrites = [];

    const parts = {};
    const files = {};
    const fields = {};
    let totalReceived = 0;
    let lastLogTime = Date.now();
    const maxTotalBytes = Number(opts.maxTotalBytes || 0) || null;

    function waitForStreamEnd(stream, finalChunk) {
      return new Promise((resolveWrite, rejectWrite) => {
        stream.once('finish', resolveWrite);
        stream.once('error', rejectWrite);
        if (finalChunk && finalChunk.length) stream.end(finalChunk);
        else stream.end();
      });
    }

    function fail(err) {
      if (typeof err === 'string') {
        err = new Error(err);
      }
      if (err && typeof err === 'object') {
        try { err.bytesReceived = totalReceived; } catch (_) {}
      }
      if (finished) return;
      finished = true;
      try { if (fileStream) fileStream.destroy(); } catch (_) {}
      try { if (currentFilePath && fs.existsSync(currentFilePath)) fs.unlinkSync(currentFilePath); } catch (_) {}
      reject(err);
    }

    function succeed(payload) {
      if (finished) return;
      finished = true;
      const closeOpen = fileStream ? waitForStreamEnd(fileStream) : Promise.resolve();
      fileStream = null;
      Promise.all([...pendingFileWrites, closeOpen])
        .then(() => resolve(payload))
        .catch(reject);
    }

    req.on('data', (chunk) => {
      totalReceived += chunk.length;
      buffer = Buffer.concat([buffer, chunk]);

      if (maxTotalBytes && totalReceived > maxTotalBytes) {
        return fail(new Error('PAYLOAD_TOO_LARGE'));
      }

      // Log progress every 5 seconds
      const now = Date.now();
      if (now - lastLogTime > 5000) {
        console.log(`[Upload] Received ${(totalReceived / 1024 / 1024).toFixed(2)} MB`);
        lastLogTime = now;
      }

      try {
        processBuffer();
      } catch (e) {
        fail(e);
      }
    });

    req.on('end', () => {
      succeed({ parts, files, fields });
    });

    req.on('error', (err) => {
      fail(err);
    });

    // Client aborted the request (e.g., navigation away or connection reset)
    req.on('aborted', () => {
      const e = new Error('CLIENT_ABORTED');
      e.code = 'CLIENT_ABORTED';
      fail(e);
    });

    // In some Node versions 'close' fires on abrupt termination
    req.on('close', () => {
      if (!finished) {
        const e = new Error('CLIENT_ABORTED');
        e.code = 'CLIENT_ABORTED';
        fail(e);
      }
    });

    function processBuffer() {
      let continueProcessing = true;

      while (continueProcessing && buffer.length > 0) {
        if (state === 'BOUNDARY') {
          const boundaryIndex = buffer.indexOf(boundaryBuffer);
          if (boundaryIndex === -1) {
            continueProcessing = false;
            break;
          }

          // Check if end boundary
          if (buffer.indexOf(endBoundary) === boundaryIndex) {
            buffer = Buffer.alloc(0);
            continueProcessing = false;
            break;
          }

          // Move past boundary and CRLF
          buffer = buffer.slice(boundaryIndex + boundaryBuffer.length);
          if (buffer.length >= 2 && buffer.slice(0, 2).equals(crlfBuffer)) {
            buffer = buffer.slice(2);
          }
          state = 'HEADERS';

        } else if (state === 'HEADERS') {
          const headerEndIndex = buffer.indexOf(headerEndBuffer);
          if (headerEndIndex === -1) {
            continueProcessing = false;
            break;
          }

          const headersText = buffer.slice(0, headerEndIndex).toString();
          currentHeaders = parseHeaders(headersText);
          buffer = buffer.slice(headerEndIndex + 4);
          state = 'CONTENT';

          // If it's a file, prepare stream
          if (currentHeaders.filename) {
            const filename = `${Date.now()}-${randomBytes(8).toString('hex')}${path.extname(currentHeaders.filename)}`;
            const filepath = path.join(UPLOAD_DIR, filename);
            fileStream = fs.createWriteStream(filepath);
            fileSize = 0;
            currentPart = {
              name: currentHeaders.name,
              filename: currentHeaders.filename,
              filepath: filepath,
              mimetype: currentHeaders.contentType || 'application/octet-stream'
            };
            currentFilePath = filepath;
          } else {
            currentPart = {
              name: currentHeaders.name,
              data: Buffer.alloc(0)
            };
          }

        } else if (state === 'CONTENT') {
          const nextBoundaryIndex = buffer.indexOf(boundaryBuffer);

          if (nextBoundaryIndex === -1) {
            // No boundary found yet, write most of buffer but keep some for boundary detection
            if (currentHeaders.filename && fileStream) {
              // For files, write to stream
              const keepSize = boundaryBuffer.length + 10;
              if (buffer.length > keepSize) {
                const writeSize = buffer.length - keepSize;
                const writeBuffer = buffer.slice(0, writeSize);
                fileSize += writeSize;

                if (fileSize > MAX_FILE_SIZE) {
                  try { fileStream.destroy(); } catch (_) {}
                  try { if (currentFilePath && fs.existsSync(currentFilePath)) fs.unlinkSync(currentFilePath); } catch (_) {}
                  return fail(new Error('FILE_TOO_LARGE'));
                }

                const canWrite = fileStream.write(writeBuffer);
                if (!canWrite && typeof req.pause === 'function') {
                  try { req.pause(); } catch (_) {}
                  fileStream.once('drain', () => {
                    try { req.resume(); } catch (_) {}
                  });
                }
                buffer = buffer.slice(writeSize);
              }
            } else {
              // For fields, accumulate in memory
              if (buffer.length > MAX_FIELD_SIZE) {
                return reject(new Error('Field too large'));
              }
            }
            continueProcessing = false;

          } else {
            // Found boundary, finish current part
            let contentEnd = nextBoundaryIndex;
            // Remove trailing CRLF
            if (contentEnd >= 2 && buffer.slice(contentEnd - 2, contentEnd).equals(crlfBuffer)) {
              contentEnd -= 2;
            }

            const contentBuffer = buffer.slice(0, contentEnd);

            if (currentHeaders.filename && fileStream) {
              // Write final chunk and close stream — wait for flush before callers copy the file.
              fileSize += contentBuffer.length;
              const stream = fileStream;
              const fileRecord = {
                originalname: currentPart.filename,
                filename: path.basename(currentPart.filepath),
                path: currentPart.filepath,
                size: fileSize,
                mimetype: currentPart.mimetype
              };
              if (files[currentPart.name]) {
                const prev = files[currentPart.name];
                files[currentPart.name] = Array.isArray(prev) ? prev : [prev];
                files[currentPart.name].push(fileRecord);
              } else {
                files[currentPart.name] = fileRecord;
              }
              pendingFileWrites.push(waitForStreamEnd(stream, contentBuffer));
              fileStream = null;
              currentFilePath = null;
            } else {
              // Store field
              currentPart.data = Buffer.concat([currentPart.data, contentBuffer]);
              fields[currentPart.name] = currentPart.data.toString();
            }

            buffer = buffer.slice(nextBoundaryIndex);
            state = 'BOUNDARY';
            currentPart = null;
            currentHeaders = null;
          }
        }
      }
    }
  });
}

/**
 * Extract boundary from content-type header
 */
function getBoundary(contentType) {
  if (!contentType) return null;
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/);
  return match ? (match[1] || match[2]) : null;
}

/**
 * Parse multipart headers
 */
function parseHeaders(headersText) {
  const headers = {};
  const lines = headersText.split('\r\n');

  for (const line of lines) {
    if (line.toLowerCase().startsWith('content-disposition:')) {
      const nameMatch = line.match(/name="([^"]+)"/);
      const filenameMatch = line.match(/filename="([^"]+)"/);
      if (nameMatch) headers.name = nameMatch[1];
      if (filenameMatch) headers.filename = filenameMatch[1];
    } else if (line.toLowerCase().startsWith('content-type:')) {
      headers.contentType = line.split(':')[1].trim();
    }
  }

  return headers;
}

/**
 * Handle file upload
 */
async function handleFileUpload(req, opts = {}) {
  const { parts, files, fields } = await parseMultipart(req, opts);
  return { files, fields };
}

/**
 * Clean up uploaded file
 */
async function cleanupFile(filepath) {
  try {
    await unlink(filepath);
  } catch (err) {
    console.error('Failed to cleanup file:', filepath, err);
  }
}

module.exports = {
  handleFileUpload,
  cleanupFile,
  UPLOAD_DIR
};
