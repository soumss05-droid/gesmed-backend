const express = require("express");
const router = express.Router();
const { authentifier } = require("../middleware/auth");
const {
  etatMaZone,
  verrouillerMaZone,
  verrouillerEtablissement,
  deverrouillerEtablissement,
  monEtatVerrouillage,
  listerVerrous,
} = require("../controllers/verrouillage.controller");

router.use(authentifier);

router.get("/mon-etat", monEtatVerrouillage);
router.get("/ma-zone", etatMaZone);
router.get("/", listerVerrous);
router.post("/ma-zone", verrouillerMaZone);
router.post("/etablissements/:etablissementId", verrouillerEtablissement);
router.delete("/etablissements/:etablissementId", deverrouillerEtablissement);

module.exports = router;