const express = require("express");
const { authentifier } = require("../middleware/auth");
const {
  configuration,
  creerService,
  creerProgramme,
  modifierService,
  lireEligibilite,
  enregistrerEligibilite,
} = require("../controllers/offreServiceConfig.controller");

const router = express.Router();

// Le contrôle des rôles (ADMIN et GAS_PROGRAMME_NATIONAL) est fait dans le contrôleur.
router.use(authentifier);

router.get("/configuration", configuration);
router.post("/services", creerService);
router.post("/programmes", creerProgramme);
router.put("/services/:serviceId", modifierService);
router.get("/services/:serviceId/eligibilite", lireEligibilite);
router.put("/services/:serviceId/eligibilite", enregistrerEligibilite);

module.exports = router;