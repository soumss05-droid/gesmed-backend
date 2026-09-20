const express = require("express");
const { authentifier } = require("../middleware/auth");
const { autoriser } = require("../middleware/authorize");
const {
  listerDrs,
  creerDrs,
  listerProgrammes,
  listerRoles,
  listerEtablissements,
  creerMoughataa,
  creerEtablissement,
  modifierEtablissement,
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
} = require("../controllers/admin.controller");

const router = express.Router();

// Toutes les routes admin sont réservées au rôle ADMIN.
router.use(authentifier, autoriser("ADMIN"));

router.get("/drs", listerDrs);
router.post("/drs", creerDrs);
router.delete("/drs/:id", supprimerDrs);

router.get("/programmes", listerProgrammes);
router.get("/roles", listerRoles);

router.get("/etablissements", listerEtablissements);
router.post("/etablissements", creerEtablissement);
router.patch("/etablissements/:id", modifierEtablissement);

router.post("/moughataa", creerMoughataa);

router.get("/utilisateurs", listerUtilisateurs);
router.post("/utilisateurs", creerUtilisateur);
router.patch("/utilisateurs/:id", modifierUtilisateur);
router.post("/utilisateurs/:id/rattachements", rattacherUtilisateur);
router.delete("/utilisateurs/:id/rattachements/:rattachementId", retirerRattachement);

router.get("/notifications", listerToutesNotifications);

router.get("/moughataa", listerMoughataa);

router.get("/stocks", listerTousLesLots);

router.post("/recalculer-statuts-stock", recalculerTousLesStatutsStock);

module.exports = router;