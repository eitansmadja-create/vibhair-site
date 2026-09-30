// Vercel serverless entry point. Vercel treats any file under /api as a
// function: it imports this module and calls the default export as a plain
// (req, res) handler on every request. An Express app already has exactly
// that shape, so we just reuse the real server unchanged.
module.exports = require('../server/server.js');
