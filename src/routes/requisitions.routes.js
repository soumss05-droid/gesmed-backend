const express = require("express");
const { authentifier } = require("../middleware/auth");
const {
  creerRequisition,
  listerAValider,
  traiterDecision,
} = require("../controllers/requisitions.controller");

const router = express.Router();

router.post("/", authentifier, creerRequisition);
router.get("/a-valider", authentifier, listerAValider);
router.post("/:id/decision", authentifier, traiterDecision);

module.exports = router;
