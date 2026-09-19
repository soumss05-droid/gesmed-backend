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
} = require("../controllers/stocks.controller");

const router = express.Router();

router.get("/", authentifier, listerStocks);
router.get("/reseau", authentifier, stockReseau);
router.get("/cmm", authentifier, calculerCmm);
router.get("/commande-suggeree", authentifier, commandeSuggeree);
router.get("/croisement", authentifier, croisementStock);
router.post("/entree", authentifier, autoriser("GESTIONNAIRE_CAMEC", "ADMIN"), entreeStock);
router.post("/dispensation", authentifier, autoriser("FORMATION_SANITAIRE"), enregistrerDispensation);

module.exports = router;