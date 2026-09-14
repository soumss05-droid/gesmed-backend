const express = require("express");
const { authentifier } = require("../middleware/auth");
const {
  creerRequisition,
  listerAValider,
  traiterDecision,
  creerCommandeReapprovisionnement,
} = require("../controllers/requisitions.controller");

const router = express.Router();

router.post("/", authentifier, creerRequisition);
router.post("/reapprovisionnement", authentifier, creerCommandeReapprovisionnement);
router.get("/a-valider", authentifier, listerAValider);
router.post("/:id/decision", authentifier, traiterDecision);

module.exports = router;