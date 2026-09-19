const express = require("express");
const { authentifier } = require("../middleware/auth");
const { autoriser } = require("../middleware/authorize");
const {
  listerProduits,
  listerProgrammesPourProduit,
  creerProduit,
} = require("../controllers/produits.controller");

const router = express.Router();

router.get("/", authentifier, listerProduits);
router.get("/programmes", authentifier, listerProgrammesPourProduit);
router.post("/", authentifier, autoriser("GESTIONNAIRE_CAMEC", "ADMIN"), creerProduit);

module.exports = router;