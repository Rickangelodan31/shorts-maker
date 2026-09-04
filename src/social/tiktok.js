const fs = require('fs');

// TikTok's Content Posting API. IMPORTANT: until TikTok approves your app for the
// `video.publish` scope, this can only post to the developer accounts registered as testers
// on your TikTok app — it will not work for arbitrary users' accounts. Approval is TikTok's
// process, not something this code can shortcut.

function isConfigured() {
  return !!(process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET);
}

function getAuthUrl(state) {
  const redirectUri = `${process.env.APP_BASE_URL || 'http://localhost:3000'}/connect/tiktok/callback`;
  const params = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY,
    scope: 'user.info.basic,video.publish',
    response_type: 'code',
    redirect_uri: redirectUri,
    state,
  });
  return `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`;
}

async function exchangeCode(code) {
  const redirectUri = `${process.env.APP_BASE_URL || 'http://localhost:3000'}/connect/tiktok/callback`;
  const res = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: process.env.TIKTOK_CLIENT_KEY,
      client_secret: process.env.TIKTOK_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error_description || data.error || 'TikTok token exchange failed');
  return data; // { access_token, refresh_token, open_id, ... }
}

// Direct file upload (no public URL needed): init -> PUT bytes to the returned upload_url.
async function uploadVideo({ tokens, filePath, title }) {
  const stat = fs.statSync(filePath);
  const initRes = await fetch('https://open.tiktokapis.com/v2/post/publish/video/init/', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      post_info: { title, privacy_level: 'SELF_ONLY', disable_duet: false, disable_comment: false, disable_stitch: false },
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: stat.size,
        chunk_size: stat.size,
        total_chunk_count: 1,
      },
    }),
  });
  const initData = await initRes.json();
  if (!initRes.ok || initData.error?.code !== 'ok') {
    throw new Error(initData.error?.message || 'TikTok publish init failed (likely needs app approval for video.publish)');
  }

  const uploadUrl = initData.data.upload_url;
  const buffer = fs.readFileSync(filePath);
  const putRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Range': `bytes 0-${stat.size - 1}/${stat.size}`,
    },
    body: buffer,
  });
  if (!putRes.ok) throw new Error(`TikTok upload failed: ${putRes.status}`);

  return { publishId: initData.data.publish_id };
}

module.exports = { isConfigured, getAuthUrl, exchangeCode, uploadVideo };
