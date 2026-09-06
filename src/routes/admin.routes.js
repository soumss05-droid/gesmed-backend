const express = require("express");
const { authentifier } = require("../middleware/auth");
const { autoriser } = require("../middleware/authorize");
const {
  listerDrs,
  listerEtablissements,
  creerMoughataa,
  creerEtablissement,
  creerUtilisateur,
  rattacherUtilisateur,
  listerUtilisateurs,
} = require("../controllers/admin.controller");

const router = express.Router();

// Toutes les routes admin sont réservées au rôle ADMIN.
router.use(authentifier, autoriser("ADMIN"));

router.get("/drs", listerDrs);
router.get("/etablissements", listerEtablissements);
router.post("/moughataa", creerMoughataa);
router.post("/etablissements", creerEtablissement);
router.get("/utilisateurs", listerUtilisateurs);
router.post("/utilisateurs", creerUtilisateur);
router.post("/utilisateurs/:id/rattachements", rattacherUtilisateur);

module.exports = router;
