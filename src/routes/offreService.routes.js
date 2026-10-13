const express = require("express");
const { authentifier } = require("../middleware/auth");
const { autoriser } = require("../middleware/authorize");
const { mesServices, enregistrerMesServices } = require("../controllers/offreService.controller");

const router = express.Router();

// « Mes services » : réservé au compte de la formation sanitaire, pour son seul établissement.
router.use(authentifier, autoriser("FORMATION_SANITAIRE"));

router.get("/mes-services", mesServices);
router.put("/mes-services", enregistrerMesServices);

module.exports = router;