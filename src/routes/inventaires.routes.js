const express = require("express");
const { authentifier } = require("../middleware/auth");
const { autoriser } = require("../middleware/authorize");
const {
  creerInventaire,
  listerInventaires,
  listerEcartsInventaireEnAttente,
  traiterEcartInventaire,
} = require("../controllers/inventaires.controller");

const router = express.Router();

router.post("/", authentifier, creerInventaire);
router.get("/", authentifier, listerInventaires);

router.get(
  "/ecarts-en-attente",
  authentifier,
  autoriser("GAS_PROGRAMME_NATIONAL", "AUDITEUR"),
  listerEcartsInventaireEnAttente
);
router.post(
  "/lignes/:ligneId/decision",
  authentifier,
  autoriser("GAS_PROGRAMME_NATIONAL", "AUDITEUR"),
  traiterEcartInventaire
);

module.exports = router;