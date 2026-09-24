const express = require("express");
const { authentifier } = require("../middleware/auth");
const { autoriser } = require("../middleware/authorize");
const {
  creerInventaire,
  listerInventaires,
  listerEcartsInventaireEnAttente,
  traiterEcartInventaire,
  listerInventairesZone,
} = require("../controllers/inventaires.controller");

const router = express.Router();

router.post("/", authentifier, creerInventaire);
router.get("/", authentifier, listerInventaires);

// Vue consolidée en lecture seule de toute la zone (région/Moughataa) —
// accessible à tout utilisateur authentifié, la portée réelle est calculée
// automatiquement selon son périmètre (une formation sanitaire ne voit
// qu'elle-même, ce qui revient au même que /inventaires).
router.get("/zone", authentifier, listerInventairesZone);

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