const express = require("express");
const { authentifier } = require("../middleware/auth");
const {
  creerRequisition,
  listerAValider,
  listerMesRequisitions,
  traiterDecision,
  creerCommandeReapprovisionnement,
  rechercherParNumero,
} = require("../controllers/requisitions.controller");

const router = express.Router();

router.post("/", authentifier, creerRequisition);
router.post("/reapprovisionnement", authentifier, creerCommandeReapprovisionnement);
router.get("/a-valider", authentifier, listerAValider);
router.get("/mes-requisitions", authentifier, listerMesRequisitions);
router.get("/recherche/:numero", authentifier, rechercherParNumero);
router.post("/:id/decision", authentifier, traiterDecision);

module.exports = router;