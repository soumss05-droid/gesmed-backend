const express = require("express");
const { authentifier } = require("../middleware/auth");
const { couverture } = require("../controllers/couverture.controller");

const router = express.Router();

// Indicateurs de couverture de l'offre de service (lecture seule).
// Le controle d'acces par role est fait dans le controleur.
router.use(authentifier);

router.get("/", couverture);

module.exports = router;
