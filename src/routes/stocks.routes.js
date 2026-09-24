const express = require("express");
const { authentifier } = require("../middleware/auth");
const { autoriser } = require("../middleware/authorize");
const {
  listerStocks,
  stockReseau,
  entreeStock,
  enregistrerDispensation,
  calculerCmm,
  commandeSuggeree,
  croisementStock,
  performanceMoughataa,
  dmmPropre,
} = require("../controllers/stocks.controller");

const router = express.Router();

router.get("/", authentifier, listerStocks);
router.get("/reseau", authentifier, stockReseau);
router.get("/cmm", authentifier, calculerCmm);
router.get("/dmm-propre", authentifier, dmmPropre);
router.get("/commande-suggeree", authentifier, commandeSuggeree);
router.get("/croisement", authentifier, croisementStock);
router.get("/performance-moughataa", authentifier, performanceMoughataa);
router.post("/entree", authentifier, autoriser("GESTIONNAIRE_CAMEC", "ADMIN"), entreeStock);
router.post("/dispensation", authentifier, autoriser("FORMATION_SANITAIRE"), enregistrerDispensation);

module.exports = router;