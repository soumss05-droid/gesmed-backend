const bcrypt = require("bcryptjs");

const SALT_ROUNDS = 10;

async function hashPassword(motDePasse) {
  return bcrypt.hash(motDePasse, SALT_ROUNDS);
}

async function comparePassword(motDePasse, hash) {
  return bcrypt.compare(motDePasse, hash);
}

module.exports = { hashPassword, comparePassword };
