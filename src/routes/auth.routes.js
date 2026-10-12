const express = require("express");
const { login } = require("../controllers/auth.controller");
const { changerMotDePasse } = require("../controllers/motDePasse.controller");
const { authentifier } = require("../middleware/auth");

const router = express.Router();

router.post("/login", login);
router.post("/changer-mot-de-passe", authentifier, changerMotDePasse);

module.exports = router;