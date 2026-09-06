const express = require("express");
const { authentifier } = require("../middleware/auth");
const { autoriser } = require("../middleware/authorize");
const { listerEcartsEnAttente, traiterEcart } = require("../controllers/ecarts.controller");

const router = express.Router();

router.get("/en-attente", authentifier, autoriser("GAS_PROGRAMME_NATIONAL", "AUDITEUR"), listerEcartsEnAttente);
router.post("/:blLigneId/decision", authentifier, autoriser("GAS_PROGRAMME_NATIONAL", "AUDITEUR"), traiterEcart);

module.exports = router;
