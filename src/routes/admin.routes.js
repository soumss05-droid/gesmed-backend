const express = require("express");
const { authentifier } = require("../middleware/auth");
const { autoriser } = require("../middleware/authorize");
const {
  listerDrs,
  creerDrs,
  modifierDrs,
  listerProgrammes,
  listerRoles,
  listerEtablissements,
  creerMoughataa,
  modifierMoughataa,
  supprimerMoughataa,
  creerEtablissement,
  modifierEtablissement,
  supprimerEtablissement,
  creerUtilisateur,
  modifierUtilisateur,
  rattacherUtilisateur,
  retirerRattachement,
  listerUtilisateurs,
  listerToutesNotifications,
  listerMoughataa,
  listerTousLesLots,
  supprimerDrs,
  recalculerTousLesStatutsStock,
  reconcilierStocksAvecLots,
} = require("../controllers/admin.controller");

const router = express.Router();

// Toutes les routes admin sont réservées au rôle ADMIN.
router.use(authentifier, autoriser("ADMIN"));

router.get("/drs", listerDrs);
router.post("/drs", creerDrs);
router.patch("/drs/:id", modifierDrs);
router.delete("/drs/:id", supprimerDrs);

router.get("/programmes", listerProgrammes);
router.get("/roles", listerRoles);

router.get("/etablissements", listerEtablissements);
router.post("/etablissements", creerEtablissement);
router.patch("/etablissements/:id", modifierEtablissement);
router.delete("/etablissements/:id", supprimerEtablissement);

router.get("/moughataa", listerMoughataa);
router.post("/moughataa", creerMoughataa);
router.patch("/moughataa/:id", modifierMoughataa);
router.delete("/moughataa/:id", supprimerMoughataa);

router.get("/utilisateurs", listerUtilisateurs);
router.post("/utilisateurs", creerUtilisateur);
router.patch("/utilisateurs/:id", modifierUtilisateur);
router.post("/utilisateurs/:id/rattachements", rattacherUtilisateur);
router.delete("/utilisateurs/:id/rattachements/:rattachementId", retirerRattachement);

router.get("/notifications", listerToutesNotifications);

router.get("/stocks", listerTousLesLots);

router.post("/recalculer-statuts-stock", recalculerTousLesStatutsStock);
router.post("/reconcilier-stocks-lots", reconcilierStocksAvecLots);

module.exports = router;