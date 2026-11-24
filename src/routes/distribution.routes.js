const express = require("express");
const { authentifier } = require("../middleware/auth");
const {
  listerPretesAExpedier,
  listerAxes,
  axesMaRegion,
  resumeParAxe,
  associerAxe,
  expedierAxe,
  genererBl,
  listerEnAttenteReception,
  compterEnvoyesEnAttente,
  modifierPlanningAxe,
  confirmerReception,
} = require("../controllers/distribution.controller");

const router = express.Router();

router.get("/pretes", authentifier, listerPretesAExpedier);
router.post("/:requisitionId/generer-bl", authentifier, genererBl);
router.get("/reception/en-attente", authentifier, listerEnAttenteReception);
router.get("/envoyes/en-attente", authentifier, compterEnvoyesEnAttente);
router.post("/reception/:blId/confirmer", authentifier, confirmerReception);

router.get("/axes", authentifier, listerAxes);
router.get("/axes/ma-region", authentifier, axesMaRegion);
router.get("/axes/resume", authentifier, resumeParAxe);
router.post("/axes/:axeId/expedier", authentifier, expedierAxe);
router.put("/axes/:axeId/planning", authentifier, modifierPlanningAxe);
router.post("/:requisitionId/axe", authentifier, associerAxe);

module.exports = router;
