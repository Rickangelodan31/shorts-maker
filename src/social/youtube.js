const fs = require('fs');
const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/youtube.upload'];

function isConfigured() {
  return !!(process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET);
}

function oauthClient() {
  const redirectUri = `${process.env.APP_BASE_URL || 'http://localhost:3000'}/connect/youtube/callback`;
  return new google.auth.OAuth2(process.env.YOUTUBE_CLIENT_ID, process.env.YOUTUBE_CLIENT_SECRET, redirectUri);
}

function getAuthUrl(state) {
  return oauthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state,
  });
}

async function exchangeCode(code) {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  return tokens; // { access_token, refresh_token, expiry_date, ... }
}

// Uploads a local video file as a YouTube Short. privacyStatus: 'private' | 'unlisted' | 'public'.
async function uploadVideo({ tokens, filePath, title, description, privacyStatus = 'private' }) {
  const client = oauthClient();
  client.setCredentials(tokens);
  const youtube = google.youtube({ version: 'v3', auth: client });

  const res = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: { title, description, categoryId: '22' },
      status: { privacyStatus, selfDeclaredMadeForKids: false },
    },
    media: { body: fs.createReadStream(filePath) },
  });
  return res.data; // includes id -> https://youtube.com/watch?v=<id> (Shorts if <=60s vertical)
}

module.exports = { isConfigured, getAuthUrl, exchangeCode, uploadVideo };
