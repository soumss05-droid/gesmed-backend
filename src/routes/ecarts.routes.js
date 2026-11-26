const express = require("express");
const { authentifier } = require("../middleware/auth");
const { autoriser } = require("../middleware/authorize");
const { listerEcartsEnAttente, traiterEcart } = require("../controllers/ecarts.controller");

const router = express.Router();

// Consultation : GAS programme national et AUDITEUR (GAS Cellule)
router.get("/en-attente", authentifier, autoriser("GAS_PROGRAMME_NATIONAL", "AUDITEUR"), listerEcartsEnAttente);

// Decision : reservee au GAS programme national (l'AUDITEUR ne tranche pas)
router.post("/:blLigneId/decision", authentifier, autoriser("GAS_PROGRAMME_NATIONAL"), traiterEcart);

module.exports = router;