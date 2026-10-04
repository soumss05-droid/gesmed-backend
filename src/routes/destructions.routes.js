const express = require("express");
const router = express.Router();
const { authentifier } = require("../middleware/auth");
const {
  demanderDestructionLot,
  demandesDestructionAValider,
  validerDestructionLot,
  historiqueDestructions,
  supprimerHistoriqueDestructions,
} = require("../controllers/destructions.controller");

// Toutes les routes sont montées sous /stocks (voir index.js), au même
// préfixe que stocks.routes.js — Express autorise plusieurs routeurs sur le
// même préfixe sans conflit tant que les chemins ne se chevauchent pas.
router.post("/lots/:lotId/destruction", authentifier, demanderDestructionLot);
router.get("/lots/destructions/a-valider", authentifier, demandesDestructionAValider);
router.post("/lots/destructions/:demandeId/valider", authentifier, validerDestructionLot);
router.get("/lots/destructions/historique", authentifier, historiqueDestructions);
router.delete("/lots/destructions/historique", authentifier, supprimerHistoriqueDestructions);

module.exports = router;