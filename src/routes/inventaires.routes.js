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

// Vue consolidee en lecture seule de toute la zone (region/Moughataa) -
// accessible a tout utilisateur authentifie, la portee reelle est calculee
// automatiquement selon son perimetre (une formation sanitaire ne voit
// qu'elle-meme, ce qui revient au meme que /inventaires).
router.get("/zone", authentifier, listerInventairesZone);

// Consultation : GAS programme national et AUDITEUR (GAS Cellule)
router.get(
  "/ecarts-en-attente",
  authentifier,
  autoriser("GAS_PROGRAMME_NATIONAL", "AUDITEUR"),
  listerEcartsInventaireEnAttente
);

// Decision : reservee au GAS programme national (l'AUDITEUR ne tranche pas)
router.post(
  "/lignes/:ligneId/decision",
  authentifier,
  autoriser("GAS_PROGRAMME_NATIONAL"),
  traiterEcartInventaire
);

module.exports = router;