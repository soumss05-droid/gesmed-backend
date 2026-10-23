const express = require("express");
const { authentifier } = require("../middleware/auth");
const { listerFosas, servicesDeLaFosa, decider } = require("../controllers/validationOffre.controller");

const router = express.Router();

// Validation de l'offre de service par le Medecin chef de la Moughataa.
// Le controle d'acces par role est fait dans le controleur.
router.use(authentifier);

router.get("/fosas", listerFosas);
router.get("/fosas/:etablissementId/services", servicesDeLaFosa);
router.put("/fosas/:etablissementId/services", decider);

module.exports = router;
