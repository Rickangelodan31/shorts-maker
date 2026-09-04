const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const USERS_FILE = path.join(__dirname, '..', 'data', 'users.json');

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function findByUsername(username) {
  const users = loadUsers();
  const id = Object.keys(users).find((k) => users[k].username.toLowerCase() === username.toLowerCase());
  return id ? { id, ...users[id] } : null;
}

function isStrongPassword(password) {
  return (
    typeof password === 'string' &&
    password.length >= 8 &&
    /[A-Z]/.test(password) &&
    /[a-z]/.test(password) &&
    /[0-9]/.test(password) &&
    /[^A-Za-z0-9]/.test(password)
  );
}

async function createUser(username, password) {
  if (!username || username.length < 3) throw new Error('Username must be at least 3 characters');
  if (!isStrongPassword(password)) {
    throw new Error('Password must be at least 8 characters and include uppercase, lowercase, a number, and a special character');
  }
  if (findByUsername(username)) throw new Error('That username is already taken');

  const users = loadUsers();
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const passwordHash = await bcrypt.hash(password, 10);
  users[id] = { username, passwordHash, connected: {}, createdAt: new Date().toISOString() };
  saveUsers(users);
  return { id, username };
}

async function verifyUser(username, password) {
  const user = findByUsername(username);
  if (!user) return null;
  const ok = await bcrypt.compare(password, user.passwordHash);
  return ok ? { id: user.id, username: user.username } : null;
}

function getUser(id) {
  const users = loadUsers();
  return users[id] ? { id, ...users[id] } : null;
}

// Merges fields (e.g. connected.youtube = {...tokens}) into a user's stored record.
function updateUser(id, patch) {
  const users = loadUsers();
  if (!users[id]) throw new Error('User not found');
  users[id] = { ...users[id], ...patch };
  saveUsers(users);
  return { id, ...users[id] };
}

function setConnectedAccount(id, platform, data) {
  const users = loadUsers();
  if (!users[id]) throw new Error('User not found');
  users[id].connected = { ...(users[id].connected || {}), [platform]: data };
  saveUsers(users);
}

function removeConnectedAccount(id, platform) {
  const users = loadUsers();
  if (!users[id]) throw new Error('User not found');
  if (users[id].connected) delete users[id].connected[platform];
  saveUsers(users);
}

function requireAuth(req, res, next) {
  if (req.session?.userId) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not signed in' });
  return res.redirect('/login.html');
}

module.exports = {
  createUser, verifyUser, getUser, updateUser,
  setConnectedAccount, removeConnectedAccount, requireAuth,
};
