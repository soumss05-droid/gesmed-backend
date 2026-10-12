const express = require("express");
const { authentifier } = require("../middleware/auth");
const { autoriser } = require("../middleware/authorize");
const { perimetre, listerComptes, creerCompte, creerFosa } = require("../controllers/equipe.controller");
const { importerFosaDrs } = require("../controllers/equipeImport.controller");

const router = express.Router();

// « Mon équipe » : réservé au gestionnaire (GAS) de DRS, pour sa seule région.
router.use(authentifier, autoriser("GESTIONNAIRE_DRS"));

router.get("/perimetre", perimetre);
router.get("/comptes", listerComptes);
router.post("/comptes", creerCompte);
router.post("/fosa", creerFosa);
router.post("/import-fosa", importerFosaDrs); // import en masse (simulation par défaut)

module.exports = router;