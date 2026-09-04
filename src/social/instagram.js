// Instagram Graph API (via Facebook Login). Two hard constraints, not workarounds:
//  1. Publishing REELS needs `instagram_content_publish`, which requires Meta App Review for
//     any account beyond your own registered testers.
//  2. The publish call takes a `video_url` that Meta's servers fetch FROM THE PUBLIC INTERNET —
//     there is no direct file-upload endpoint. A file sitting on localhost is not reachable by
//     Meta, so this app would need to also host the rendered clip somewhere public (e.g. a
//     tunnel like ngrok, or cloud storage) before this can post anything, even after approval.

function isConfigured() {
  return !!(process.env.INSTAGRAM_APP_ID && process.env.INSTAGRAM_APP_SECRET);
}

function getAuthUrl(state) {
  const redirectUri = `${process.env.APP_BASE_URL || 'http://localhost:3000'}/connect/instagram/callback`;
  const params = new URLSearchParams({
    client_id: process.env.INSTAGRAM_APP_ID,
    redirect_uri: redirectUri,
    scope: 'instagram_content_publish,pages_show_list,pages_read_engagement',
    response_type: 'code',
    state,
  });
  return `https://www.facebook.com/v19.0/dialog/oauth?${params.toString()}`;
}

async function exchangeCode(code) {
  const redirectUri = `${process.env.APP_BASE_URL || 'http://localhost:3000'}/connect/instagram/callback`;
  const params = new URLSearchParams({
    client_id: process.env.INSTAGRAM_APP_ID,
    client_secret: process.env.INSTAGRAM_APP_SECRET,
    redirect_uri: redirectUri,
    code,
  });
  const res = await fetch(`https://graph.facebook.com/v19.0/oauth/access_token?${params.toString()}`);
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error?.message || 'Instagram token exchange failed');

  // Exchange the short-lived token for a long-lived one (~60 days).
  const longRes = await fetch('https://graph.facebook.com/v19.0/oauth/access_token?' + new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: process.env.INSTAGRAM_APP_ID,
    client_secret: process.env.INSTAGRAM_APP_SECRET,
    fb_exchange_token: data.access_token,
  }));
  const longData = await longRes.json();
  return longData.access_token ? longData : data;
}

// Finds the Instagram Business Account ID linked to one of the user's Facebook Pages.
async function findInstagramAccountId(accessToken) {
  const res = await fetch(`https://graph.facebook.com/v19.0/me/accounts?fields=instagram_business_account&access_token=${accessToken}`);
  const data = await res.json();
  const page = (data.data || []).find((p) => p.instagram_business_account);
  if (!page) throw new Error('No Instagram Business account linked to your Facebook Pages');
  return page.instagram_business_account.id;
}

// `videoUrl` MUST be a publicly reachable URL — see the constraint note at the top of this file.
async function uploadVideo({ tokens, videoUrl, caption }) {
  if (!videoUrl) {
    throw new Error(
      'Instagram publishing requires a public video URL (Meta fetches it directly) — ' +
      'a local file path will not work. Host the rendered clip somewhere public first.'
    );
  }
  const igUserId = await findInstagramAccountId(tokens.access_token);

  const createRes = await fetch(`https://graph.facebook.com/v19.0/${igUserId}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      media_type: 'REELS', video_url: videoUrl, caption, access_token: tokens.access_token,
    }),
  });
  const createData = await createRes.json();
  if (!createRes.ok || createData.error) throw new Error(createData.error?.message || 'Instagram container creation failed');

  const publishRes = await fetch(`https://graph.facebook.com/v19.0/${igUserId}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ creation_id: createData.id, access_token: tokens.access_token }),
  });
  const publishData = await publishRes.json();
  if (!publishRes.ok || publishData.error) throw new Error(publishData.error?.message || 'Instagram publish failed');
  return publishData;
}

module.exports = { isConfigured, getAuthUrl, exchangeCode, uploadVideo };
