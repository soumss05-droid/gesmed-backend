const express = require("express");
const { authentifier } = require("../middleware/auth");
const { autoriser } = require("../middleware/authorize");
const {
  listerStocks,
  stockReseau,
  entreeStock,
  enregistrerDispensation,
  rapportDispensations,
  calculerCmm,
  commandeSuggeree,
  croisementStock,
  performanceMoughataa,
  dmmPropre,
  justifierStock,
  justificationsRequises,
  historiqueJustifications,
} = require("../controllers/stocks.controller");

const router = express.Router();

router.get("/", authentifier, listerStocks);
router.get("/reseau", authentifier, stockReseau);
router.get("/carte", authentifier, require("../controllers/carte.controller").carteStocks);
router.get("/cmm", authentifier, calculerCmm);
router.get("/dmm-propre", authentifier, dmmPropre);
router.get("/commande-suggeree", authentifier, commandeSuggeree);
router.get("/croisement", authentifier, croisementStock);
router.get("/performance-moughataa", authentifier, performanceMoughataa);
router.get("/dispensation/rapport", authentifier, autoriser("FORMATION_SANITAIRE"), rapportDispensations);
router.get("/justifications-requises", authentifier, justificationsRequises);
router.get("/justification/:produitId", authentifier, historiqueJustifications);
router.post("/justification", authentifier, justifierStock);
router.post(
  "/entree",
  authentifier,
  autoriser("GESTIONNAIRE_CAMEC", "ADMIN", "GAS_MOUGHATAA", "GESTIONNAIRE_DRS", "FORMATION_SANITAIRE"),
  entreeStock
);
router.post("/dispensation", authentifier, autoriser("FORMATION_SANITAIRE"), enregistrerDispensation);
router.post("/dispensation/panier", authentifier, autoriser("FORMATION_SANITAIRE"), require("../controllers/dispensationPanier.controller").enregistrerDispensationPanier);

// Annulation d'une dispensation : demande par la formation sanitaire, decision par le MCM / SASSM (roles controles dans le controleur).
const annulations = require("../controllers/annulationsDispensation.controller");
router.post("/dispensation/:dispensationId/demande-annulation", authentifier, annulations.demanderAnnulation);
router.get("/dispensation/demandes-annulation", authentifier, annulations.mesDemandesAnnulation);
router.get("/annulations/a-valider", authentifier, annulations.listerAnnulationsAValider);
router.post("/annulations/:demandeId/decider", authentifier, annulations.deciderAnnulation);
router.post("/dispensation/panier/apercu", authentifier, autoriser("FORMATION_SANITAIRE"), require("../controllers/apercuPanier.controller").apercuPanier);

module.exports = router;