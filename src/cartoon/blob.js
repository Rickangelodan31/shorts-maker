const { put, del } = require('@vercel/blob');

function isConfigured() {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

async function uploadAsset({ projectId, kind, entityId, buffer, contentType, ext }) {
  if (!isConfigured()) throw new Error('Vercel Blob is not configured (BLOB_READ_WRITE_TOKEN missing).');
  const pathname = `cartoon/${projectId}/${kind}/${entityId}-${Date.now()}.${ext}`;
  const result = await put(pathname, buffer, { access: 'public', contentType, addRandomSuffix: false });
  return result.url;
}

// Uploads image bytes (a Buffer) for a project's character/location reference image.
// Returns the public URL — that's the only thing stored on the character/location record,
// never the bytes themselves, matching how output/uploaded video files are handled elsewhere
// in this app (real files, referenced by URL, not embedded).
async function uploadReferenceImage({ projectId, kind, entityId, buffer, contentType = 'image/png' }) {
  const ext = contentType === 'image/jpeg' ? 'jpg' : 'png';
  return uploadAsset({ projectId, kind, entityId, buffer, contentType, ext });
}

// Same idea, for Veo-generated scene/episode clips.
async function uploadVideo({ projectId, kind, entityId, buffer, contentType = 'video/mp4' }) {
  return uploadAsset({ projectId, kind, entityId, buffer, contentType, ext: 'mp4' });
}

async function deleteReferenceImage(url) {
  if (!isConfigured() || !url) return;
  try {
    await del(url);
  } catch (err) {
    console.warn('[cartoon/blob] failed to delete old reference image:', err.message);
  }
}

module.exports = { isConfigured, uploadReferenceImage, uploadVideo, deleteReferenceImage };
