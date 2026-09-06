const express = require("express");
const { authentifier } = require("../middleware/auth");
const {
  listerPretesAExpedier,
  genererBl,
  listerEnAttenteReception,
  confirmerReception,
} = require("../controllers/distribution.controller");

const router = express.Router();

router.get("/pretes", authentifier, listerPretesAExpedier);
router.post("/:requisitionId/generer-bl", authentifier, genererBl);
router.get("/reception/en-attente", authentifier, listerEnAttenteReception);
router.post("/reception/:blId/confirmer", authentifier, confirmerReception);

module.exports = router;
