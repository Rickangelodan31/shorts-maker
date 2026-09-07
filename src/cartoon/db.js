const { MongoClient } = require('mongodb');

// Lazy singleton connection, reused across requests — mirrors the rest of this app's
// "connect once, keep using it" style rather than opening a new connection per request.
let clientPromise = null;

function getClient() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is not set — the Cartoon Studio needs a MongoDB connection.');
  }
  if (!clientPromise) {
    const client = new MongoClient(process.env.MONGODB_URI);
    clientPromise = client.connect();
  }
  return clientPromise;
}

// No DB name in most Atlas URIs by convention here — default to a fixed app database name
// so it's explicit and doesn't depend on what happens to be in the URI's path segment.
async function getDb() {
  const client = await getClient();
  return client.db(process.env.MONGODB_DB_NAME || 'shorts_maker');
}

async function getCartoonProjectsCollection() {
  const db = await getDb();
  return db.collection('cartoonProjects');
}

module.exports = { getDb, getCartoonProjectsCollection };
